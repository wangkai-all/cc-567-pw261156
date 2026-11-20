'use strict';

// 合成数据：可复现"总表换装 + 单位倍率变化"的两期账期（P0 九月样例 / P1 十月样例）。
// 全部读数由确定的逐小时物理用量反推表盘，另存 groundTruth 供对账测试使用（引擎不读它）。

const { METER_KIND, EVENT_TYPE, round6 } = require('./domain');

const HOUR = 3600 * 1000;
const START = Date.parse('2026-09-29T00:00:00.000Z');
const SPLIT = Date.parse('2026-10-02T10:30:00.000Z'); // 同一小时内：10:30 换装
const MULT_CHANGE = Date.parse('2026-10-02T10:00:00.000Z'); // 同一小时内：10:00 倍率 10→12
const P0_END = Date.parse('2026-10-01T00:00:00.000Z');
const END = Date.parse('2026-10-03T00:00:00.000Z');

const P0 = { id: 'P0', label: '2026-09 样例账期', startIso: new Date(START).toISOString(), endIso: new Date(P0_END).toISOString() };
const P1 = { id: 'P1', label: '2026-10 样例账期', startIso: new Date(P0_END).toISOString(), endIso: new Date(END).toISOString() };

function iso(ms) {
  return new Date(ms).toISOString();
}

// 逐小时物理用量剖面（确定、可复现）
function profile(i) {
  return {
    r1: 2 + (i % 3), // 2,3,4 循环
    r2: 1 + (i % 2), // 1,2 循环
    pub: 0.5 + 0.1 * (i % 4), // 0.5~0.8
    loss: 0.3, // 线损
  };
}

/**
 * 生成合成数据集。
 * @param {object} [opts]
 * @param {boolean} [opts.dropReading] 制造缺读数异常（删掉新总表在 11:00 的读数）
 * @param {boolean} [opts.reverseReading] 制造表倒走异常（翻转 R1 相邻两个读数）
 */
