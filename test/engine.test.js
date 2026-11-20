'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSyntheticData } = require('../lib/synthetic');
const {
  buildLedger, buildNaiveLedger, adjacencyCheck, telescopingCheck, buildMeterSegments,
} = require('../lib/engine');
const { SettlementError, METER_KIND } = require('../lib/domain');

const data = buildSyntheticData();
const [P0, P1] = data.periods;

test('合成数据：居民表与公共表、总表（旧/新）分开建表，读数互不混用', () => {
  const ids = data.meters.map((m) => m.id);
  assert.deepEqual(ids, ['R1', 'R2', 'PUB', 'M-OLD', 'M-NEW']);
  const kinds = Object.fromEntries(data.meters.map((m) => [m.id, m.kind]));
  assert.equal(kinds.R1, METER_KIND.RESIDENT);
  assert.equal(kinds.R2, METER_KIND.RESIDENT);
  assert.equal(kinds.PUB, METER_KIND.PUBLIC);
  assert.equal(kinds['M-OLD'], 'master');
  assert.equal(kinds['M-NEW'], 'master');
  // 公共区域电量独立成列，绝不并入居民分摊基数
  const ledger = buildLedger(data, P1);
  const pub = ledger.lines.find((l) => l.meterId === 'PUB');
  assert.equal(pub.kind, METER_KIND.PUBLIC);
  assert.equal(pub.lossKwh, 0, '公共区域不承担居民线损分摊');
});

test('分段拆账：账段数量 = 逐小时账段 + 换装/变更时刻插入的额外账段', () => {
  const l0 = buildLedger(data, P0);
  assert.equal(l0.masterSegments.length, 48); // P0 无变更，每小时一段
  const l1 = buildLedger(data, P1);
  assert.equal(l1.masterSegments.length, 49); // 48 小时 + 10:30 换装多切一段
  // 10:00 倍率 10→12 与 10:30 换装均有对应账段
  const multSeg = l1.masterSegments.find((s) => s.startIso === data.multiplierChangeAt);
  assert.equal(multSeg.multiplier, 12);
  assert.equal(multSeg.meterId, 'M-OLD');
  const oldHalf = l1.masterSegments.find((s) => s.endIso === data.splitPoint && s.meterId === 'M-OLD');
  const newHalf = l1.masterSegments.find((s) => s.startIso === data.splitPoint && s.meterId === 'M-NEW');
  assert.ok(oldHalf && newHalf);
  assert.equal(oldHalf.multiplier, 12);
  assert.equal(newHalf.multiplier, 15);
});

test('每段按当时生效倍率折算，绝不套月底倍率', () => {
  const l1 = buildLedger(data, P1);
  for (const seg of l1.masterSegments) {
    const expectedKwh = seg.dialDelta * seg.multiplier;
    assert.ok(Math.abs(seg.kwh - expectedKwh) < 1e-9);
  }
  // 月底倍率是 15，但 10:00 之前的旧表账段必须按 10 倍折算
  const early = l1.masterSegments.find((s) => s.meterId === 'M-OLD' && s.startIso === P1.startIso);
  assert.equal(early.multiplier, 10);
});

test('同一小时两段相接：不重计、不漏计，合并值等于独立真值', () => {
  const l1 = buildLedger(data, P1);
  const adj = adjacencyCheck(l1, data);
  assert.equal(adj.ordered, true);
  assert.equal(adj.coversPeriod, true);
  assert.equal(adj.noOverlapNoGap, true);
  assert.equal(adj.sameHourJoins.length, 1);
  const j = adj.sameHourJoins[0];
  assert.equal(j.joinAtIso, data.splitPoint);
  assert.equal(j.fromMeter, 'M-OLD');
  assert.equal(j.toMeter, 'M-NEW');
  assert.ok(Math.abs(j.firstHalfKwh - 3.55) < 1e-6);
  assert.ok(Math.abs(j.secondHalfKwh - 3.55) < 1e-6);
  assert.ok(Math.abs(j.combinedKwh - j.groundTruthHourKwh) < 1e-6);
  assert.equal(j.noDoubleCount, true);
  assert.equal(j.diffKwh, 0);
});

test('望远镜对账：账段电量之和与独立真值逐区间合计一致（两期均通过）', () => {
  for (const p of [P0, P1]) {
    const ledger = buildLedger(data, p);
    const check = telescopingCheck(ledger, data);
    assert.equal(check.matched, true, `${p.id} 望远镜对账失败: ${JSON.stringify(check.diffs)}`);
    assert.equal(check.truthIntervals, p.id === 'P0' ? 48 : 49);
  }
});

