/* ============================================================
   Review Words · 日期、时长与文案格式化
   全是纯函数，不碰 DOM、不碰存储，所以单独一个文件放、也方便写单测。
   从 app.js 挪出来的（原来散在日期区、取词区、统计区三段）。

   浏览器里挂到 window.RWFormat；Node 里能直接 require。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN = 60000;
  var DAY = 86400000;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // 时间戳 → 本地日期键（今天的键和 todayKey 一致）
  function dayKeyOf(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function mmss(sec) {
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
  }

  // 「3 分钟前」「2 天后」这类相对时间，给复习提示用
  function humanGap(ms) {
    var a = Math.abs(ms);
    var s = Math.round(a / 1000);
    if (s < 50) return '刚刚';
    var m = Math.round(s / 60);
    if (m < 60) return m + '分钟';
    var h = Math.round(m / 60);
    if (h < 24) return h + '小时';
    var d = Math.round(h / 24);
    if (d < 30) return d + '天';
    return Math.round(d / 30) + '个月';
  }

  // 倒计时文案：向上取整，免得 14:59 显示成「15 分钟」
  function countdownText(ms) {
    if (ms < MIN) return '不到 1 分钟后';
    if (ms < 60 * MIN) return Math.ceil(ms / MIN) + ' 分钟后';
    // 差一点点不到一整天就报「1 天后」，别出现「24 小时后」这种别扭说法
    if (ms < DAY * 0.95) return Math.ceil(ms / (60 * MIN)) + ' 小时后';
    var d = ms / DAY;
    return (d < 10 ? Math.ceil(d * 10) / 10 : Math.ceil(d)) + ' 天后';
  }

  // 统计页的数字文案（返回带 <small> 的 HTML 片段）
  function minutesText(sec) {
    var m = Math.round((sec || 0) / 60);
    if (m < 60) return m + '<small>分钟</small>';
    return (Math.round(m / 6) / 10) + '<small>小时</small>';
  }

  function hoursText(sec) {
    var m = Math.round((sec || 0) / 60);
    if (m < 60) return m + '<small>分钟</small>';
    var h = m / 60;
    return (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)) + '<small>小时</small>';
  }

  function durationLabel(mins) {
    mins = Math.round(mins || 0);
    if (mins < 60) return mins + ' 分钟';
    var h = Math.floor(mins / 60), rest = mins % 60;
    return h + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
  }

  // 把某个自然月拆成一天一个点；当月只画到今天，未来的日子不画
  function monthSeries(month, valueOf) {
    var y = Number(month.slice(0, 4));
    var m = Number(month.slice(5, 7));
    var days = new Date(y, m, 0).getDate();
    var today = todayKey();
    var out = [];
    for (var i = 1; i <= days; i++) {
      var k = month + '-' + pad(i);
      if (k > today) break;
      out.push({ k: k, v: valueOf(k) });
    }
    return out;
  }

  function shiftMonthKey(key, delta) {
    var y = Number(key.slice(0, 4));
    var m = Number(key.slice(5, 7)) - 1 + delta;
    var d = new Date(y, m, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  return {
    MIN: MIN,
    DAY: DAY,
    pad: pad,
    todayKey: todayKey,
    dayKeyOf: dayKeyOf,
    mmss: mmss,
    humanGap: humanGap,
    countdownText: countdownText,
    minutesText: minutesText,
    hoursText: hoursText,
    durationLabel: durationLabel,
    monthSeries: monthSeries,
    shiftMonthKey: shiftMonthKey
  };
});
