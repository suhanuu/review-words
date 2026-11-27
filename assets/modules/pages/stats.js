/* ============================================================
   Review Words · 统计与图表
   从 app.js 拆出来的统计页：
     · 四个数字卡（今日/累计单词、今日/累计时长）
     · 背词与打字的月度柱状图、当月折线浮层、图上的数值提示
     · 打字成绩汇总与打字记录页
     · 复习日志那一排（今日/本月评价、忘了占比、平均间隔）

   外面交给它这几样（ctx）：
     el(id) / setView(name)      取元素、切页面
     db()                        当前词书的 { records, days, settings }
     bookId()                    当前词书 id（复习日志按书分键）
     store / keys / log          core/store.js、键名表、core/review-log.js
     fmt                         core/format.js（日期和文案）
     watchFlush()                先把还没结算的学习时长记上
     masteredTotal()             「曾经很熟」的累计词数

   页面里的读写全部通过 ctx，模块自己不碰 localStorage、不自己算排期。
   ============================================================ */
window.RWStats = {
  create: function (ctx) {
    'use strict';

    function data() { return ctx.db(); }

  // ================= 统计 =================
  // 背词区只看四个数：今日/累计背熟了多少词、今天/一共学了多久。
  // 「背熟」= 连续熟悉 3 次（rec.masteredAt 记第一次达到的时刻，所以累计只增不减）。
  // 时长走学习页的秒表（watchBegin / watchEnd），不是按每个词累加。
  function statSecondsOn(key) {
    var d = data().days[key];
    return d ? (d.seconds || 0) : 0;
  }

  function statSecondsTotal() {
    var s = 0;
    Object.keys(data().days).forEach(function (k) { s += data().days[k].seconds || 0; });
    return s;
  }

  // 某一天：新学完成几个、很熟之后又复习了几个，加起来就是当天的「今日单词」
  function dayStats(key) {
    var learned = 0, reviewed = 0;
    Object.keys(data().records).forEach(function (k) {
      var r = data().records[k];
      if (!r.masteredAt) return;
      if (ctx.fmt.dayKeyOf(r.masteredAt) === key) { learned++; return; }
      if (r.lastAt && ctx.fmt.dayKeyOf(r.lastAt) === key) reviewed++;
    });
    return { learned: learned, reviewed: reviewed, total: learned + reviewed };
  }

  function todayDoneCount() {
    return dayStats(ctx.fmt.todayKey()).total;
  }

  // 每天完成了几个词（新学的 + 那天复习过的）
  function doneByDay() {
    var map = {};
    var add = function (ts) {
      var k = ctx.fmt.dayKeyOf(ts);
      map[k] = (map[k] || 0) + 1;
    };
    Object.keys(data().records).forEach(function (k) {
      var r = data().records[k];
      if (!r.masteredAt) return;
      add(r.masteredAt);
      if (r.lastAt && ctx.fmt.dayKeyOf(r.lastAt) !== ctx.fmt.dayKeyOf(r.masteredAt)) add(r.lastAt);
    });
    return map;
  }

  function dailyGoal() {
    var n = Number(data().settings.dailyGoal);
    return n > 0 ? Math.round(n) : 10;
  }




  function renderStats() {
    ctx.watchFlush();                       // 先把还没结算的这段时长算进去
    var today = ctx.fmt.todayKey();
    if (!wordMonth) wordMonth = today.slice(0, 7);
    var month = wordMonth;

    ctx.el('statWordsToday').textContent = todayDoneCount();
    ctx.el('statWordsTotal').textContent = ctx.masteredTotal();
    ctx.el('statTimeToday').innerHTML = ctx.fmt.minutesText(statSecondsOn(today));
    ctx.el('statTimeTotal').innerHTML = ctx.fmt.hoursText(statSecondsTotal());

    var map = doneByDay();
    var pts = ctx.fmt.monthSeries(month, function (k) { return map[k] || 0; });
    ctx.el('wordsMonth').textContent = Number(month.slice(5, 7)) + ' 月';
    var atCurrent = month >= today.slice(0, 7);
    document.querySelectorAll('[data-month-for="words"]').forEach(function (b) {
      b.disabled = atCurrent && Number(b.dataset.monthStep) > 0;
    });
    ctx.el('wordsLatest').textContent = pts.length ? pts[pts.length - 1].v + ' 个' : '';
    renderChart(document.querySelector('.chart[data-series="words"]'), pts, 0, 'var(--ok)', ' 个');

    renderReviewLog();
    renderTypingZone();
  }

  // 复习日志（core/review-log.js）：这本词书今天/本月评价了多少次、忘了多少、平均隔几天。
  // 和上面的「今日单词」不是一回事：同一个词今天评价三次就记三次，看的是练习强度。
  function renderReviewLog() {
    var today = ctx.fmt.todayKey();
    var d = ctx.log.dayStats(ctx.bookId(), today);
    var m = ctx.log.stats(ctx.bookId(), today.slice(0, 7));
    if (ctx.el('revlogToday')) ctx.el('revlogToday').textContent = d.count;
    if (ctx.el('revlogMonth')) ctx.el('revlogMonth').textContent = m.count;
    if (ctx.el('revlogForgot')) ctx.el('revlogForgot').innerHTML = (m.count ? Math.round(m.rate * 100) : 0) + '<small>%</small>';
    if (ctx.el('revlogGap')) ctx.el('revlogGap').innerHTML = (m.count ? Math.round(m.avgDays * 10) / 10 : 0) + '<small>天</small>';
  }

  // ---------- 当月折线浮层 ----------
  var popKind = 'words';
  var popMonth = '';
  var wordMonth = '';     // 统计页背词图在看哪个月
  var typingMonth = '';   // 统计页打字图在看哪个月


  function openMonthPop(kind) {
    popKind = kind;
    popMonth = ctx.fmt.todayKey().slice(0, 7);
    ctx.el('monthPop').hidden = false;
    renderMonthPop();
  }

  function closeMonthPop() {
    ctx.el('monthPop').hidden = true;
  }

  function shiftMonth(delta) {
    var y = Number(popMonth.slice(0, 4));
    var m = Number(popMonth.slice(5, 7)) - 1 + delta;
    var d = new Date(y, m, 1);
    var next = d.getFullYear() + '-' + ctx.fmt.pad(d.getMonth() + 1);
    if (next > ctx.fmt.todayKey().slice(0, 7)) return;   // 未来没有数据，不许翻
    popMonth = next;
    renderMonthPop();
  }

  function renderMonthPop() {
    var isWords = popKind === 'words';
    var map = isWords ? doneByDay() : null;
    var pts = ctx.fmt.monthSeries(popMonth, function (k) {
      return isWords ? (map[k] || 0) : Math.round(statSecondsOn(k) / 60);
    });

    ctx.el('monthPopTitle').textContent = isWords ? '单词/个' : '时间/分钟';
    ctx.el('monthLabel').textContent = Number(popMonth.slice(5, 7)) + ' 月';
    ctx.el('monthPopSub').textContent = popMonth.replace('-', ' 年 ') + ' 月';
    ctx.el('monthNext').disabled = popMonth >= ctx.fmt.todayKey().slice(0, 7);

    var total = 0, best = null;
    pts.forEach(function (p) {
      total += p.v;
      if (!best || p.v > best.v) best = p;
    });
    var avg = pts.length ? Math.round((total / pts.length) * 10) / 10 : 0;

    ctx.el('monthPopFoot').innerHTML =
      '<span>合计 <b>' + (isWords ? total + ' 个' : ctx.fmt.durationLabel(total)) + '</b></span>' +
      '<span>日均 <b>' + avg + (isWords ? ' 个' : ' 分钟') + '</b></span>' +
      '<span>最高 <b>' + (best && best.v ? best.k.slice(5) + ' · ' + best.v + (isWords ? ' 个' : ' 分钟') : '—') + '</b></span>';

    renderChart(ctx.el('monthPopChart'), pts, 0, isWords ? 'var(--ok)' : 'var(--accent)', isWords ? ' 个' : ' 分钟');
  }

  // ---------- 打字成绩（英/中分开） ----------
  var typingTab = 'en';
  var histLang = 'all';

  function typingRecords() {
    var raw = ctx.store.get(ctx.keys.typingRecords, []);
    return Array.isArray(raw) ? raw : [];
  }

  function recordSpeed(x) {
    if (typeof x.speed === 'number') return x.speed;
    return x.wpm || 0;
  }

  function typingFor(lang) {
    return typingRecords().filter(function (x) { return (x.lang || 'en') === lang; });
  }

  function renderTypingZone() {
    var list = typingFor(typingTab);
    var n = list.length, sumSpeed = 0, sumAcc = 0, sumErr = 0;
    list.forEach(function (x) {
      sumSpeed += recordSpeed(x);
      sumAcc += x.accuracy || 0;
      sumErr += x.errors || 0;
    });

    var unit = typingTab === 'en' ? 'WPM' : '字/分';
    ctx.el('typingSessions').textContent = n;
    ctx.el('typingAvgSpeed').innerHTML = (n ? Math.round(sumSpeed / n) : 0) + '<small>' + unit + '</small>';
    ctx.el('typingAvgAcc').innerHTML = (n ? Math.round(sumAcc / n * 100) : 0) + '<small>%</small>';
    ctx.el('typingTotalErrors').textContent = sumErr;
    ctx.el('typingChartUnit').textContent = unit;

    // 当月每天的平均速度（这天没练就不画点）
    var today = ctx.fmt.todayKey();
    if (!typingMonth) typingMonth = today.slice(0, 7);
    var month = typingMonth;
    var byDay = {};
    list.forEach(function (x) {
      if (!x.date || x.date.slice(0, 7) !== month) return;
      (byDay[x.date] = byDay[x.date] || []).push(recordSpeed(x));
    });
    ctx.el('typingMonth').textContent = Number(month.slice(5, 7)) + ' 月';
    var atCurrent = month >= today.slice(0, 7);
    document.querySelectorAll('[data-month-for="typing"]').forEach(function (b) {
      b.disabled = atCurrent && Number(b.dataset.monthStep) > 0;
    });
    var pts = ctx.fmt.monthSeries(month, function (k) {
      var arr = byDay[k];
      if (!arr || !arr.length) return null;   // 这天没练就不画点，别补 0
      var s = 0;
      arr.forEach(function (v) { s += v; });
      return Math.round(s / arr.length);
    });
    var last = 0;
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i].v != null) { last = pts[i].v; break; }
    }
    ctx.el('typingLatest').textContent = last ? last + ' ' + unit : '';
    renderChart(ctx.el('typingChart'), pts, 0, 'var(--accent)', ' ' + unit);
  }

  // ---------- 打字练习记录页 ----------
  function openTypingHistory() {
    ctx.setView('typing-history');
    renderTypingHistory();
  }

  function renderTypingHistory() {
    var host = ctx.el('typingHistoryList');
    if (!host) return;
    var all = typingRecords().slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    var list = histLang === 'all' ? all : all.filter(function (x) { return (x.lang || 'en') === histLang; });

    var en = 0, zh = 0;
    all.forEach(function (x) { if ((x.lang || 'en') === 'zh') zh++; else en++; });
    ctx.el('typingHistSum').textContent = '共 ' + all.length + ' 次 · 英文 ' + en + ' · 中文 ' + zh;

    if (!list.length) {
      host.innerHTML = '<p class="typing-hist-empty">还没有练习记录，去作文训练练一篇试试。</p>';
      return;
    }

    var html = '';
    var lastDay = '';
    list.forEach(function (x) {
      var day = x.date || '';
      if (day !== lastDay) {
        lastDay = day;
        html += '<div class="typing-hist-day">' + (day === ctx.fmt.todayKey() ? '今天' : day.slice(5)) + '</div>';
      }
      var d = new Date(x.at || 0);
      var pad2 = function (v) { return (v < 10 ? '0' : '') + v; };
      var time = x.at ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '';
      var lang = (x.lang || 'en') === 'zh' ? 'zh' : 'en';
      var unit = lang === 'zh' ? '字/分' : 'WPM';
      var sec = Math.round((x.durationMs || 0) / 1000);
      var dur = sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒';
      html += '<div class="typing-hist-row">' +
        '<div class="typing-hist-left">' +
          (time ? '<span class="typing-hist-time">' + time + '</span>' : '') +
          '<span class="typing-hist-lang ' + lang + '">' + (lang === 'zh' ? '中文' : '英文') + '</span>' +
          '<span class="typing-hist-dur">练了 ' + dur + '</span>' +
        '</div>' +
        '<div class="typing-hist-right">' +
          '<span><b>' + recordSpeed(x) + '</b> ' + unit + '</span>' +
          '<span>准确 <b>' + Math.round((x.accuracy || 0) * 100) + '%</b></span>' +
          '<span>差异 <b>' + (x.errors || 0) + '</b> 处</span>' +
        '</div>' +
      '</div>';
    });
    host.innerHTML = html;
  }

  var chartSeq = 0;

  // 纵轴刻度：步长取 1/2/5 ×10ⁿ 里第一个够用的整数档，顶端补到步长的整数倍。
  // 关键是「刻度线画在它标的值上」——以前标签是按比例四舍五入的，
  // 标着 2 的那条线其实在 1.77，点看起来就浮在线外面。
  function chartScale(dataMax, fixedMax) {
    if (fixedMax) {
      return {
        top: fixedMax,
        step: fixedMax / 2,
        fmt: function (v) { return Math.round(v); }
      };
    }
    var top0 = Math.max(dataMax * 1.1, 1);
    var raw = top0 / 4;
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / pow;
    var step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
    var top = Math.max(step, Math.ceil(top0 / step) * step);
    return {
      top: top,
      step: step,
      fmt: function (v) { return step >= 1 ? Math.round(v) : Math.round(v * 10) / 10; }
    };
  }

  function renderChart(host, pts, fixedMax, color, unit) {
    if (!host) return;
    if (!pts.length) {
      host.innerHTML = '<div class="empty-note">还没有数据，先练几个词</div>';
      return;
    }

    var gid = 'chartGrad' + (++chartSeq);
    // 按宿主的真实尺寸出图：一屏布局下图表高度是「剩余空间」，
    // 固定 640x150 的 viewBox 会被拉伸或留白。
    var W = Math.max(260, Math.round(host.clientWidth || 640));
    var H = Math.max(74, Math.round(host.clientHeight || 150));
    var PL = 40, PR = 14;
    var PT = Math.min(16, Math.round(H * 0.12)) + 2;
    var PB = Math.min(26, Math.round(H * 0.18)) + 2;
    var iw = W - PL - PR, ih = Math.max(20, H - PT - PB);

    var dataMax = 0;
    pts.forEach(function (p) { if (p.v != null && p.v > dataMax) dataMax = p.v; });
    var scale = chartScale(dataMax, fixedMax);
    var maxV = scale.top;
    var X = function (i) { return pts.length === 1 ? PL + iw / 2 : PL + (iw * i) / (pts.length - 1); };
    var Y = function (v) { return PT + ih - (Math.min(v, maxV) / maxV) * ih; };

    // v 为 null 表示那天没数据：跳过这个点，线从两端直接连过去，不补假的 0
    var seq = [];
    pts.forEach(function (p, i) {
      if (p.v != null) seq.push({ i: i, v: p.v });
    });
    if (!seq.length) {
      host.innerHTML = '<div class="empty-note">还没有数据，先练几个词</div>';
      return;
    }

    var line = '';
    seq.forEach(function (q, k) {
      line += (k ? 'L' : 'M') + X(q.i).toFixed(1) + ' ' + Y(q.v).toFixed(1) + ' ';
    });
    var area = line + 'L' + X(seq[seq.length - 1].i).toFixed(1) + ' ' + (PT + ih) +
      ' L' + X(seq[0].i).toFixed(1) + ' ' + (PT + ih) + ' Z';

    var dots = seq.map(function (q) {
      return '<circle cx="' + X(q.i).toFixed(1) + '" cy="' + Y(q.v).toFixed(1) +
        '" r="2.7" fill="var(--surface)" stroke="' + color + '" stroke-width="1.6" />';
    }).join('');
    var grid = '';
    for (var gv = 0; gv <= maxV + 1e-6; gv += scale.step) {
      var gy = Y(gv);
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy +
        '" stroke="var(--line)" stroke-width="1" />';
      grid += '<text x="' + (PL - 8) + '" y="' + (gy + 4) + '" text-anchor="end" ' +
        'font-size="10" font-family="ui-monospace, Menlo, Consolas, monospace" fill="var(--faint)">' +
        scale.fmt(gv) + '</text>';
    }

    var labels = '';
    var step = pts.length > 1 ? Math.ceil(pts.length / 5) : 1;
    var idxs = [];
    pts.forEach(function (p, i) {
      if (i % step === 0 || i === pts.length - 1) idxs.push(i);
    });
    // 图变窄时最后一天会和前一个刻度贴在一起，挤不下就只留最后一天
    if (idxs.length > 1) {
      var lastI = idxs[idxs.length - 1], prevI = idxs[idxs.length - 2];
      if (X(lastI) - X(prevI) < 42) idxs.splice(idxs.length - 2, 1);
    }
    idxs.forEach(function (i) {
      labels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" ' +
        'font-size="10" font-family="ui-monospace, Menlo, Consolas, monospace" fill="var(--faint)">' +
        pts[i].k.slice(5) + '</text>';
    });

    host.__chart = {
      pts: pts,
      X: X,
      Y: Y,
      pl: PL,
      iw: iw,
      unit: unit || ''
    };
    if (!host.__tipBound) {
      host.__tipBound = true;
      // 桌面：鼠标划过就跟着走；手机：点一下显示，点别处收起来
      host.addEventListener('pointermove', function (ev) {
        if (ev.pointerType === 'mouse') showChartTip(host, ev);
      });
      host.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse') return;
        showChartTip(host, ev);
      });
      host.addEventListener('pointerleave', function (ev) {
        if (ev.pointerType === 'mouse') hideChartTip(host);
      });
    }

    host.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
      'style="width:100%;height:100%;display:block">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.11" />' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0" />' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + gid + ')" />' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round" />' +
      dots + labels +
      '<circle class="chart-cursor" cx="0" cy="0" r="3.8" fill="none" stroke="' + color +
      '" stroke-width="2" opacity="0" />' +
      '</svg>';
  }

  // 图上悬停：吸到最近的那一天，显示日期和值
  function showChartTip(host, ev) {
    var c = host.__chart;
    if (!c || !c.pts.length) return;
    var rect = host.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var n = c.pts.length;
    var i = n === 1 ? 0 : Math.round((x - c.pl) / c.iw * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));

    var p = c.pts[i];
    if (p.v == null) { hideChartTip(host); return; }
    var px = c.X(i), py = c.Y(p.v);
    var tip = host.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      host.appendChild(tip);
    }
    tip.textContent = p.k.slice(5) + ' · ' + p.v + c.unit;
    tip.style.left = px + 'px';
    tip.style.top = Math.max(2, py - 9) + 'px';
    tip.classList.add('is-on');

    var cur = host.querySelector('.chart-cursor');
    if (cur) {
      cur.setAttribute('cx', px.toFixed(1));
      cur.setAttribute('cy', py.toFixed(1));
      cur.setAttribute('opacity', '1');
    }
  }

  function hideChartTip(host) {
    var tip = host.querySelector('.chart-tip');
    if (tip) tip.classList.remove('is-on');
    var cur = host.querySelector('.chart-cursor');
    if (cur) cur.setAttribute('opacity', '0');
  }

  function hideAllChartTips() {
    document.querySelectorAll('.chart-tip.is-on').forEach(function (t) { t.classList.remove('is-on'); });
    document.querySelectorAll('.chart-cursor').forEach(function (c) { c.setAttribute('opacity', '0'); });
  }

  // 窗口尺寸变化后图表要按新的剩余高度重新出图，否则 SVG 会被拉伸
  var chartResizeTimer = null;
  window.addEventListener('resize', function () {
    var vs = document.getElementById('view-stats');
    if (!vs || !vs.classList.contains('is-active')) return;
    if (chartResizeTimer) clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(function () {
      if (vs.classList.contains('is-active')) {
        renderStats();
        if (!ctx.el('monthPop').hidden) renderMonthPop();
      }
    }, 160);
  });

    // 统计页自己的交互（点卡片弹当月、切月份、切英中、进打字记录）
    function bind() {
      // 统计页：点「今日单词 / 今日时长」弹当月折线
      document.querySelectorAll('#view-stats [data-pop]').forEach(function (card) {
        card.addEventListener('click', function () { openMonthPop(card.dataset.pop); });
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMonthPop(card.dataset.pop); }
        });
      });
      if (ctx.el('monthClose')) {
        ctx.el('monthClose').addEventListener('click', closeMonthPop);
        ctx.el('monthPop').addEventListener('click', function (e) {
          if (e.target && e.target.id === 'monthPop') closeMonthPop();
        });
        ctx.el('monthPrev').addEventListener('click', function () { shiftMonth(-1); });
        ctx.el('monthNext').addEventListener('click', function () { shiftMonth(1); });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && !ctx.el('monthPop').hidden) closeMonthPop();
        });
      }

      // 手机：点图以外的地方就把图上的数字提示收起来
      document.addEventListener('pointerdown', function (e) {
        var inChart = e.target && e.target.closest && e.target.closest('.chart, .month-pop-chart');
        if (!inChart) hideAllChartTips();
      }, true);

      // 统计页：两张主图各自的月份切换
      document.querySelectorAll('[data-month-for]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var step = Number(btn.dataset.monthStep) || 0;
          if (!step) return;
          var today = ctx.fmt.todayKey().slice(0, 7);
          if (btn.dataset.monthFor === 'typing') {
            var next = ctx.fmt.shiftMonthKey(typingMonth || today, step);
            if (next > today) return;
            typingMonth = next;
          } else {
            var nextW = ctx.fmt.shiftMonthKey(wordMonth || today, step);
            if (nextW > today) return;
            wordMonth = nextW;
          }
          renderStats();
        });
      });

      // 统计页：打字区英/中切换
      var typingSegBtns = document.querySelectorAll('#view-stats [data-typing-stat]');
      typingSegBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          typingTab = btn.dataset.typingStat === 'zh' ? 'zh' : 'en';
          typingSegBtns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
          renderTypingZone();
        });
      });

      // 点「练习次数」进打字记录页
      if (ctx.el('typingSessionsCard')) {
        ctx.el('typingSessionsCard').addEventListener('click', openTypingHistory);
        ctx.el('typingSessionsCard').addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTypingHistory(); }
        });
      }
      if (ctx.el('btnTypingHistoryBack')) {
        ctx.el('btnTypingHistoryBack').addEventListener('click', function () { ctx.setView('stats'); });
        var histBtns = document.querySelectorAll('[data-hist-lang]');
        histBtns.forEach(function (btn) {
          btn.addEventListener('click', function () {
            histLang = btn.dataset.histLang;
            histBtns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
            renderTypingHistory();
          });
        });
      }
    }

    return {
      bind: bind,
      renderStats: renderStats,
      renderTypingZone: renderTypingZone,
      renderTypingHistory: renderTypingHistory,
      openTypingHistory: openTypingHistory,
      openMonthPop: openMonthPop,
      closeMonthPop: closeMonthPop,
      shiftMonth: shiftMonth,
      hideAllChartTips: hideAllChartTips,
      dayStats: dayStats,
      todayDoneCount: todayDoneCount,
      dailyGoal: dailyGoal
    };
  }
};
