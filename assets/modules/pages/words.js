/* ============================================================
   Review Words · 词库（查词词典）
   从 app.js 拆出来的词库页：全量词典的懒加载、前匹配/中文释义搜索、
   首字母快捷条、滚到底续批、「加进词书」。

   词典本身 2.9MB（assets/dict.js），只在第一次进词库页时才拉，
   和学习页首屏无关。

   外面交给它（ctx）：
     el(id)          取元素
     db()            当前词书数据（判断「我的词书」列、写入自定义词条）
     allWords()      当前词书的全部词
     save()          落盘
     esc(s)          HTML 转义
     humanGap(ms)    「3 天后复习」这类文案
     HAN             中文正则
     extractAnswer(def)  从释义里抽出要打的中文
     invalidateWords()   词表变了，清掉 allWords 的缓存
     wordByKey()     小写 → 词条
   ============================================================ */
window.RWWords = {
  create: function (ctx) {
    'use strict';

  // ================= 词库：查词词典 =================
  // 和学习词书是两套数据：词库是给"查陌生词"用的全量词典（中考→考研，约 2.3 万词），
  // 第一次进词库页才去拉 assets/dict.js，不拖慢学习页首屏。
  // 搜索规则：
  //   纯英文 → 从词头开始匹配（前匹配），结果保持字母序
  //   含中文 → 释义里只要包含就算，按常用度排（最常见的在前）
  //   中英夹杂 → 英文按词头、中文按包含，两边都满足
  var DICT_SRC = 'assets/dict.js';
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var WORD_CHUNK = 120;
  var dictList = null;
  var dictReq = null;
  var wordFilter = '';
  var wordRows = [];
  var wordShown = 0;
  var wordBookMap = {};

  function ensureDict() {
    if (dictList) return Promise.resolve(dictList);
    if (!dictReq) {
      dictReq = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = DICT_SRC;
        s.onload = function () { dictList = window.WORD_DICT || []; resolve(dictList); };
        s.onerror = function () { dictList = []; resolve(dictList); };
        document.head.appendChild(s);
      });
    }
    return dictReq;
  }

  function dictItem(word) {
    if (!dictList) return null;
    var key = String(word || '').toLowerCase();
    for (var i = 0; i < dictList.length; i++) {
      if (String(dictList[i].w).toLowerCase() === key) return dictList[i];
    }
    return null;
  }

  // 当前词书里的词（小写 → 词条），判断「我的词书」那一列用
  function bookWordMap() {
    var map = {};
    ctx.allWords().forEach(function (w) { map[String(w.w).toLowerCase()] = w; });
    return map;
  }

  function wordBadge(w) {
    var r = ctx.db().records[w.w];
    if (!(r && r.seen > 0)) return '<span class="badge">未学</span>';
    var left = (r.dueAt || 0) - Date.now();
    if (left <= 0) return '<span class="badge bad">该复习了</span>';
    if (r.last === 1) return '<span class="badge bad">' + ctx.humanGap(left) + '后再来</span>';
    return '<span class="badge ok">' + ctx.humanGap(left) + '后复习</span>';
  }

  function dictRow(item) {
    var book = wordBookMap[String(item.w).toLowerCase()];
    var state = book
      ? wordBadge(book)
      : '<button class="row-add" type="button" data-w="' + ctx.esc(item.w) + '"' +
        ' title="把这个词加进当前词书，之后学习与复习里就能见到它">加进词书</button>';
    return '<tr data-w="' + ctx.esc(item.w) + '">' +
      '<td class="w">' + ctx.esc(item.w) + '</td>' +
      '<td class="p">' + ctx.esc(item.ph || '—') + '</td>' +
      '<td class="a" title="' + ctx.esc(item.d) + '">' + ctx.esc(item.d) + '</td>' +
      '<td class="s">' + state + '</td>' +
      '<td class="d"><button class="row-detail" type="button"' +
      ' data-w="' + ctx.esc(item.w) + '" title="音标、完整释义、词形变化">详细</button></td>' +
      '</tr>';
  }

  // 纯英文＝词头匹配；含中文＝释义包含（按常用度排）
  function dictSearch(query) {
    if (!dictList) return [];
    var q = String(query || '').trim();
    if (!q) return dictList;

    var i, it, out = [];

    if (!ctx.HAN.test(q)) {
      var lower = q.toLowerCase();
      for (i = 0; i < dictList.length; i++) {
        it = dictList[i];
        if (String(it.w).toLowerCase().indexOf(lower) === 0) out.push(it);
      }
      return out;                      // 词典本身按字母序排好，前缀结果天然有序
    }

    var eng = (q.match(/[A-Za-z][A-Za-z'’.\- ]*/g) || []).join(' ').trim().toLowerCase();
    var zh = q.replace(/[A-Za-z][A-Za-z'’.\- ]*/g, '').replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/g, '');

    var hits = [];
    for (i = 0; i < dictList.length; i++) {
      it = dictList[i];
      if (eng && String(it.w).toLowerCase().indexOf(eng) !== 0) continue;
      var at = zh ? String(it.d).indexOf(zh) : 0;
      if (zh && at < 0) continue;
      hits.push({ it: it, at: at });
    }

    // 排序：释义里越靠前说明这个意思越常用，再拿词频当第二权重。
    // 不这么排的话，搜「放弃」会先冒出 go / break 这种释义一长串的高频词。
    hits.sort(function (a, b) {
      var sa = a.at + (a.it.r ? Math.min(a.it.r, 30000) / 2000 : 15);
      var sb = b.at + (b.it.r ? Math.min(b.it.r, 30000) / 2000 : 15);
      return sa - sb;
    });

    return hits.map(function (h) { return h.it; });
  }

  function syncLetterBar() {
    var bar = ctx.el('letterBar');
    if (!bar) return;
    var q = String(wordFilter || '').trim().toLowerCase();
    var active = /^[a-z]$/.test(q) ? q.toUpperCase() : '';
    bar.querySelectorAll('.letter-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.letter === active);
    });
  }

  function buildLetterBar() {
    var bar = ctx.el('letterBar');
    if (!bar || bar.childNodes.length) return;
    bar.innerHTML = LETTERS.map(function (L) {
      return '<button class="letter-btn" type="button" data-letter="' + L + '">' + L + '</button>';
    }).join('');
    bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.letter-btn') : null;
      if (!b) return;
      var L = b.dataset.letter;
      var input = ctx.el('wordSearch');
      var same = String(wordFilter || '').trim().toLowerCase() === L.toLowerCase();
      input.value = same ? '' : L.toLowerCase();       // 再点一次同一个字母＝取消
      wordFilter = input.value;
      renderWords(true);
      if (!same) input.focus();
    });
  }

  function renderWords(reset) {
    if (!dictList) {
      ctx.el('wordCount').textContent = '词典加载中…';
      if (reset) {
        ctx.el('wordTableBody').innerHTML =
          '<tr><td class="dict-loading" colspan="5">正在加载词库（约 2 万词，首次打开需要几秒）…</td></tr>';
        var empty0 = ctx.el('dictEmpty');
        if (empty0) empty0.hidden = true;
      }
      ensureDict().then(function () { renderWords(true); });
      return;
    }

    if (reset) {
      wordRows = dictSearch(wordFilter);
      wordShown = 0;
      wordBookMap = bookWordMap();
      ctx.el('wordTableBody').innerHTML = '';
      var card = document.querySelector('#view-words .table-card');
      if (card) card.scrollTop = 0;
    }

    var slice = wordRows.slice(wordShown, wordShown + WORD_CHUNK);
    if (slice.length) {
      ctx.el('wordTableBody').insertAdjacentHTML('beforeend', slice.map(dictRow).join(''));
      wordShown += slice.length;
    }

    var q = String(wordFilter || '').trim();
    ctx.el('wordCount').textContent = q ? '命中 ' + wordRows.length + ' 词' : '共 ' + wordRows.length + ' 词';

    var empty = ctx.el('dictEmpty');
    if (empty) {
      empty.hidden = wordRows.length > 0;
      empty.textContent = wordRows.length ? '' : '没有找到「' + q + '」相关的词，换个词头或中文意思再试试。';
    }

    syncLetterBar();
  }

  // 滚到底自动续下一批：桌面端滚的是表格卡片，手机端滚的是页面
  function maybeMoreWords() {
    if (!wordRows.length || wordShown >= wordRows.length) return;
    var card = document.querySelector('#view-words .table-card');
    var near;
    if (card && card.scrollHeight > card.clientHeight + 8) {
      near = card.scrollTop + card.clientHeight >= card.scrollHeight - 360;
    } else {
      near = window.innerHeight + (window.pageYOffset || document.documentElement.scrollTop || 0) >=
        document.documentElement.scrollHeight - 360;
    }
    if (near) renderWords(false);
  }

  // 词库释义拿来当学习用的「要打出的中文」太长，只取第一个义项
  function dictMeaning(def) {
    var s = String(def || '');
    s = s.split(/[；;]/)[0];                          // 只留第一个词性
    s = s.replace(/^[a-z]{1,4}\.\s*/i, '');           // 去掉词性标记
    s = s.split(/[，,、\/]/)[0];                      // 只留第一个义项
    s = s.replace(/[^\u4e00-\u9fa5]/g, '');
    return s.slice(0, 12);
  }

  // 查到不认识的词，一键加进当前词书：之后学习和复习就会带上它
  function addWordToBook(word) {
    var it = dictItem(word);
    if (!it) return;
    var key = String(it.w).toLowerCase();
    var exists = ctx.allWords().some(function (w) { return String(w.w).toLowerCase() === key; });
    if (exists) return;

    ctx.db().custom.push({
      w: it.w,
      ph: it.ph || '',
      def: it.d,
      a: dictMeaning(it.d) || String(it.d).slice(0, 8)
    });
    ctx.save();
    ctx.invalidateWords();
    
    wordBookMap = bookWordMap();

    // 只换掉这一行的状态，别整张表重画把滚动位置带跑
    var rows = document.querySelectorAll('#wordTableBody tr');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.w === it.w) {
        var cell = rows[i].querySelector('.s');
        if (cell) cell.innerHTML = wordBadge(wordBookMap[key]);
        break;
      }
    }
  }

  function parseImport(text) {
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var out = [];

    lines.forEach(function (line) {
      var parts = line.split(/\s*[|｜\t]\s*/);
      if (parts.length < 2) parts = line.split(/\s*[,，]\s*/);
      if (parts.length < 2) return;

      var w = parts[0].trim();
      if (!/^[a-zA-Z][a-zA-Z' \-]*$/.test(w)) return;

      var ph = '', def = '';
      if (parts.length >= 3) {
        ph = parts[1].trim();
        def = parts.slice(2).join(' ').trim();
      } else {
        def = parts[1].trim();
      }

      var a = ctx.extractAnswer(def);
      if (!a) return;
      out.push({ w: w, ph: ph, def: def, a: a });
    });

    return out;
  }

    // 词库页自己的交互：首字母条、搜索框、两处滚动续批
    function bind() {
      // 词库：首字母快捷条 + 搜索 + 滚到底自动续批
      buildLetterBar();

      var searchTimer = null;
      var composing = false;
      ctx.el('wordSearch').addEventListener('compositionstart', function () { composing = true; });
      ctx.el('wordSearch').addEventListener('compositionend', function (e) {
        // 输入法上屏后再搜，避免拼音中途闪一堆空结果
        composing = false;
        wordFilter = e.target.value;
        clearTimeout(searchTimer);
        renderWords(true);
      });
      ctx.el('wordSearch').addEventListener('input', function (e) {
        wordFilter = e.target.value;
        if (composing) return;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { renderWords(true); }, 120);
      });

      // 桌面端滚的是表格卡片，手机端滚的是页面，两处都听
      var tableCard = document.querySelector('#view-words .table-card');
      if (tableCard) {
        tableCard.addEventListener('scroll', function () { maybeMoreWords(); }, { passive: true });
      }
      window.addEventListener('scroll', function () {
        var vw = ctx.el('view-words');
        if (vw && vw.classList.contains('is-active')) maybeMoreWords();
      }, { passive: true });
      window.addEventListener('resize', function () {
        var vw = ctx.el('view-words');
        if (vw && vw.classList.contains('is-active')) maybeMoreWords();
      });
    }

    return {
      bind: bind,
      renderWords: renderWords,
      maybeMoreWords: maybeMoreWords,
      buildLetterBar: buildLetterBar,
      ensureDict: ensureDict,
      dictItem: dictItem,
      dictMeaning: dictMeaning,
      addWordToBook: addWordToBook,
      parseImport: parseImport
    };
  }
};
