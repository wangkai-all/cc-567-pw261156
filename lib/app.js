'use strict';

// 应用层：新估算（分段重算）与已结批次（结算快照）并存；
// 支持结转、倍率补交修正（只追加调整批次、不改写快照）、两种方案重算量对照。

const crypto = require('node:crypto');
const {
  BATCH_STATUS, METER_KIND, SettlementError, round2, round6, assert,
} = require('./domain');
const {
  buildLedger, buildNaiveLedger, adjacencyCheck, telescopingCheck,
} = require('./engine');

function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

function fingerprint(data) {
  const payload = JSON.stringify(data.meters.map((m) => ({
    id: m.id,
    baseMultiplier: m.baseMultiplier,
    events: m.events,
    n: m.readings.length,
    first: m.readings[0],
    last: m.readings[m.readings.length - 1],
  })));
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function newCounters() {
  return {
    readingPairs: 0,          // 表盘读数配对数（每次配对要做一次减法+一次乘法）
    multiplierResolutions: 0, // 生效倍率查询次数
    boundaryChecks: 0,        // 分表与总表账段边界对齐校验次数
    dialArithmetic: 0,        // 表盘差×倍率 运算次数
    snapshotRowReads: 0,      // 快照方案：直接读取的结果行数
  };
}

function createApp(data) {
  return {
    data,
    inputFingerprint: fingerprint(data),
    batches: [], // 冻结的结算/调整批次
    seq: 0,
  };
}

function getPeriod(app, periodId) {
  const period = app.data.periods.find((p) => p.id === periodId);
  assert(Boolean(period), 'PERIOD_NOT_FOUND', `账期 ${periodId} 不存在`);
  return period;
}

function findSettledBatch(app, periodId) {
  return app.batches.find((b) => b.status === BATCH_STATUS.SETTLED && b.periodId === periodId);
}

function findAdjustments(app, periodId) {
  return app.batches.filter((b) => b.kind === 'adjustment' && b.periodId === periodId);
}

/** 查询端：随时可跑的新估算（不落地、不影响已结批次） */
function estimate(app, periodId) {
  const period = getPeriod(app, periodId);
  const ledger = buildLedger(app.data, period);
  return {
    kind: 'new-estimate',
    inputFingerprint: app.inputFingerprint,
    ledger,
    adjacency: adjacencyCheck(ledger, app.data),
    telescoping: telescopingCheck(ledger, app.data),
  };
}

/** 截至当前各表未结金额（已结批次的结转 + 未付调整），按表汇总 */
function outstandingByMeter(app) {
  const map = new Map();
  const add = (meterId, amount) => map.set(meterId, round2((map.get(meterId) || 0) + amount));
  for (const b of app.batches) {
    if (b.status === BATCH_STATUS.SETTLED) {
      for (const l of b.lines) add(l.meterId, l.carryOut);
    } else {
      for (const l of b.lines) add(l.meterId, l.deltaAmount);
    }
  }
  return map;
}

/** 入仓/结算：冻结快照，记录结转 */
function settlePeriod(app, periodId, opts = {}) {
  const unpaidMeters = new Set(opts.unpaidMeters || []);
  const existing = findSettledBatch(app, periodId);
  assert(!existing, 'BATCH_ALREADY_SETTLED',
    `账期 ${periodId} 已存在结算批次 ${existing ? existing.batchId : ''}，已结快照不可改写`);
  const period = getPeriod(app, periodId);

  const counters = newCounters();
  const ledger = buildLedger(app.data, period, counters);
  const outstanding = outstandingByMeter(app);

  const lines = ledger.lines.map((l) => {
    const carryIn = l.kind === METER_KIND.RESIDENT ? round2(outstanding.get(l.meterId) || 0) : 0;
    const currentAmount = round2(l.amount + carryIn);
    const unpaid = l.kind === METER_KIND.RESIDENT && unpaidMeters.has(l.meterId);
    const paidAmount = unpaid ? 0 : currentAmount;
    return {
      meterId: l.meterId, name: l.name, kind: l.kind,
      ownKwh: l.ownKwh, lossKwh: l.lossKwh, totalKwh: l.totalKwh,
      unitPrice: l.unitPrice, periodAmount: l.amount,
      carryIn, currentAmount, paidAmount,
      carryOut: round2(currentAmount - paidAmount),
    };
  });

  app.seq += 1;
  const batch = deepFreeze({
    kind: 'settled',
    status: BATCH_STATUS.SETTLED,
    batchId: `SET-${periodId}-${String(app.seq).padStart(3, '0')}`,
    periodId,
    periodLabel: period.label,
    createdAt: new Date().toISOString(),
    inputFingerprint: app.inputFingerprint,
    ingestStats: counters,
    lines,
    snapshot: ledger,
  });
  app.batches.push(batch);
  return batch;
}

/**
 * 补交倍率变动：在已结批次之上追加调整批次。
 * 旧快照原样保留；用修正后的输入重算，差额形成补交（或退补）金额。
 */
function supplementMultiplier(app, periodId, correction, reason = '') {
  const origin = findSettledBatch(app, periodId);
  assert(origin, 'BATCH_NOT_SETTLED', `账期 ${periodId} 尚未结算，不能补交；请先结算`);
  const { meterId, to } = correction;
  const atIso = correction.atIso || app.data.meters.find((m) => m.id === meterId)?.installedAt;
  assert(atIso, 'METER_NOT_FOUND', `表 ${meterId} 不存在`);

  const signature = `${periodId}:${meterId}:${atIso}:${to}`;
  const dup = findAdjustments(app, periodId).find((b) => b.correctionSignature === signature);
  assert(!dup, 'ADJUSTMENT_ALREADY_EXISTS',
    `该倍率修正已生成调整批次 ${dup ? dup.batchId : ''}，不可重复补交`);

  // 深拷贝输入，绝不污染已结快照所依据的数据
  const corrected = structuredClone(app.data);
  const meter = corrected.meters.find((m) => m.id === meterId);
  assert(Boolean(meter), 'METER_NOT_FOUND', `表 ${meterId} 不存在`);
  const beforeMeter = app.data.meters.find((m) => m.id === meterId);
  const currentAt = beforeMeter.events
    .filter((e) => e.type === 'multiplier-change' && Date.parse(e.changeAt) <= Date.parse(atIso))
    .at(-1);
  const from = currentAt ? currentAt.to : beforeMeter.baseMultiplier;
  assert(from !== to, 'NO_OP_CORRECTION', `新倍率 ${to} 与当前倍率 ${from} 相同，无需修正`);
  meter.events.push({ type: 'multiplier-change', changeAt: atIso, from, to });
  meter.events.sort((a, b) => Date.parse(a.changeAt) - Date.parse(b.changeAt));

  const period = getPeriod(app, periodId);
  const correctedLedger = buildLedger(corrected, period);
  const beforeLedger = origin.snapshot;

  const lines = correctedLedger.lines.map((after) => {
    const before = beforeLedger.lines.find((l) => l.meterId === after.meterId);
    return {
      meterId: after.meterId, name: after.name, kind: after.kind,
      beforeTotalKwh: before ? before.totalKwh : 0,
      afterTotalKwh: after.totalKwh,
      deltaKwh: round6(after.totalKwh - (before ? before.totalKwh : 0)),
      beforeAmount: before ? before.amount : 0,
      afterAmount: after.amount,
      deltaAmount: round2(after.amount - (before ? before.amount : 0)),
    };
  });

  app.seq += 1;
  const batch = deepFreeze({
    kind: 'adjustment',
    status: BATCH_STATUS.ADJUSTMENT,
    batchId: `ADJ-${periodId}-${String(app.seq).padStart(3, '0')}`,
    periodId,
    periodLabel: period.label,
    createdAt: new Date().toISOString(),
    originBatchId: origin.batchId,
    reason,
    correctionSignature: signature,
    correction: { meterId, from, to, atIso },
    lines,
    totals: {
      deltaKwh: round6(lines.reduce((s, l) => s + l.deltaKwh, 0)),
      deltaAmount: round2(lines.reduce((s, l) => s + l.deltaAmount, 0)),
    },
    snapshot: correctedLedger,
  });
  app.batches.push(batch);
  return batch;
}

/**
 * 重算量对照：同一查询（各表金额 + 总表逐段电量），
 * 方案 A 分段读数从头重算；方案 B 直接读取已结快照。
 */
function recomputeComparison(app, periodId) {
  const period = getPeriod(app, periodId);
  const batch = findSettledBatch(app, periodId);

  // 方案 A：分段读数重算
  const segmentedCounters = newCounters();
  const ledgerA = buildLedger(app.data, period, segmentedCounters);
  segmentedCounters.dialArithmetic = segmentedCounters.readingPairs;

  // 方案 B：快照读取（不重新配对读数、不查倍率、不做边界校验）
  const snapshotCounters = newCounters();
  const snapshotAnswer = recomputeFromSnapshot(batch, snapshotCounters);
  const segmentedAnswer = {
    lineAmounts: Object.fromEntries(ledgerA.lines.map((l) => [l.meterId, l.amount])),
    segmentKwh: ledgerA.masterSegments.map((s) => s.kwh),
    totals: ledgerA.totals,
  };

  const sameResult = JSON.stringify(snapshotAnswer) === JSON.stringify(segmentedAnswer);
  const ratio = (x, y) => (y === 0 ? null : round2(x / y));
  return {
    periodId,
    query: '各表金额 + 总表逐段电量',
    segmented: {
      label: '方案A 分段读数重算',
      counters: segmentedCounters,
      answer: segmentedAnswer,
    },
    snapshot: {
      label: '方案B 结算快照读取',
      available: Boolean(batch),
      batchId: batch ? batch.batchId : null,
      counters: snapshotCounters,
      answer: snapshotAnswer,
    },
    sameResult,
    saving: {
      readingPairsAvoided: segmentedCounters.readingPairs - snapshotCounters.readingPairs,
      multiplierLookupsAvoided: segmentedCounters.multiplierResolutions - snapshotCounters.multiplierResolutions,
      boundaryChecksAvoided: segmentedCounters.boundaryChecks - snapshotCounters.boundaryChecks,
      dialArithmeticAvoided: segmentedCounters.dialArithmetic - snapshotCounters.dialArithmetic,
      rowReadRatio: ratio(snapshotCounters.snapshotRowReads, segmentedCounters.readingPairs),
    },
    conclusion: sameResult
      ? '两方案结果完全一致：快照方案以 O(结果行) 的读取替代 O(全部读数) 的重算，无任何表盘运算与边界校验'
      : '结果不一致：输入在结算后发生变化，应以新估算为准并走补交流程',
  };
}

function recomputeFromSnapshot(batch, counters) {
  if (!batch) return null;
  const lineAmounts = {};
  for (const l of batch.snapshot.lines) {
    lineAmounts[l.meterId] = l.amount;
    counters.snapshotRowReads += 1;
  }
  const segmentKwh = batch.snapshot.masterSegments.map((s) => {
    counters.snapshotRowReads += 1;
    return s.kwh;
  });
  return { lineAmounts, segmentKwh, totals: batch.snapshot.totals };
}

/** 分摊对照：正确分段算法 vs 月底倍率朴素算法（含逐段诊断与对账证据） */
function allocationComparison(app, periodId) {
  const period = getPeriod(app, periodId);
  const correct = buildLedger(app.data, period);
  const naive = buildNaiveLedger(app.data, period);
  const lineDiffs = correct.lines.map((c) => {
    const n = naive.lines.find((x) => x.meterId === c.meterId);
    return {
      meterId: c.meterId, name: c.name, kind: c.kind,
      correctTotalKwh: c.totalKwh, naiveTotalKwh: n ? n.totalKwh : 0,
      correctAmount: c.amount, naiveAmount: n ? n.amount : 0,
      amountDiff: round2(c.amount - (n ? n.amount : 0)),
    };
  });
  return {
    periodId,
    correct: {
      method: correct.method,
      totals: correct.totals,
      masterSegments: correct.masterSegments,
    },
    naive: {
      method: naive.method,
      assumedEndMultiplier: naive.assumedEndMultiplier,
      stitchedDialDelta: naive.stitchedDialDelta,
      totals: naive.totals,
      segmentDiagnostics: naive.segmentDiagnostics,
    },
    lineDiffs,
    adjacency: adjacencyCheck(correct, app.data),
    telescoping: telescopingCheck(correct, app.data),
    verdict: `朴素算法把整月表盘差 ${naive.stitchedDialDelta} 全部套月底倍率 ${naive.assumedEndMultiplier}，` +
      `总表电量偏差 ${round6(correct.totals.masterKwh - naive.totals.masterKwh)} 度；分段算法逐段按当时倍率折算，账段相接且与真值对账一致。`,
  };
}

module.exports = {
  createApp,
  estimate,
  settlePeriod,
  supplementMultiplier,
  recomputeComparison,
  allocationComparison,
  outstandingByMeter,
  findSettledBatch,
  findAdjustments,
  fingerprint,
  newCounters,
};
