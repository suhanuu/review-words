// 用 node 跑：node tests/review-log.test.js
// 测 assets/modules/core/review-log.js（假存储，不碰浏览器）。
const Log = require('../assets/modules/core/review-log.js');
const Store = require('../assets/modules/core/store.js');

const DAY = 86400000;

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}
function near(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ~' + want + ' ±' + tol + ')'));
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

const T = new Date('2026-11-26T21:00:00+08:00').getTime();

// ---------- 1. 追加与键名 ----------
let res = Log.append('redbook-2024', 3, DAY, T);
eq('追加成功', res.ok, 'true');
eq('本月键名', Log.keyOf('redbook-2024', Log.monthOf(T)), 'reviewwords.revlog.redbook-2024.2026-11');
eq('写进了本月键', storage._map.has('reviewwords.revlog.redbook-2024.2026-11'), 'true');
eq('一条记录', Log.list('redbook-2024', '2026-11').length, 1);

const row = Log.list('redbook-2024', '2026-11')[0];
eq('记录格式是 [时间, 评价, 间隔天数]', row.length, 3);
eq('记录里的评价', row[1], 3);
eq('记录里的间隔天数', row[2], 1);

// 跨月自动分键
Log.append('redbook-2024', 1, 15 * 60000, new Date('2026-12-01T09:00:00+08:00').getTime());
eq('12 月单独一个键', storage._map.has('reviewwords.revlog.redbook-2024.2026-12'), 'true');
eq('11 月还是只有 1 条', Log.list('redbook-2024', '2026-11').length, 1);
eq('12 月有 1 条', Log.list('redbook-2024', '2026-12').length, 1);

// ---------- 2. 统计 ----------
Log.append('redbook-2024', 3, 6 * DAY, T + 1000);
Log.append('redbook-2024', 2, 3 * DAY, T + 2000);
Log.append('redbook-2024', 1, 15 * 60000, T + 3000);
const s = Log.stats('redbook-2024', '2026-11');
eq('本月评价次数', s.count, 4);
eq('本月忘了次数', s.forgot, 1);
near('忘了占比', s.rate, 0.25, 0.001);
near('非忘了时的平均间隔（天）', s.avgDays, (1 + 6 + 3) / 3, 0.01);

eq('今日评价 = 本月今天的条数', Log.dayStats('redbook-2024', '2026-11-26').count, 4);
eq('昨天的条数', Log.dayStats('redbook-2024', '2026-11-25').count, 0);
eq('统计不串书', Log.stats('another-book', '2026-11').count, 0);

// ---------- 3. 上限：每月最多 3000 条，超了丢最老的 ----------
storage._map.set('reviewwords.revlog.bigbook.2026-11', JSON.stringify(
  Array.from({ length: Log.MAX_ROWS }, (_, i) => [T + i, 3, 1])
));
Log.append('bigbook', 3, 2 * DAY, T + 999999);
const big = Log.list('bigbook', '2026-11');
eq('超过上限后仍是 3000 条', big.length, Log.MAX_ROWS);
eq('丢的是最老的，最后一条是刚写的', big[big.length - 1][0], T + 999999);

// ---------- 4. clearBook 只清自己那本 ----------
eq('清掉 2 个月份键', Log.clearBook('redbook-2024'), 2);
eq('清完读不到', Log.list('redbook-2024', '2026-11').length, 0);
eq('别的书的日志还在', Log.list('bigbook', '2026-11').length, Log.MAX_ROWS);

console.log(fails ? '\n有 ' + fails + ' 项没过' : '\n全部通过');
process.exit(fails ? 1 : 0);
