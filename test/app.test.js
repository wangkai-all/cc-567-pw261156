'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSyntheticData } = require('../lib/synthetic');
const { buildLedger } = require('../lib/engine');
const {
  createApp, estimate, settlePeriod, supplementMultiplier,
  recomputeComparison, allocationComparison,
  findSettledBatch, findAdjustments, outstandingByMeter, newCounters,
} = require('../lib/app');
const { SettlementError, METER_KIND } = require('../lib/domain');

function freshApp() {
  return createApp(buildSyntheticData());
}

test('新估算不落地：estimate 不产生批次，可重复执行且结果一致', () => {
  const app = freshApp();
  const e1 = estimate(app, 'P1');
  const e2 = estimate(app, 'P1');
  assert.equal(app.batches.length, 0);
  assert.equal(e1.kind, 'new-estimate');
  assert.deepEqual(e1.ledger.totals, e2.ledger.totals);
  assert.equal(e1.adjacency.noOverlapNoGap, true);
  assert.equal(e1.telescoping.matched, true);
});

test('结算快照冻结：批次与内部快照均不可变', () => {
  const app = freshApp();
  const batch = settlePeriod(app, 'P1');
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.snapshot), true);
  assert.equal(Object.isFrozen(batch.lines), true);
  assert.throws(() => { batch.status = 'tampered'; }, TypeError);
  assert.throws(() => { batch.snapshot.totals.masterKwh = 1; }, TypeError);
});

test('重复结算同一账期被拒绝 → BATCH_ALREADY_SETTLED', () => {
  const app = freshApp();
  settlePeriod(app, 'P0');
  assert.throws(() => settlePeriod(app, 'P0'), (err) => {
    assert.equal(err.code, 'BATCH_ALREADY_SETTLED');
    return true;
  });
});

test('结转：P0 中 R1 未付清，P1 居民行 carryIn 接续、公共行不结转', () => {
  const app = freshApp();
  const p0 = settlePeriod(app, 'P0', { unpaidMeters: ['R1'] });
  const r1P0 = p0.lines.find((l) => l.meterId === 'R1');
  assert.ok(r1P0.carryOut > 0);
  assert.equal(p0.lines.find((l) => l.meterId === 'PUB').carryOut, 0);

  const outstanding = outstandingByMeter(app);
  assert.equal(outstanding.get('R1'), r1P0.carryOut);

  const p1 = settlePeriod(app, 'P1');
  const r1P1 = p1.lines.find((l) => l.meterId === 'R1');
  assert.equal(r1P1.carryIn, r1P0.carryOut);
  assert.equal(r1P1.currentAmount, round2(r1P1.periodAmount + r1P1.carryIn));
  const pubP1 = p1.lines.find((l) => l.meterId === 'PUB');
  assert.equal(pubP1.carryIn, 0);
  assert.equal(pubP1.kind, METER_KIND.PUBLIC);
});

test('补交倍率变动：只追加调整批次，原快照保持不变，差额为重算前后之差', () => {
  const app = freshApp();
  settlePeriod(app, 'P0', { unpaidMeters: ['R1'] });
  const origin = settlePeriod(app, 'P1');
  const beforeMaster = origin.snapshot.totals.masterKwh;

  const adj = supplementMultiplier(
    app, 'P1',
    { meterId: 'M-NEW', to: 20, atIso: app.data.splitPoint },
    '稽查复核',
  );
  assert.equal(adj.status, 'adjustment');
  assert.equal(adj.originBatchId, origin.batchId);
  assert.equal(adj.correction.from, 15);
  assert.equal(adj.correction.to, 20);
  // 原快照电量原封不动
  assert.equal(findSettledBatch(app, 'P1').snapshot.totals.masterKwh, beforeMaster);
  // 调整批次携带修正后的完整重算快照
  assert.ok(adj.snapshot.totals.masterKwh > beforeMaster);
  // 差额合计 = 各行 deltaAmount 之和
  const sumDelta = round2(adj.lines.reduce((s, l) => s + l.deltaAmount, 0));
  assert.equal(adj.totals.deltaAmount, sumDelta);
  assert.ok(adj.totals.deltaAmount > 0, '15→20 是上调，补交金额必须为正');
  // 公共区域金额不受倍率补交影响（公共按自己的表计），差额只落在承担线损的居民行
  const pubLine = adj.lines.find((l) => l.meterId === 'PUB');
  assert.equal(pubLine.deltaAmount, 0);
});

test('同一修正重复补交 → ADJUSTMENT_ALREADY_EXISTS', () => {
  const app = freshApp();
  settlePeriod(app, 'P1');
  const correction = { meterId: 'M-NEW', to: 20, atIso: app.data.splitPoint };
  supplementMultiplier(app, 'P1', correction);
  assert.throws(() => supplementMultiplier(app, 'P1', correction), (err) => {
    assert.equal(err.code, 'ADJUSTMENT_ALREADY_EXISTS');
    return true;
  });
  assert.equal(findAdjustments(app, 'P1').length, 1);
});

