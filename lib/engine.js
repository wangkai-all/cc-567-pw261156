'use strict';

// 拆账引擎：按变更时刻把账期切成账段，逐段用"当时生效倍率"把表盘差折成电量；
// 另含朴素（整月表盘差 × 月底倍率）错误算法，用于分摊对照。

const {
  PRICE_PER_KWH, EPS, METER_KIND, SettlementError,
  round2, round6, assert, effectiveMultiplier, multiplierOnInterval,
} = require('./domain');

function ts(iso) {
  return Date.parse(iso);
}

function readingsBetween(meter, startMs, endMs) {
  return meter.readings
    .filter((r) => {
      const t = ts(r.timestamp);
      return t >= startMs && t <= endMs;
    })
    .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
}

function activeWindow(meter, periodStartMs, periodEndMs) {
  const installed = ts(meter.installedAt);
  const start = Math.max(periodStartMs, installed);
  let end = periodEndMs;
  const replacement = (meter.events || []).find((e) => e.type === 'meter-replacement');
  if (replacement) end = Math.min(periodEndMs, ts(replacement.changeAt));
  return { start, end };
}

/** 单表账段：相邻读数配对，逐段校验倍率恒定、表盘不倒走；表在该账期不活跃时返回空数组 */
function buildMeterSegments(meter, periodStartMs, periodEndMs, counters = null) {
  const { start, end } = activeWindow(meter, periodStartMs, periodEndMs);
  if (end <= start) return [];
  const rs = readingsBetween(meter, start, end);
  assert(rs.length >= 2, 'READING_MISSING_AT_PERIOD_BOUNDARY',
    `表 ${meter.id} 在账期边界缺读数（窗口 ${new Date(start).toISOString()} ~ ${new Date(end).toISOString()}）`);
  assert(ts(rs[0].timestamp) === start, 'READING_MISSING_AT_PERIOD_BOUNDARY',
    `表 ${meter.id} 缺少窗口起点 ${new Date(start).toISOString()} 的读数`);
  assert(ts(rs[rs.length - 1].timestamp) === end, 'READING_MISSING_AT_PERIOD_BOUNDARY',
    `表 ${meter.id} 缺少窗口终点 ${new Date(end).toISOString()} 的读数`);

  const segments = [];
  for (let i = 1; i < rs.length; i++) {
    const r1 = rs[i - 1];
    const r2 = rs[i];
    // 账段内部保留浮点原值，只在展示层取位，避免多段累计的取整误差破坏对账
    const dialDelta = r2.dial - r1.dial;
    assert(dialDelta >= -EPS, 'METER_REVERSED',
      `表 ${meter.id} 在 ${r1.timestamp} ~ ${r2.timestamp} 表盘倒走（差值 ${dialDelta}），读数异常`);
    const multiplier = multiplierOnInterval(meter, r1.timestamp, r2.timestamp);
    const kwh = dialDelta * multiplier;
    if (counters) {
      counters.readingPairs += 1;
      counters.multiplierResolutions += 2;
    }
    segments.push({
      meterId: meter.id,
      startIso: r1.timestamp,
      endIso: r2.timestamp,
      startDial: r1.dial,
      endDial: r2.dial,
      dialDelta,
      multiplier,
      kwh,
    });
  }
  return segments;
}

/** 总表换装校验：旧表末读数与新表首读数必须在换装时刻相接 */
function validateReplacement(meters) {
  const byId = new Map(meters.map((m) => [m.id, m]));
  for (const meter of meters) {
    const rep = (meter.events || []).find((e) => e.type === 'meter-replacement');
    if (!rep) continue;
    const successor = byId.get(rep.successor);
    assert(Boolean(successor), 'SUCCESSOR_NOT_FOUND',
      `表 ${meter.id} 的换装后继表 ${rep.successor} 不存在`);
    assert(successor.installedAt === rep.changeAt, 'REPLACEMENT_HANDOFF_GAP',
      `新表 ${successor.id} 安装时刻 ${successor.installedAt} 与换装时刻 ${rep.changeAt} 不一致`);
    const oldLast = meter.readings[meter.readings.length - 1];
    const newFirst = successor.readings[0];
    assert(oldLast && oldLast.timestamp === rep.changeAt, 'REPLACEMENT_HANDOFF_GAP',
      `旧表 ${meter.id} 缺少换装时刻 ${rep.changeAt} 的末次读数`);
    assert(newFirst && newFirst.timestamp === rep.changeAt, 'REPLACEMENT_HANDOFF_GAP',
      `新表 ${successor.id} 缺少换装时刻 ${rep.changeAt} 的首次读数`);
    assert(Math.abs(newFirst.dial - rep.successorInitialDial) < EPS, 'REPLACEMENT_INITIAL_DIAL_MISMATCH',
      `新表 ${successor.id} 起度 ${newFirst.dial} 与换装记录起度 ${rep.successorInitialDial} 不符`);
  }
}