function buildSyntheticData(opts = {}) {
  const hours = (END - START) / HOUR; // 96
  const times = [];
  for (let i = 0; i <= hours; i++) times.push(START + i * HOUR);

  // 全局区间 i（1..96）：(times[i-1], times[i]]，拆账小时 i=83 被 SPLIT 切成两半
  const splitInterval = 83; // 10:00 -> 11:00（P1 第 35 个小时）
  const boundaries = uniqueWithSplit(times, SPLIT);

  const groundTruth = [];
  for (let i = 1; i <= hours; i++) {
    const p = profile(i);
    const t1 = times[i - 1];
    const t2 = times[i];
    if (i === splitInterval) {
      for (const [a, b] of [[t1, SPLIT], [SPLIT, t2]]) {
        groundTruth.push(makeTruth(a, b, p.r1 / 2, p.r2 / 2, p.pub / 2, p.loss / 2));
      }
    } else {
      groundTruth.push(makeTruth(t1, t2, p.r1, p.r2, p.pub, p.loss));
    }
  }

  const meters = [
    {
      id: 'R1', name: '居民 1 号楼', kind: METER_KIND.RESIDENT,
      baseMultiplier: 1, installedAt: iso(START), events: [],
    },
    {
      id: 'R2', name: '居民 2 号楼', kind: METER_KIND.RESIDENT,
      baseMultiplier: 1, installedAt: iso(START), events: [],
    },
    {
      id: 'PUB', name: '公共区域（楼道/泵房/照明）', kind: METER_KIND.PUBLIC,
      baseMultiplier: 1, installedAt: iso(START), events: [],
    },
    {
      id: 'M-OLD', name: '总表（旧表，CT 倍率 10→12，10:30 拆除）', kind: 'master',
      baseMultiplier: 10, installedAt: iso(START),
      events: [
        { type: EVENT_TYPE.MULTIPLIER, changeAt: iso(MULT_CHANGE), from: 10, to: 12 },
        { type: EVENT_TYPE.REPLACEMENT, changeAt: iso(SPLIT), successor: 'M-NEW', successorInitialDial: 300.0 },
      ],
    },
    {
      id: 'M-NEW', name: '总表（新表，CT 倍率 15）', kind: 'master',
      baseMultiplier: 15, installedAt: iso(SPLIT),
      events: [],
    },
  ];

  // ---- 逐表累计表盘读数 ----
  const r1Readings = [], r2Readings = [], pubReadings = [], oldReadings = [], newReadings = [];
  let r1Dial = 100, r2Dial = 200, pubDial = 50, oldDial = 800;
  const NEW_INITIAL_DIAL = 300;
  let newDial = NEW_INITIAL_DIAL;
  pushReading(r1Readings, times[0], r1Dial);
  pushReading(r2Readings, times[0], r2Dial);
  pushReading(pubReadings, times[0], pubDial);
  pushReading(oldReadings, times[0], oldDial);

  for (let i = 1; i <= hours; i++) {
    const p = profile(i);
    if (i === splitInterval) {
      // 上半小时（旧表，倍率 12）
      r1Dial += p.r1 / 2; r2Dial += p.r2 / 2; pubDial += p.pub / 2;
      const halfMaster = (p.r1 + p.r2 + p.pub + p.loss) / 2;
      oldDial += halfMaster / 12;
      pushReading(r1Readings, SPLIT, r1Dial);
      pushReading(r2Readings, SPLIT, r2Dial);
      pushReading(pubReadings, SPLIT, pubDial);
      pushReading(oldReadings, SPLIT, oldDial);
      // 下半小时（新表，倍率 15）：换装时刻首读 = 新表起度，之后再累计表盘差
      pushReading(newReadings, SPLIT, NEW_INITIAL_DIAL);
      r1Dial += p.r1 / 2; r2Dial += p.r2 / 2; pubDial += p.pub / 2;
      newDial += halfMaster / 15;
      pushReading(r1Readings, times[i], r1Dial);
      pushReading(r2Readings, times[i], r2Dial);
      pushReading(pubReadings, times[i], pubDial);
      pushReading(newReadings, times[i], newDial);
      continue;
      continue;
    }
    r1Dial += p.r1;
    r2Dial += p.r2;
    pubDial += p.pub;
    const masterKwh = p.r1 + p.r2 + p.pub + p.loss;
    if (times[i] <= SPLIT) {
      // 账段 (t_{i-1}, t_i]：倍率事件在右端点时归属本段（10:00 起按 12 倍）
      const mult = times[i] < MULT_CHANGE ? 10 : 12;
      oldDial += masterKwh / mult;
      pushReading(oldReadings, times[i], oldDial);
    } else {
      newDial += masterKwh / 15;
      pushReading(newReadings, times[i], newDial);
    }
    pushReading(r1Readings, times[i], r1Dial);
    pushReading(r2Readings, times[i], r2Dial);
    pushReading(pubReadings, times[i], pubDial);
  }

  for (const m of meters) {
    if (m.id === 'R1') m.readings = r1Readings;
    if (m.id === 'R2') m.readings = r2Readings;
    if (m.id === 'PUB') m.readings = pubReadings;
    if (m.id === 'M-OLD') m.readings = oldReadings;
    if (m.id === 'M-NEW') m.readings = newReadings;
  }

  const data = {
    generatedAt: iso(Date.now()),
    pricePerKwh: 0.6,
    periods: [P0, P1],
    splitPoint: iso(SPLIT),
    multiplierChangeAt: iso(MULT_CHANGE),
    meters,
    groundTruth,
    timelineNote: 'P0/P1 各 48 小时逐时读数；2026-10-02 10:00 旧总表倍率 10→12，10:30 换装新表（倍率 15），同一小时内产生两段相接账段',
  };

  if (opts.dropReading) {
    const nm = data.meters.find((m) => m.id === 'M-NEW');
    // 删掉新表账期窗口的末点读数，制造边界缺读数
    nm.readings.pop();
    data.corruption = 'M-NEW 缺少账期末点读数（换装表窗口不完整）';
  }
  if (opts.reverseReading) {
    const r1 = data.meters.find((m) => m.id === 'R1');
    // 把 P1 内第 10 个读数（全局索引 58）改到前一个读数之下，制造表盘倒走
    r1.readings[58] = { timestamp: r1.readings[58].timestamp, dial: r1.readings[57].dial - 1 };
    data.corruption = 'R1 在 P1 内一个读数被改小，表盘倒走';
  }
  return data;
}

function makeTruth(t1, t2, r1, r2, pub, loss) {
  return {
    startIso: iso(t1), endIso: iso(t2),
    residentKwh: round6(r1 + r2),
    publicKwh: round6(pub),
    lossKwh: round6(loss),
    masterKwh: round6(r1 + r2 + pub + loss),
  };
}

function uniqueWithSplit(times, split) {
  const all = [...times, split].sort((a, b) => a - b);
  return [...new Set(all)].map((ms) => iso(ms));
}

function pushReading(arr, ts, dial) {
  // 表盘保留 8 位小数：6 位会让 48 段累计误差超出对账容差
  arr.push({ timestamp: iso(ts), dial: Math.round((dial + Number.EPSILON) * 1e8) / 1e8 });
}

module.exports = {
  buildSyntheticData,
  START, SPLIT, MULT_CHANGE, P0_END, END,
  P0, P1,
};
