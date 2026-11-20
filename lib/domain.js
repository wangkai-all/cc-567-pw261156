'use strict';

// 领域常量与公共工具

const PRICE_PER_KWH = 0.6; // 单价（元/度），样例账期统一单价
const EPS = 1e-9;

const METER_KIND = Object.freeze({
  RESIDENT: 'resident',
  PUBLIC: 'public',
});

const BATCH_STATUS = Object.freeze({
  SETTLED: 'settled',
  ADJUSTMENT: 'adjustment',
});

const EVENT_TYPE = Object.freeze({
  MULTIPLIER: 'multiplier-change',
  REPLACEMENT: 'meter-replacement',
});

class SettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettlementError';
    this.code = code; // 机器可读错误码，供页面与测试区分异常场景
  }
}

function round6(x) {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

function round4(x) {
  return Math.round((x + Number.EPSILON) * 1e4) / 1e4;
}

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function assert(condition, code, message) {
  if (!condition) throw new SettlementError(code, message);
}

/** 升序去重时间点 */
function uniqueSortedTimes(times) {
  return [...new Set(times.map((t) => new Date(t).getTime()))]
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms).toISOString());
}

/** 在某时刻生效的倍率：取 changeAt <= at 的最后一条倍率事件，否则取表的基准倍率 */
function effectiveMultiplier(meter, at) {
  const ts = new Date(at).getTime();
  let value = meter.baseMultiplier;
  let hitAt = null;
  for (const ev of meter.events || []) {
    if (ev.type === EVENT_TYPE.MULTIPLIER && new Date(ev.changeAt).getTime() <= ts) {
      value = ev.to;
      hitAt = ev.changeAt;
    }
  }
  return { value, hitAt };
}

/**
 * 某物理表在账段 (t1, t2] 上的生效倍率。
 * 账段左开右闭：事件落在 t1 时归属以 t1 为起点的新段，落在 t2 时归属本段，
 * 故"段内生效值"= 最后一个 changeAt <= t2 的事件；同时要求该事件不落在开区间 (t1, t2) 内。
 */
function multiplierOnInterval(meter, t1, t2) {
  const atT2 = effectiveMultiplier(meter, t2);
  for (const ev of meter.events || []) {
    const t = new Date(ev.changeAt).getTime();
    assert(
      !(ev.type === EVENT_TYPE.MULTIPLIER && t > new Date(t1).getTime() && t < new Date(t2).getTime()),
      'MULTIPLIER_CHANGE_INSIDE_INTERVAL',
      `表 ${meter.id} 在区间 ${t1} ~ ${t2} 内发生倍率变更，必须先拆账`,
    );
  }
  return atT2.value;
}

module.exports = {
  PRICE_PER_KWH,
  EPS,
  METER_KIND,
  BATCH_STATUS,
  EVENT_TYPE,
  SettlementError,
  round2,
  round4,
  round6,
  assert,
  uniqueSortedTimes,
  effectiveMultiplier,
  multiplierOnInterval,
};