function masterMetersOf(data) {
  return data.meters.filter((m) => m.kind === 'master');
}

function subMetersOf(data) {
  return data.meters.filter((m) => m.kind !== 'master');
}

/** 损失电量按居民电量比例分摊（最大余数法，保证分摊之和与损失严格相等） */
function allocateLoss(residentLines, lossKwh) {
  const total = residentLines.reduce((s, l) => s + l.ownKwh, 0);
  if (residentLines.length === 0 || total <= EPS) {
    for (const l of residentLines) l.lossKwh = 0;
    return;
  }
  const raw = residentLines.map((l) => (l.ownKwh / total) * lossKwh);
  const floored = raw.map((x) => Math.floor(x * 1e9) / 1e9);
  let remainder = lossKwh - floored.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, idx) => ({ idx, frac: x - Math.floor(x * 1e9) / 1e9 }))
    .sort((a, b) => b.frac - a.frac);
  const step = 1e-9;
  for (const o of order) {
    if (remainder <= 1e-12) break;
    floored[o.idx] += step;
    remainder -= step;
  }
  residentLines.forEach((l, i) => {
    l.lossKwh = floored[i];
  });
}

function makeLines(data, ownKwhById, lossKwh, price) {
  const residentLines = [];
  let publicLine = null;
  for (const meter of subMetersOf(data)) {
    const ownKwh = ownKwhById[meter.id] || 0;
    const line = {
      meterId: meter.id, name: meter.name, kind: meter.kind,
      ownKwh, lossKwh: 0, totalKwh: ownKwh,
      unitPrice: price, amountRaw: ownKwh * price, amount: round2(ownKwh * price),
    };
    if (meter.kind === METER_KIND.RESIDENT) residentLines.push(line);
    else publicLine = line;
  }
  allocateLoss(residentLines, lossKwh);
  for (const l of residentLines) {
    l.totalKwh = l.ownKwh + l.lossKwh;
    l.amountRaw = l.totalKwh * l.unitPrice;
    l.amount = round2(l.amountRaw);
  }
  if (publicLine) {
    publicLine.amountRaw = publicLine.totalKwh * publicLine.unitPrice;
    publicLine.amount = round2(publicLine.amountRaw);
  }
  return { residentLines, publicLine };
}

/**
 * 正确算法：分段读数重算
 * @param counters 可选统计对象 {readingPairs, multiplierResolutions, boundaryChecks, ...}
 */
function buildLedger(data, period, counters = null) {
  validateReplacement(data.meters);
  const pStart = ts(period.startIso);
  const pEnd = ts(period.endIso);
  const price = data.pricePerKwh || PRICE_PER_KWH;

  const masterSegments = [];
  for (const m of masterMetersOf(data)) {
    masterSegments.push(...buildMeterSegments(m, pStart, pEnd, counters));
  }
  masterSegments.sort((a, b) => ts(a.startIso) - ts(b.startIso) || a.meterId.localeCompare(b.meterId));

  const masterBoundarySet = new Set();
  for (const s of masterSegments) {
    masterBoundarySet.add(s.startIso);
    masterBoundarySet.add(s.endIso);
  }

  // 分表账段，并要求分表读数覆盖总表全部账段边界（换装/变更时刻必须有点）
  const subSegments = {};
  const ownKwhById = {};
  for (const m of subMetersOf(data)) {
    const segs = buildMeterSegments(m, pStart, pEnd, counters);
    const subSet = new Set(segs.flatMap((s) => [s.startIso, s.endIso]));
    for (const boundary of masterBoundarySet) {
      if (counters) counters.boundaryChecks += 1;
      assert(subSet.has(boundary), 'READING_MISSING_AT_BOUNDARY',
        `分表 ${m.id} 缺少变更时刻 ${boundary} 的读数，无法与总表账段对齐`);
    }
    subSegments[m.id] = segs;
    ownKwhById[m.id] = segs.reduce((s, x) => s + x.kwh, 0);
  }

  const masterKwh = masterSegments.reduce((s, x) => s + x.kwh, 0);
  const residentKwh = subMetersOf(data)
    .filter((m) => m.kind === METER_KIND.RESIDENT)
    .reduce((s, m) => s + ownKwhById[m.id], 0);
  const publicKwh = subMetersOf(data)
    .filter((m) => m.kind === METER_KIND.PUBLIC)
    .reduce((s, m) => s + ownKwhById[m.id], 0);
  const lossKwh = masterKwh - residentKwh - publicKwh;
  assert(lossKwh >= -1e-6, 'LOSS_NEGATIVE',
    `总表电量 ${masterKwh} 小于分表合计 ${residentKwh + publicKwh}，线损为负，读数异常`);

  const { residentLines, publicLine } = makeLines(data, ownKwhById, Math.max(0, lossKwh), price);
  const lines = [...residentLines];
  if (publicLine) lines.push(publicLine);

  const residentAmount = round2(residentLines.reduce((s, l) => s + l.amount, 0));
  const publicAmount = publicLine ? publicLine.amount : 0;
  return {
    method: 'segmented-readings',
    periodId: period.id,
    periodLabel: period.label,
    startIso: period.startIso,
    endIso: period.endIso,
    pricePerKwh: price,
    totals: {
      masterKwh, residentKwh, publicKwh, lossKwh,
      residentAmount, publicAmount, totalAmount: round2(residentAmount + publicAmount),
    },
    lines,
    masterSegments,
    subSegments,
  };
}

