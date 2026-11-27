// 用 node 跑：node tests/weak-history.test.js
// 测 assets/modules/core/weak-history.js（假存储，不碰浏览器）。
const His = require('../assets/modules/core/weak-history.js');
const Store = require('../assets/modules/core/store.js');

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}
function truthy(name, got) {
  const ok = !!got;
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got);
}

function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    _map: map
  };
}

const storage = makeStorage();
Store.resetForTest({ storage });

const T = new Date('2026-11-27T21:00:00+08:00').getTime();

// ---------- 1. 键名与写入 ----------
eq('键名格式', His.keyOf('redbook-2024', '2026-11'), 'reviewwords.weakhis.redbook-2024.2026-11');
truthy('记一次忘了', His.add('redbook-2024', 'abandon', 1, T).ok);
eq('写进了当月键', storage._map.has('reviewwords.weakhis.redbook-2024.2026-11'), 'true');

His.add('redbook-2024', 'abandon', 1, T);
His.add('redbook-2024', 'abandon', 2, T);
His.add('redbook-2024', 'vague', 2, T);
His.add('redbook-2024', 'delicate', 1, T);

const rows = His.day('redbook-2024', '2026-11-27');
eq('这一天 3 个词', rows.length, 3);
eq('次数最少的排后面', rows[0].word, 'abandon');
eq('abandon 忘了 2 次', rows[0].forgot, 2);
eq('abandon 模糊 1 次', rows[0].fuzzy, 1);
eq('vague 只有模糊', rows.find((r) => r.word === 'vague').fuzzy, 1);
eq('vague 忘了是 0', rows.find((r) => r.word === 'vague').forgot, 0);

// 同一数量按字母序
His.add('redbook-2024', 'zebra', 2, T);
His.add('redbook-2024', 'apple', 2, T);
const same = His.day('redbook-2024', '2026-11-27').filter((r) => r.forgot + r.fuzzy === 1 && (r.word === 'apple' || r.word === 'zebra'));
eq('同次数按字母排', same[0].word, 'apple');

// 熟悉（3）不记
His.add('redbook-2024', 'abandon', 3, T);
eq('熟悉不进薄弱历史', His.day('redbook-2024', '2026-11-27').find((r) => r.word === 'abandon').forgot, 2);

// ---------- 2. 按月分键 ----------
const DEC = new Date('2026-12-01T09:00:00+08:00').getTime();
His.add('redbook-2024', 'sustain', 1, DEC);
eq('12 月单独一个键', storage._map.has('reviewwords.weakhis.redbook-2024.2026-12'), 'true');
eq('12 月只有 1 个词', His.day('redbook-2024', '2026-12-01').length, 1);
eq('11 月不受影响', His.day('redbook-2024', '2026-11-27').length, 5);

// ---------- 3. 月度计数（日历色块用）----------
const counts = His.monthCounts('redbook-2024', '2026-11');
eq('27 号有 5 个词', counts['27'], 5);
eq('只有 1 天有记录', His.daysWithData('redbook-2024', '2026-11'), 1);
eq('没记录的月份是空对象', JSON.stringify(His.monthCounts('redbook-2024', '2026-09')), '{}');

// ---------- 4. 词书之间互不串 ----------
His.add('another-book', 'abandon', 1, T);
eq('别的书读不到这本的历史', His.day('another-book', '2026-11-27').length, 1);

// ---------- 5. 回填：升级前只有「最后一次评价」----------
const recs = {
  apple: { last: 2, lastAt: new Date('2026-11-20T10:00:00+08:00').getTime() },
  banana: { last: 1, lastAt: new Date('2026-11-21T10:00:00+08:00').getTime() },
  cherry: { last: 3, lastAt: T },
  durian: {}
};
const n = His.backfill('backfill-book', recs);
eq('只回填忘了/模糊的两个词', n, 2);
eq('回填到 20 号', His.day('backfill-book', '2026-11-20').length, 1);
eq('回填到 21 号', His.day('backfill-book', '2026-11-21').length, 1);
eq('熟悉的不回填', His.day('backfill-book', '2026-11-27').length, 0);

// ---------- 6. 清书 ----------
const before = storage._map.size;
truthy('清掉这本书的 2 个月份键', His.clearBook('redbook-2024') >= 2);
eq('清完读不到', His.day('redbook-2024', '2026-11-27').length, 0);
truthy('别的书还在', His.day('another-book', '2026-11-27').length === 1);

console.log(fails ? '\n有 ' + fails + ' 项没过' : '\n全部通过');
process.exit(fails ? 1 : 0);