test('线损 = 总表 − 居民 − 公共，且按居民电量比例分摊后总和严格闭合', () => {
  const ledger = buildLedger(data, P1);
  const { masterKwh, residentKwh, publicKwh, lossKwh } = ledger.totals;
  assert.ok(Math.abs(lossKwh - (masterKwh - residentKwh - publicKwh)) < 1e-9);
  const allocated = ledger.lines
    .filter((l) => l.kind === METER_KIND.RESIDENT)
    .reduce((s, l) => s + l.lossKwh, 0);
  assert.ok(Math.abs(allocated - lossKwh) < 1e-9);
  // 公共表不参与线损分摊
  assert.equal(ledger.lines.find((l) => l.meterId === 'PUB').lossKwh, 0);
});

test('朴素算法（整月表盘差 × 月底倍率）必然算错，并可逐段定位偏差', () => {
  const correct = buildLedger(data, P1);
  const naive = buildNaiveLedger(data, P1);
  assert.equal(naive.assumedEndMultiplier, 15);
  assert.notEqual(naive.totals.masterKwh, correct.totals.masterKwh);
  assert.ok(naive.totals.masterKwh > correct.totals.masterKwh, '高倍率套全月会虚增电量');
  assert.ok(naive.totals.lossKwh > correct.totals.lossKwh, '虚增电量全部沉淀为虚增线损并转嫁给居民');
  assert.notDeepEqual(
    naive.lines.map((l) => l.amount),
    correct.lines.map((l) => l.amount),
  );
  // 旧表 10 倍段在朴素算法下每段都被错按 15 倍
  const bad = naive.segmentDiagnostics.find((s) => s.correctMultiplier === 10);
  assert.equal(bad.naiveMultiplier, 15);
  assert.ok(bad.deltaKwh > 0);
  // 新表 15 倍段两种算法一致
  const fine = naive.segmentDiagnostics.find((s) => s.meterId === 'M-NEW');
  assert.ok(Math.abs(fine.deltaKwh) < 1e-9);
});

test('异常：换装后缺读数 → READING_MISSING_AT_PERIOD_BOUNDARY', () => {
  const bad = buildSyntheticData({ dropReading: true });
  assert.throws(() => buildLedger(bad, P1), (err) => {
    assert.ok(err instanceof SettlementError);
    assert.match(err.code, /^READING_MISSING/);
    return true;
  });
});

test('异常：表盘倒走 → METER_REVERSED', () => {
  const bad = buildSyntheticData({ reverseReading: true });
  assert.throws(() => buildLedger(bad, P1), (err) => {
    assert.ok(err instanceof SettlementError);
    assert.equal(err.code, 'METER_REVERSED');
    return true;
  });
});

test('异常：账期不存在 → PERIOD_NOT_FOUND（经应用层）', () => {
  const { createApp, estimate } = require('../lib/app');
  const app = createApp(buildSyntheticData());
  assert.throws(() => estimate(app, 'PX'), (err) => {
    assert.equal(err.code, 'PERIOD_NOT_FOUND');
    return true;
  });
});

test('异常：倍率变更落在两读数之间且无切点 → MULTIPLIER_CHANGE_INSIDE_INTERVAL', () => {
  const bad = buildSyntheticData();
  const old = bad.meters.find((m) => m.id === 'M-OLD');
  // 在 02:00~03:00 之间插入变更，却不提供对应读数
  old.events.push({ type: 'multiplier-change', changeAt: '2026-10-01T02:30:00.000Z', from: 10, to: 11 });
  assert.throws(() => buildMeterSegments(old, Date.parse(P1.startIso), Date.parse(P1.endIso)), (err) => {
    assert.equal(err.code, 'MULTIPLIER_CHANGE_INSIDE_INTERVAL');
    return true;
  });
});

test('异常：分表缺变更时刻读数 → READING_MISSING_AT_BOUNDARY', () => {
  const bad = buildSyntheticData();
  const r2 = bad.meters.find((m) => m.id === 'R2');
  r2.readings = r2.readings.filter((r) => r.timestamp !== bad.splitPoint);
  assert.throws(() => buildLedger(bad, P1), (err) => {
    assert.equal(err.code, 'READING_MISSING_AT_BOUNDARY');
    return true;
  });
});

test('异常：总表缺变更时刻读数 → READING_MISSING_AT_BOUNDARY（账段无法对齐）', () => {
  const bad = buildSyntheticData();
  const r1 = bad.meters.find((m) => m.id === 'R1');
  r1.readings = r1.readings.filter((r) => r.timestamp !== bad.multiplierChangeAt);
  assert.throws(() => buildLedger(bad, P1), (err) => {
    assert.ok(err.code.startsWith('READING_MISSING'));
    return true;
  });
});

test('异常：负线损（分表合计大于总表）→ LOSS_NEGATIVE', () => {
  const bad = buildSyntheticData();
  // 放大居民表读数，使分表电量超过总表（不触碰换装起度等前置校验）
  const r1 = bad.meters.find((m) => m.id === 'R1');
  r1.readings = r1.readings.map((r) => ({ ...r, dial: r.dial * 10 }));
  assert.throws(() => buildLedger(bad, P1), (err) => {
    assert.equal(err.code, 'LOSS_NEGATIVE');
    return true;
  });
});