/**
 * 错误对照算法：整月表盘差 × 月底倍率（题目禁止的做法）。
 * 换装只做表盘差拼接，完全忽略旧表 10/12 倍历史与新表 15 倍的分段差异。
 */
function buildNaiveLedger(data, period) {
  const pStart = ts(period.startIso);
  const pEnd = ts(period.endIso);
  const price = data.pricePerKwh || PRICE_PER_KWH;

  let stitchedDialDelta = 0;
  const lastMaster = masterMetersOf(data)
    .map((m) => ({ m, win: activeWindow(m, pStart, pEnd) }))
    .filter((x) => x.win.end > x.win.start)
    .sort((a, b) => a.win.end - b.win.end);
  for (const { m, win } of lastMaster) {
    const rs = readingsBetween(m, win.start, win.end);
    stitchedDialDelta += rs[rs.length - 1].dial - rs[0].dial;
  }
  const endMultiplier = effectiveMultiplier(lastMaster[lastMaster.length - 1].m, period.endIso).value;
  const masterKwh = stitchedDialDelta * endMultiplier;

  const correctLedger = buildLedger(data, period);
  const ownKwhById = {};
  for (const m of subMetersOf(data)) ownKwhById[m.id] = correctLedger.lines.find((l) => l.meterId === m.id)?.ownKwh || 0;
  const residentKwh = correctLedger.totals.residentKwh;
  const publicKwh = correctLedger.totals.publicKwh;
  const lossKwh = masterKwh - residentKwh - publicKwh;

  const { residentLines, publicLine } = makeLines(data, ownKwhById, Math.max(0, lossKwh), price);
  const lines = [...residentLines];
  if (publicLine) lines.push(publicLine);

  // 逐段诊断：错误算法把每段表盘差都套了月底倍率
  const segmentDiagnostics = correctLedger.masterSegments.map((seg) => ({
    meterId: seg.meterId,
    startIso: seg.startIso,
    endIso: seg.endIso,
    dialDelta: seg.dialDelta,
    correctMultiplier: seg.multiplier,
    naiveMultiplier: endMultiplier,
    correctKwh: seg.kwh,
    naiveKwh: round6(seg.dialDelta * endMultiplier),
    deltaKwh: round6(seg.dialDelta * endMultiplier - seg.kwh),
  }));

  const residentAmount = round2(residentLines.reduce((s, l) => s + l.amount, 0));
  const publicAmount = publicLine ? publicLine.amount : 0;
  return {
    method: 'naive-eom-multiplier',
    periodId: period.id,
    periodLabel: period.label,
    startIso: period.startIso,
    endIso: period.endIso,
    pricePerKwh: price,
    assumedEndMultiplier: endMultiplier,
    stitchedDialDelta: round6(stitchedDialDelta),
    totals: {
      masterKwh, residentKwh, publicKwh, lossKwh,
      residentAmount, publicAmount, totalAmount: round2(residentAmount + publicAmount),
    },
    lines,
    segmentDiagnostics,
  };
}

