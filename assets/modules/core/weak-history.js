/* ============================================================
   Review Words · 薄弱词历史（按日期）
   复习日志只记「几点几分评了几分」，不知道是哪个词；
   这个文件专门回答「某天哪些词没记住」。

   键名：reviewwords.weakhis.<词书 id>.<YYYY-MM>
   结构：{ "27": { "abandon": [忘了次数, 模糊次数], "vague": [0, 2] } }
         —— 按天分桶、按月分键，一个月通常几 KB，不会撑大词书那个 JSON。

   只记「忘了（1）」「模糊（2）」，点「熟悉」不记。

   浏览器里挂到 window.RWWeakHistory；Node 里能直接 require。
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWWeakHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var FALLBACK_PREFIX = 'reviewwords.weakhis.';
  var MAX_DAYS = 400;            // 一个月最多 31 天，留足余量
  var MAX_WORDS = 2000;          // 一天最多记这么多词，防止异常数据撑爆

  function store() {
    if (root.RWStore) return root.RWStore;
    if (typeof require === 'function') {
      try { return require('./store.js'); } catch (e) { /* 下面统一处理 */ }
    }
    return null;
  }

  function prefix() {
    var S = store();
    return (S && S.KEYS && S.KEYS.weakHistoryPrefix) || FALLBACK_PREFIX;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function monthOf(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function dayOf(ts) {
    var d = new Date(ts || Date.now());
    return monthOf(ts) + '-' + pad(d.getDate());
  }

  function keyOf(bookId, month) {
    return prefix() + String(bookId || 'default') + '.' + (month || monthOf());
  }

  function monthData(bookId, month) {
    var S = store();
    if (!S) return {};
    var data = S.get(keyOf(bookId, month), {});
    return (data && typeof data === 'object') ? data : {};
  }

  // 记一次「忘了 / 模糊」：grade 1 → 忘了 +1，grade 2 → 模糊 +1
  function add(bookId, word, grade, at) {
    var S = store();
    var w = String(word || '').trim();
    if (!S || !w || (grade !== 1 && grade !== 2)) return { ok: false };

    var ts = at || Date.now();
    var month = monthOf(ts);
    var day = pad(new Date(ts).getDate());
    var data = monthData(bookId, month);
    var bucket = data[day] || (data[day] = {});
    var row = bucket[w] || (bucket[w] = [0, 0]);
    if (grade === 1) row[0] += 1; else row[1] += 1;

    // 防异常数据：日子太多或某天词太多就丢最老的
    var days = Object.keys(data);
    if (days.length > MAX_DAYS) {
      days.sort();
      delete data[days[0]];
    }
    var words = Object.keys(bucket);
    if (words.length > MAX_WORDS) return { ok: false };

    S.set(keyOf(bookId, month), data);
    return { ok: true, day: day, word: w };
  }

  // 某一天：返回按（忘了数 + 模糊数）从多到少、同数按字母排的词表
  function day(bookId, dayKey) {
    var key = dayKey || dayOf();
    var month = key.slice(0, 7);
    var dayNum = key.slice(8, 10);
    var bucket = monthData(bookId, month)[dayNum] || {};
    return Object.keys(bucket).map(function (w) {
      var r = bucket[w] || [0, 0];
      return { word: w, forgot: Number(r[0]) || 0, fuzzy: Number(r[1]) || 0 };
    }).sort(function (a, b) {
      var d = (b.forgot + b.fuzzy) - (a.forgot + a.fuzzy);
      return d !== 0 ? d : a.word.localeCompare(b.word);
    });
  }

  // 某个月：{ "27": 8, "26": 3 } —— 日历色块用，只要数量
  function monthCounts(bookId, month) {
    var data = monthData(bookId, month);
    var out = {};
    Object.keys(data).forEach(function (d) {
      out[d] = Object.keys(data[d] || {}).length;
    });
    return out;
  }

  // 这些词在这个月的哪些天出现过：返回 ['2026-11-26', ...]，日历上要给它们做标记
  function daysContaining(bookId, month, words) {
    var data = monthData(bookId, month);
    var want = {};
    (words || []).forEach(function (w) { want[String(w)] = true; });
    var out = [];
    Object.keys(data).forEach(function (day) {
      var bucket = data[day] || {};
      for (var w in bucket) {
        if (want[w]) { out.push(month + '-' + day); return; }
      }
    });
    return out;
  }

  // 某个月里有记录的天数
  function daysWithData(bookId, month) {
    return Object.keys(monthCounts(bookId, month)).length;
  }

  // 升级前的历史：每条记录只留了「最后一次评价」，按那天回填一次就够
  // 调用方负责只回填一次（用 db.whBackfilled 标记）
  function backfill(bookId, records) {
    var n = 0;
    Object.keys(records || {}).forEach(function (w) {
      var r = records[w] || {};
      if ((r.last === 1 || r.last === 2) && r.lastAt) {
        add(bookId, w, r.last, r.lastAt);
        n++;
      }
    });
    return n;
  }

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
    keyOf: keyOf,
    monthOf: monthOf,
    dayOf: dayOf,
    add: add,
    day: day,
    monthCounts: monthCounts,
    daysContaining: daysContaining,
    daysWithData: daysWithData,
    backfill: backfill,
    clearBook: clearBook
  };
});
