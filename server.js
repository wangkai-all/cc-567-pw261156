'use strict';

// 本地 HTTP 服务：仅用 Node 内置模块；绑定 127.0.0.1，端口读 PORT。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildSyntheticData } = require('./lib/synthetic');
const { SettlementError } = require('./lib/domain');
const {
  createApp, estimate, settlePeriod, supplementMultiplier,
  recomputeComparison, allocationComparison,
  findSettledBatch, findAdjustments, outstandingByMeter,
} = require('./lib/app');

function createServer() {
  const app = createApp(buildSyntheticData());

  const json = (res, code, payload) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new SettlementError('PAYLOAD_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new SettlementError('BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { ok: true, batches: app.batches.length, inputFingerprint: app.inputFingerprint });
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return json(res, 200, {
          periods: app.data.periods,
          splitPoint: app.data.splitPoint,
          multiplierChangeAt: app.data.multiplierChangeAt,
          pricePerKwh: app.data.pricePerKwh,
          meters: app.data.meters.map((m) => ({
            id: m.id, name: m.name, kind: m.kind,
            baseMultiplier: m.baseMultiplier, installedAt: m.installedAt, events: m.events,
            readingCount: m.readings.length,
          })),
          groundTruthIntervals: app.data.groundTruth.length,
          timelineNote: app.data.timelineNote,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/estimate') {
        return json(res, 200, estimate(app, url.searchParams.get('periodId') || 'P1'));
      }
      if (req.method === 'GET' && url.pathname === '/api/batches') {
        return json(res, 200, {
          batches: app.batches.map((b) => ({
            batchId: b.batchId, kind: b.kind, status: b.status,
            periodId: b.periodId, periodLabel: b.periodLabel,
            createdAt: b.createdAt, originBatchId: b.originBatchId || null,
            reason: b.reason || '', correction: b.correction || null,
            totals: b.kind === 'adjustment' ? b.totals : null,
            inputFingerprint: b.inputFingerprint,
          })),
          outstanding: Object.fromEntries(outstandingByMeter(app)),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/batch') {
        const id = url.searchParams.get('id');
        const batch = app.batches.find((b) => b.batchId === id);
        if (!batch) throw new SettlementError('BATCH_NOT_FOUND', `批次 ${id} 不存在`);
        return json(res, 200, batch);
      }
      if (req.method === 'GET' && url.pathname === '/api/recompute-comparison') {
        return json(res, 200, recomputeComparison(app, url.searchParams.get('periodId') || 'P1'));
      }
      if (req.method === 'GET' && url.pathname === '/api/allocation-comparison') {
        return json(res, 200, allocationComparison(app, url.searchParams.get('periodId') || 'P1'));
      }
      if (req.method === 'POST' && url.pathname === '/api/settle') {
        const body = await readBody(req);
        return json(res, 200, settlePeriod(app, body.periodId, { unpaidMeters: body.unpaidMeters || [] }));
      }
      if (req.method === 'POST' && url.pathname === '/api/supplement') {
        const body = await readBody(req);
        return json(res, 200, supplementMultiplier(
          app, body.periodId,
          { meterId: body.meterId, to: body.to, atIso: body.atIso },
          body.reason || '',
        ));
      }
      // ---- 页面三个业务按钮对应的编排动作 ----
      if (req.method === 'POST' && url.pathname === '/api/demo/carry-forward') {
        const p0 = findSettledBatch(app, 'P0');
        if (!p0) settlePeriod(app, 'P0', { unpaidMeters: ['R1'] });
        const p1Estimate = estimate(app, 'P1');
        const before = outstandingByMeter(app);
        const p1 = settlePeriod(app, 'P1', { unpaidMeters: [] });
        return json(res, 200, {
          title: '结转样例账期',
          p0Batch: findSettledBatch(app, 'P0'),
          p1EstimateBeforeSettle: p1Estimate.ledger.totals,
          carryInAtSettle: Object.fromEntries(before),
          p1Batch: p1,
          explanation: 'P0 中 R1 未付清，形成结转；P1 结算时各居民行先取 carryIn（历史未结），再与本期金额合并。公共区域不参与居民结转。',
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/supplement') {
        if (!findSettledBatch(app, 'P1')) {
          if (!findSettledBatch(app, 'P0')) settlePeriod(app, 'P0', { unpaidMeters: ['R1'] });
          settlePeriod(app, 'P1', { unpaidMeters: [] });
        }
        const origin = findSettledBatch(app, 'P1');
        const correction = { meterId: 'M-NEW', to: 20, atIso: app.data.splitPoint };
        const adjustment = supplementMultiplier(app, 'P1', correction, '稽查复核：新总表 CT 倍率 15 应为 20，补交差额');
        return json(res, 200, {
          title: '补交倍率变动',
          originBatchId: origin.batchId,
          originSnapshotFrozen: Object.isFrozen(origin) && Object.isFrozen(origin.snapshot),
          adjustment,
          explanation: '已结快照原样冻结保留；修正只追加调整批次 ADJ，差额 = 修正后重算金额 − 快照金额。重复提交同一修正会被拒绝。',
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/allocation') {
        return json(res, 200, {
          title: '对照分摊明细',
          ...allocationComparison(app, 'P1'),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        app.batches.length = 0;
        app.seq = 0;
        return json(res, 200, { ok: true });
      }
      throw new SettlementError('NOT_FOUND', `路由 ${req.method} ${url.pathname} 不存在`);
    } catch (err) {
      if (err instanceof SettlementError) return json(res, 400, { error: err.code, message: err.message });
      return json(res, 500, { error: 'INTERNAL', message: err.message });
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`分段计量结算服务已启动: http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
