// 用 node 跑：node tests/format.test.js
// 测 assets/modules/core/format.js：日期键、相对时间、倒计时、时长文案、月度序列。
const F = require('../assets/modules/core/format.js');

const MIN = 60000;
const DAY = 86400000;

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}

// ---------- 日期键 ----------
eq('pad 补零', F.pad(7), '07');
eq('pad 两位数不动', F.pad(12), '12');

const today = F.todayKey();
eq('todayKey 格式', /^\d{4}-\d{2}-\d{2}$/.test(today), 'true');

const ts = new Date(2026, 10, 26, 9, 30).getTime();   // 本地时间 2026-11-26 09:30
eq('dayKeyOf 用本地时区', F.dayKeyOf(ts), '2026-11-26');
eq('同一天不同时刻的键一致', F.dayKeyOf(ts + 13 * 3600 * 1000), '2026-11-26');

// ---------- 秒表与相对时间 ----------
eq('mmss 补零', F.mmss(65), '01:05');
eq('mmss 零点', F.mmss(0), '00:00');

eq('humanGap 不到 50 秒', F.humanGap(30 * 1000), '刚刚');
eq('humanGap 分钟', F.humanGap(3 * MIN), '3分钟');
eq('humanGap 小时', F.humanGap(5 * 3600 * 1000), '5小时');
eq('humanGap 天', F.humanGap(3 * DAY), '3天');
eq('humanGap 个月', F.humanGap(95 * DAY), '3个月');
eq('humanGap 负数是绝对值', F.humanGap(-2 * DAY), '2天');

// ---------- 倒计时文案 ----------
eq('倒计时不到 1 分钟', F.countdownText(30 * 1000), '不到 1 分钟后');
eq('倒计时 14:59 向上取整', F.countdownText(14.98 * MIN), '15 分钟后');
eq('倒计时 2 小时', F.countdownText(2 * 3600 * 1000), '2 小时后');
eq('倒计时 23 小时还是报小时', F.countdownText(DAY * 0.94), '23 小时后');
eq('倒计时接近一天就报 1 天', F.countdownText(DAY * 0.96), '1 天后');
eq('倒计时 11 天取整', F.countdownText(11 * DAY), '11 天后');

// ---------- 时长文案 ----------
eq('minutesText 分钟', F.minutesText(90), '2<small>分钟</small>');
eq('minutesText 小时', F.minutesText(3600), '1<small>小时</small>');
eq('hoursText 不足一小时', F.hoursText(1800), '30<small>分钟</small>');
eq('hoursText 超过一小时', F.hoursText(5400), '1.5<small>小时</small>');
eq('durationLabel 分钟', F.durationLabel(45), '45 分钟');
eq('durationLabel 整小时', F.durationLabel(120), '2 小时');
eq('durationLabel 带零头', F.durationLabel(135), '2 小时 15 分');

// ---------- 月度序列 ----------
// 固定一个「过去的月份」，不受今天是几号影响
const pts = F.monthSeries('2026-10', (k) => k.slice(-2));
eq('monthSeries 覆盖整月', pts.length, 31);
eq('monthSeries 第一天', pts[0].k, '2026-10-01');
eq('monthSeries 最后一天', pts[pts.length - 1].k, '2026-10-31');
eq('monthSeries 的值来自回调', pts[4].v, '05');

const thisMonth = F.todayKey().slice(0, 7);
const live = F.monthSeries(thisMonth, () => 0);
eq('当月只画到今天', live.length, Number(F.todayKey().slice(8, 10)));
eq('未来日期不出现', live.every((p) => p.k <= F.todayKey()), 'true');

// ---------- 月份加减 ----------
eq('shiftMonthKey 上个月', F.shiftMonthKey('2026-01', -1), '2025-12');
eq('shiftMonthKey 下个月', F.shiftMonthKey('2026-12', 1), '2027-01');
eq('shiftMonthKey 原地', F.shiftMonthKey('2026-07', 0), '2026-07');

console.log(fails ? '\n有 ' + fails + ' 项没过' : '\n全部通过');
process.exit(fails ? 1 : 0);