/** 相接性核对：账段首尾相接、同一小时内两段不重不漏，并与合成真值对账 */
function adjacencyCheck(ledger, data) {
  const segs = ledger.masterSegments;
  const joins = [];
  let ordered = true;
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    const touch = a.endIso === b.startIso;
    if (!touch) ordered = false;
    // 同一整小时被接点切成两段（10:00~10:30 + 10:30~11:00 共同覆盖 10 点这一小时）：
    // 接点不是整点（位于某小时内部），且 a 的起点是该小时的整点、b 的终点是下一个整点
    const joinHourStart = a.endIso.slice(0, 13) + ':00:00.000Z';
    const joinHourEnd = new Date(Date.parse(joinHourStart) + 3600000).toISOString();
    const sameHour = touch &&
      a.startIso === joinHourStart &&
      b.endIso === joinHourEnd &&
      a.endIso !== joinHourStart &&
      a.endIso !== joinHourEnd;
    joins.push({
      joinAtIso: a.endIso,
      sameClockHour: sameHour,
      fromMeter: a.meterId,
      toMeter: b.meterId,
      touch,
      fromSegment: { startIso: a.startIso, endIso: a.endIso, multiplier: a.multiplier, kwh: a.kwh },
      toSegment: { startIso: b.startIso, endIso: b.endIso, multiplier: b.multiplier, kwh: b.kwh },
    });
  }
  const coversPeriod = segs.length > 0 &&
    segs[0].startIso === ledger.startIso &&
    segs[segs.length - 1].endIso === ledger.endIso;

  const truthIndex = new Map();
  for (const g of data.groundTruth || []) truthIndex.set(g.startIso + '|' + g.endIso, g);

  // 同一小时两段：用 groundTruth（独立真值，不来自表盘）核对合并电量
  const sameHourJoins = joins.filter((j) => j.sameClockHour).map((j) => {
    const g1 = truthIndex.get(j.fromSegment.startIso + '|' + j.joinAtIso);
    const g2 = truthIndex.get(j.joinAtIso + '|' + j.toSegment.endIso);
    const truth = round6((g1 ? g1.masterKwh : 0) + (g2 ? g2.masterKwh : 0));
    const combined = round6(j.fromSegment.kwh + j.toSegment.kwh);
    const hourStartIso = j.fromSegment.startIso.slice(0, 13) + ':00:00.000Z';
    return {
      hourStartIso,
      joinAtIso: j.joinAtIso,
      fromMeter: j.fromMeter,
      toMeter: j.toMeter,
      firstHalfKwh: j.fromSegment.kwh,
      secondHalfKwh: j.toSegment.kwh,
      combinedKwh: combined,
      groundTruthHourKwh: truth,
      diffKwh: round6(combined - truth),
      noDoubleCount: Math.abs(combined - truth) < 1e-4,
    };
  });

  return {
    ordered,
    coversPeriod,
    noOverlapNoGap: ordered && coversPeriod,
    joins,
    sameHourJoins,
  };
}

/** 望远镜对账：整期所有账段电量之和必须等于独立真值的逐区间之和 */
function telescopingCheck(ledger, data) {
  const pStart = ts(ledger.startIso);
  const pEnd = ts(ledger.endIso);
  const truth = (data.groundTruth || []).filter((g) => ts(g.startIso) >= pStart && ts(g.endIso) <= pEnd);
  const sum = (key) => truth.reduce((s, g) => s + g[key], 0);
  const expected = {
    masterKwh: sum('masterKwh'),
    residentKwh: sum('residentKwh'),
    publicKwh: sum('publicKwh'),
    lossKwh: sum('lossKwh'),
  };
  const actual = {
    masterKwh: ledger.totals.masterKwh,
    residentKwh: ledger.totals.residentKwh,
    publicKwh: ledger.totals.publicKwh,
    lossKwh: ledger.totals.lossKwh,
  };
  const TOL = 1e-6; // 合成真值按 1e-6 取位，引擎内部保留浮点原值，容差覆盖取位差
  const diffs = Object.fromEntries(Object.keys(expected).map((k) => [k, actual[k] - expected[k]]));
  return {
    expected: Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, round6(v)])),
    actual: Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, round6(v)])),
    diffs: Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, round6(v)])),
    matched: Object.values(diffs).every((d) => Math.abs(d) < TOL),
    truthIntervals: truth.length,
  };
}

module.exports = {
  buildMeterSegments,
  validateReplacement,
  buildLedger,
  buildNaiveLedger,
  adjacencyCheck,
  telescopingCheck,
  activeWindow,
  readingsBetween,
};
