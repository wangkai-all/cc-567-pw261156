'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(base + pathname, {
      method,
      headers: payload ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const json = JSON.parse(raw);
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('服务绑定 127.0.0.1，首页包含 data-evidence-result 业务结果区', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  const html = await new Promise((resolve, reject) => {
    http.get(base + '/', (r) => {
      let raw = '';
      r.on('data', (c) => { raw += c; });
      r.on('end', () => resolve(raw));
      r.on('error', reject);
    });
  });
  assert.match(html, /id="result"/);
  assert.match(html, /data-evidence-result="empty"/);
  assert.match(html, /结转样例账期/);
  assert.match(html, /补交倍率变动/);
  assert.match(html, /对照分摊明细/);
});

test('健康检查与元数据接口', async () => {
  const h = await request('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  const m = await request('GET', '/api/meta');
  assert.equal(m.json.periods.length, 2);
  assert.equal(m.json.meters.length, 5);
  assert.ok(m.json.groundTruthIntervals >= 97);
});

test('结转样例账期：P0 结转 R1 欠款，P1 行内 carryIn 接续', async () => {
  const r = await request('POST', '/api/demo/carry-forward');
  assert.equal(r.status, 200);
  assert.equal(r.json.p0Batch.status, 'settled');
  const r1P1 = r.json.p1Batch.lines.find((l) => l.meterId === 'R1');
  assert.ok(r1P1.carryIn > 0);
  assert.equal(r1P1.currentAmount, round2(r1P1.periodAmount + r1P1.carryIn));
  // 重复执行结转演示：P0/P1 已结算，返回业务异常
  const dup = await request('POST', '/api/demo/carry-forward');
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'BATCH_ALREADY_SETTLED');
});

test('补交倍率变动：追加调整批次、原快照冻结、重复提交报异常', async () => {
  const r = await request('POST', '/api/demo/supplement');
  assert.equal(r.status, 200);
  assert.equal(r.json.originSnapshotFrozen, true);
  assert.equal(r.json.adjustment.status, 'adjustment');
  assert.ok(r.json.adjustment.totals.deltaAmount > 0);
  const dup = await request('POST', '/api/demo/supplement');
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'ADJUSTMENT_ALREADY_EXISTS');
});

test('对照分摊明细：正确/朴素两套结果与同小时不重计证据', async () => {
  const r = await request('POST', '/api/demo/allocation');
  assert.equal(r.status, 200);
  assert.equal(r.json.correct.method, 'segmented-readings');
  assert.equal(r.json.naive.method, 'naive-eom-multiplier');
  assert.equal(r.json.telescoping.matched, true);
  assert.equal(r.json.adjacency.sameHourJoins[0].noDoubleCount, true);
  assert.notEqual(r.json.naive.totals.masterKwh, r.json.correct.totals.masterKwh);
});

test('查询端：新估算接口与批次回查接口并存', async () => {
  const e = await request('GET', '/api/estimate?periodId=P1');
  assert.equal(e.status, 200);
  assert.equal(e.json.kind, 'new-estimate');
  const bs = await request('GET', '/api/batches');
  assert.equal(bs.status, 200);
  assert.ok(bs.json.batches.some((b) => b.status === 'settled'));
  assert.ok(bs.json.batches.some((b) => b.status === 'adjustment'));
  const id = bs.json.batches[0].batchId;
  const one = await request('GET', `/api/batch?id=${encodeURIComponent(id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.batchId, id);
  const missing = await request('GET', '/api/batch?id=NOPE');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'BATCH_NOT_FOUND');
});

test('重算量对照接口：快照方案读数配对为 0、结果一致', async () => {
  const r = await request('GET', '/api/recompute-comparison?periodId=P1');
  assert.equal(r.status, 200);
  assert.equal(r.json.sameResult, true);
  assert.equal(r.json.snapshot.counters.readingPairs, 0);
  assert.ok(r.json.segmented.counters.readingPairs > 0);
});

test('重置接口清空批次，之后可重新演示', async () => {
  const before = await request('GET', '/api/batches');
  assert.ok(before.json.batches.length > 0);
  const r = await request('POST', '/api/reset');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const after = await request('GET', '/api/batches');
  assert.equal(after.json.batches.length, 0);
  const again = await request('POST', '/api/demo/carry-forward');
  assert.equal(again.status, 200);
  assert.equal(again.json.p1Batch.batchId, 'SET-P1-002');
});

test('异常输入：坏 JSON、未知路由、未知账期均返回结构化 400', async () => {
  const badJson = await new Promise((resolve) => {
    const req = http.request(base + '/api/settle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.end('{not-json');
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error, 'BAD_JSON');

  const nf = await request('GET', '/api/nope');
  assert.equal(nf.status, 400);
  assert.equal(nf.json.error, 'NOT_FOUND');

  const np = await request('GET', '/api/estimate?periodId=ZZ');
  assert.equal(np.status, 400);
  assert.equal(np.json.error, 'PERIOD_NOT_FOUND');
});

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