test('未结算账期补交 → BATCH_NOT_SETTLED；无变化修正 → NO_OP_CORRECTION；不存在表 → METER_NOT_FOUND', () => {
  const app = freshApp();
  assert.throws(
    () => supplementMultiplier(app, 'P1', { meterId: 'M-NEW', to: 20, atIso: app.data.splitPoint }),
    (err) => { assert.equal(err.code, 'BATCH_NOT_SETTLED'); return true; },
  );
  settlePeriod(app, 'P1');
  assert.throws(
    () => supplementMultiplier(app, 'P1', { meterId: 'M-NEW', to: 15, atIso: app.data.splitPoint }),
    (err) => { assert.equal(err.code, 'NO_OP_CORRECTION'); return true; },
  );
  assert.throws(
    () => supplementMultiplier(app, 'P1', { meterId: 'GHOST', to: 9, atIso: app.data.splitPoint }),
    (err) => { assert.equal(err.code, 'METER_NOT_FOUND'); return true; },
  );
});

test('重算量对照：两方案同结果，快照方案零表盘运算、仅读结果行', () => {
  const app = freshApp();
  settlePeriod(app, 'P0', { unpaidMeters: ['R1'] });
  settlePeriod(app, 'P1');
  const cmp = recomputeComparison(app, 'P1');
  assert.equal(cmp.sameResult, true);
  assert.equal(cmp.snapshot.available, true);
  assert.ok(cmp.segmented.counters.readingPairs > 0);
  assert.ok(cmp.segmented.counters.multiplierResolutions > 0);
  assert.ok(cmp.segmented.counters.boundaryChecks > 0);
  assert.equal(cmp.snapshot.counters.readingPairs, 0);
  assert.equal(cmp.snapshot.counters.multiplierResolutions, 0);
  assert.equal(cmp.snapshot.counters.boundaryChecks, 0);
  assert.ok(cmp.snapshot.counters.snapshotRowReads > 0);
  assert.ok(cmp.snapshot.counters.snapshotRowReads < cmp.segmented.counters.readingPairs);
  assert.ok(cmp.saving.readingPairsAvoided === cmp.segmented.counters.readingPairs);
});

test('无快照时快照方案不可用，且分段方案仍可独立回答查询', () => {
  const app = freshApp();
  const cmp = recomputeComparison(app, 'P1');
  assert.equal(cmp.snapshot.available, false);
  assert.equal(cmp.snapshot.answer, null);
  assert.ok(cmp.segmented.answer.lineAmounts.R1 > 0);
});

test('分摊对照：正确算法与朴素算法并列，附带相接性与望远镜证据', () => {
  const app = freshApp();
  const cmp = allocationComparison(app, 'P1');
  assert.equal(cmp.correct.method, 'segmented-readings');
  assert.equal(cmp.naive.method, 'naive-eom-multiplier');
  assert.notEqual(cmp.naive.totals.masterKwh, cmp.correct.totals.masterKwh);
  assert.equal(cmp.adjacency.sameHourJoins[0].noDoubleCount, true);
  assert.equal(cmp.telescoping.matched, true);
  assert.ok(cmp.lineDiffs.some((l) => l.amountDiff !== 0));
});

test('补交流程不影响新估算：修正后的重算与原始输入的估算可并存对照', () => {
  const app = freshApp();
  settlePeriod(app, 'P1');
  const originalEstimate = estimate(app, 'P1').ledger.totals.masterKwh;
  supplementMultiplier(app, 'P1', { meterId: 'M-NEW', to: 20, atIso: app.data.splitPoint });
  // app.data 未被修正污染（深拷贝隔离），新估算仍回答"当前输入"的结果
  assert.equal(estimate(app, 'P1').ledger.totals.masterKwh, originalEstimate);
  const adjBatch = findAdjustments(app, 'P1')[0];
  assert.ok(adjBatch.snapshot.totals.masterKwh > originalEstimate);
});

test('统计计数器：分段方案随账段数量增长，快照方案恒定为结果行数', () => {
  const app = freshApp();
  const ledger = buildLedger(app.data, app.data.periods[1], newCounters());
  const counters = newCounters();
  buildLedger(app.data, app.data.periods[1], counters);
  const expectedPairs = ledger.masterSegments.length +
    Object.values(ledger.subSegments).reduce((s, segs) => s + segs.length, 0);
  assert.equal(counters.readingPairs, expectedPairs);
  assert.equal(counters.multiplierResolutions, expectedPairs * 2);
});

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
