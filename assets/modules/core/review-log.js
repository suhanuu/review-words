/* ============================================================
   Review Words · 复习日志
   每次评分追加一条，用来回答“这段时间到底复习了多少、忘了多少、平均隔几天”。
   和词书记录分开放：词书那个 JSON 越写越大，日志单独按月一个键，
   写坏了也不会连累学习记录。

   键名：reviewwords.revlog.<词书 id>.<YYYY-MM>
   每条： [时间戳, 评价(1 忘了 / 2 模糊 / 3 熟悉), 这次排到的间隔天数]
         —— 用数组而不是对象，一条大约 25 字节，一年几千条也才几十 KB。

   上限：每个月最多 3000 条，超了丢最老的（正常人一个月到不了这个量）。

   数据只读回头看，不参与排期：调度仍然只看词书记录里的 FSRS 卡片。
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DAY = 86400000;
  var MAX_ROWS = 3000;
  var FALLBACK_PREFIX = 'reviewwords.revlog.';

  function store() {
    if (root.RWStore) return root.RWStore;
    if (typeof require === 'function') {
      try { return require('./store.js'); } catch (e) { /* 下面统一处理 */ }
    }
    return null;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // 本地时间：词是按「自然日」算的，别用 UTC 切
  function monthOf(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function dayOf(ts) {
    var d = new Date(ts || Date.now());
    return monthOf(ts) + '-' + pad(d.getDate());
  }

  // 键名前缀记在 store.js 的键名表里，这里跟着走
  function prefix() {
    var S = store();
    return (S && S.KEYS && S.KEYS.reviewLogPrefix) || FALLBACK_PREFIX;
  }

  function keyOf(bookId, month) {
    return prefix() + String(bookId || 'default') + '.' + (month || monthOf());
  }

  function list(bookId, month) {
    var S = store();
    if (!S) return [];
    var rows = S.get(keyOf(bookId, month), []);
    return Array.isArray(rows) ? rows : [];
  }

  function append(bookId, grade, nextMs, at) {
    var S = store();
    if (!S) return { ok: false };
    var ts = at || Date.now();
    var month = monthOf(ts);
    var rows = list(bookId, month);
    var days = Math.round((Number(nextMs) || 0) / (DAY / 100)) / 100;   // 两位小数够了
    rows.push([ts, Number(grade) || 3, days]);
    if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
    var res = S.set(keyOf(bookId, month), rows);
    return { ok: !!res.ok, count: rows.length };
  }

  function statsOf(rows) {
    var forgot = 0, graded = 0, sumDays = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] === 1) forgot++;
      if (rows[i][1] !== 1) { sumDays += Number(rows[i][2]) || 0; graded++; }
    }
    return {
      count: rows.length,
      forgot: forgot,
      rate: rows.length ? forgot / rows.length : 0,
      avgDays: graded ? sumDays / graded : 0
    };
  }

  function stats(bookId, month) { return statsOf(list(bookId, month)); }

  function dayStats(bookId, day) {
    var key = day || dayOf();
    var rows = list(bookId, key.slice(0, 7)).filter(function (r) { return dayOf(r[0]) === key; });
    return statsOf(rows);
  }

  // 最近 n 天每天的评价条数（给以后画小图用，现在先留着）
  function recent(bookId, days, now) {
    days = days || 7;
    now = now || Date.now();
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var t = now - i * DAY;
      var k = dayOf(t);
      out.push({ day: k, count: list(bookId, k.slice(0, 7)).filter(function (r) { return dayOf(r[0]) === k; }).length });
    }
    return out;
  }

  // 「重新学习」这本书时把它的日志一起清掉（别的书不动）
  function clearBook(bookId) {
    var S = store();
    if (!S) return 0;
    var head = prefix() + String(bookId || 'default') + '.';
    var keys = S.entries(function (k) { return String(k).indexOf(head) === 0; });
    keys.forEach(function (it) { S.remove(it.key); });
    return keys.length;
  }

  return {
    prefix: prefix,
    MAX_ROWS: MAX_ROWS,
    keyOf: keyOf,
    monthOf: monthOf,
    dayOf: dayOf,
    list: list,
    append: append,
    stats: stats,
    dayStats: dayStats,
    recent: recent,
    clearBook: clearBook
  };
});
