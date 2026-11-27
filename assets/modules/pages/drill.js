/* ============================================================
   Review Words · 背词页（学习流程）
   从 app.js 拆出来的核心链路：取词 → 看词自评 → 揭晓释义 → 下一个词。

   两个入口：
     学习  —— 今天批次里反复轮，攒满 3 次（MASTERED）就离开；
     复习  —— 很熟过、到期的词，评分交给 core/scheduler.js 的 FSRS-6。

   这一块只管流程和界面，判题规则全在 schedule.js / scheduler.js，
   今天的数字在 pages/today.js，键盘与手部在 drill/keyboard.js。
   ============================================================ */
window.RWDrill = {
  create: function (ctx) {
    'use strict';

    var el = ctx.el, state = ctx.state;
    var setView = ctx.setView, resetStaleBatch = ctx.resetStaleBatch;
    var reviewPool = ctx.reviewPool, todayBatch = ctx.todayBatch, ensureBatch = ctx.ensureBatch;
    var batchStats = ctx.batchStats, BATCH_SIZE = ctx.batchSize, nextDueIn = ctx.nextDueIn;
    var Stats = ctx.stats, Today = ctx.today, KB = ctx.kb, Favs = ctx.favs;
    var getRec = ctx.getRec, applyGrade = ctx.applyGrade, dayEntry = ctx.dayEntry;
    var MASTERED = ctx.mastered, DAY = ctx.day;
    var countdownText = ctx.fmt.countdownText, humanGap = ctx.fmt.humanGap, mmss = ctx.fmt.mmss;
    var todayKey = ctx.fmt.todayKey;
    var esc = ctx.esc, beep = ctx.beep, speak = ctx.speak;
    var prefetchDetail = ctx.prefetchDetail, preloadNext = ctx.preloadNext;

    // 秒表只服务背词页，跟着这一块走
    var timerId = null;
    var startedAt = Date.now();

  // ================= 学习流程 =================
  // 两个入口：学习（今天批次里反复轮，攒满 3 次就离开）/ 复习（很熟的到期词）
  function nextFromPool() {
    if (state.mode === 'review') {
      var due = reviewPool(Date.now());
      return due.length ? { w: due[0].w, mode: 'due' } : null;
    }
    if (!state.queue.length) {
      // 队列空了就把今天还没很熟的再收一遍，刷新之后也能接上
      state.queue = todayBatch();
    }
    var next = state.queue.shift();
    return next ? { w: next, mode: 'new' } : null;
  }

  function loadNext() {
    resetStaleBatch();     // 过了 12 点顺手把昨天的次数清零
    var pick = nextFromPool();
    if (!pick) { endSession(); return; }
    setView('drill');
    loadWord(pick.w, pick.mode);
  }

  function startLearn() {
    resetStaleBatch();
    state.mode = 'learn';
    state.queue = ensureBatch();
    if (!state.queue.length) { setView('today'); Today.renderToday(); return; }
    setView('drill');
    startTimer();
    loadNext();
  }

  function startReview() {
    resetStaleBatch();
    state.mode = 'review';
    setView('drill');
    startTimer();
    loadNext();
  }

  // 一轮结束：学习学完 / 复习清完，两套文案
  function endSession() {
    stopTimer();
    var d = dayEntry();
    var st = batchStats();
    var due = reviewPool(Date.now()).length;
    var nextAt = nextDueIn(Date.now());
    var sec = Math.round(d.seconds || 0);

    el('doneWords').textContent = d.words || 0;
    el('doneAcc').innerHTML = Stats.todayDoneCount() + '<small>个</small>';
    el('doneTime').innerHTML = Math.max(1, Math.round(sec / 60)) + '<small>分</small>';
    el('doneDue').innerHTML = due + '<small>个</small>';

    if (state.mode === 'review') {
      el('doneKicker').textContent = '复习清完了';
      el('doneTitle').textContent = nextAt
        ? '下一个词 ' + countdownText(nextAt) + '后回来'
        : '这本书暂时没有要复习的词了';
      setDonePrimary(due ? '继续复习' : '回今天', due ? 'review' : 'today');
    } else {
      el('doneKicker').textContent = '今天的新词学完了';
      el('doneTitle').textContent = (st.total || BATCH_SIZE) + ' 个今天都过了一遍';
      setDonePrimary(due ? '去复习 ' + due + ' 个' : '再学 10 个', due ? 'review' : 'learn');
    }

    state.current = null;
    state.phase = 'idle';
    setView('done');
  }

  function setDonePrimary(label, action) {
    var btn = el('btnDonePrimary');
    btn.textContent = label;
    btn.dataset.action = action;
    var alt = el('btnDoneToday');
    if (alt) alt.hidden = (action === 'today');
  }

  function startTimer() {
    stopTimer();
    el('drillTimer').textContent = '00:00';
    startedAt = Date.now();
    timerId = setInterval(function () {
      el('drillTimer').textContent = mmss(Math.floor((Date.now() - startedAt) / 1000));
      // 停在一个词上不动时，「下一词 3 分钟后」要跟着走秒，到点了也要翻成待复习
      Today.refreshDueStat();
    }, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  // ================= 学习时长秒表 =================
  // 「今天学了多久」按真实停留时间算：进学习页开始，离开页面、切走标签页、
  // 关页面就结算，每 30 秒也结算一次，避免崩了丢一大段。
  var watchStart = 0;

  function watchFlush() {
    if (!watchStart) return;
    var now = Date.now();
    var delta = (now - watchStart) / 1000;
    if (delta > 0) {
      dayEntry().seconds += delta;
      ctx.save();
    }
    watchStart = now;
  }

  function watchBegin() {
    if (!watchStart) watchStart = Date.now();
  }

  function watchEnd() {
    if (!watchStart) return;
    watchFlush();
    watchStart = 0;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) watchEnd();
    else if (state.view === 'drill') watchBegin();
  });
  window.addEventListener('pagehide', watchEnd);
  setInterval(watchFlush, 30000);

  // 右上角那个小胶囊：点一下把词标成「已完成」，以后不再出现
  function renderMasterBtn() {
    var btn = el('btnDrillMaster');
    if (!btn) return;
    var rec = state.current ? ctx.db().records[state.current.w] : null;
    var done = !!(rec && rec.done);
    var label = el('drillMasterLabel');
    if (label) label.textContent = done ? '已完成 ✓' : '熟悉';
    btn.classList.toggle('is-done', done);
    // 揭晓释义那会儿已经评过分了，这时候再点没有意义
    btn.disabled = done || state.phase !== 'recall';
    btn.title = done ? '这个词已经标记完成，不会再出现' : '点一下标记为已完成，这个词以后不再出现';
  }

  // 自评阶段整个答案区都不出现，连字数也不透露；评完分由 renderMeaning() 填中文意思
  function clearAnswer() {
    el('answerText').innerHTML = '';
    KB.updateHint();
  }

  function loadWord(w, mode) {
    state.current = w;
    state.origin = mode || 'new';
    state.phase = 'recall';

    el('wordText').textContent = w.w;
    el('stageMode').textContent = mode === 'due' ? '间隔复习' : '看词自评';
    el('wordPhonetic').textContent = w.ph || '';
    el('fullDef').textContent = w.def;
    el('fullDef').classList.remove('show');
    el('rateFeedback').hidden = true;
    el('rateFeedback').textContent = '';
    el('btnMeaningNext').hidden = true;
    el('rateRow').classList.remove('is-finished');
    el('btnDetail').hidden = false;
    prefetchDetail(w.w);
    // 三个自评选项在看词阶段就出现：先凭印象定级，定完才揭晓中文
    el('rateRow').classList.add('show');
    // 这一屏还没有答案，把答案区收起来，别留一大片空白
    document.querySelector('.drill').classList.add('is-recall');
    document.querySelector('.drill').classList.remove('is-reveal');
    // 背词阶段只看词义并自评；键盘与手部动画统一放到作文训练。
    KB.showKeyboard(false);

    clearAnswer();
    renderProgress();
    renderMasterBtn();
    Favs.syncFavUI();
    el('hints').textContent = hintText(w, state.origin);

    if (ctx.db().settings.autoplay) speak(w.w);
    preloadNext();
  }

  // 提示语随取词来源变化：复习的词告诉用户隔了多久、有没有逾期
  function hintText(w, mode) {
    var tail = '　·　R 重听发音';
    var rate = 'J 忘了　·　K 模糊　·　L 熟悉';
    if (mode === 'due') {
      var r = ctx.db().records[w.w];
      var gap = r && r.lastAt ? humanGap(Date.now() - r.lastAt) : '';
      var late = r && r.dueAt && Date.now() - r.dueAt > DAY
        ? ' · 已逾期 ' + humanGap(Date.now() - r.dueAt)
        : '';
      return '复习间隔到了' + (gap ? ' · 距上次 ' + gap : '') + late + '　·　' + rate + tail;
    }
    return '先凭印象判断：' + rate + tail;
  }

  // 顶栏：学习看今天这 10 个的进度，复习看到底还剩几个到期
  function renderProgress() {
    var bar = document.querySelector('.drill-bar');
    if (state.mode === 'review') {
      var left = reviewPool(Date.now()).length;
      el('drillIndex').textContent = '复习 · 还剩 ' + left + ' 个';
      if (bar) bar.style.visibility = 'hidden';
    } else {
      var st = batchStats();
      var total = st.total || BATCH_SIZE;
      el('drillIndex').textContent = '学习 ' + st.done + ' / ' + total;
      el('drillBar').style.width = (total ? Math.round(st.done / total * 100) : 0) + '%';
      if (bar) bar.style.visibility = '';
    }
    Today.refreshDueStat();
  }



  // 自评揭晓：把中文意思放进原来打字的大字位置，任何窗口高度都先看到意思；
  // 完整释义、已记录提示依次排在下面，实在放不下时先裁掉最下面的提示。
  function renderMeaning() {
    var w = state.current;
    if (!w) return;
    // 释义字段按词性标签分组：n.、vt.、vi.、adj. 等；同一词性的多个义项合并显示。
    var definition = String(w.def || w.m || w.a || '').replace(/\s+/g, ' ').trim();
    var parts = definition.split(/[；;]+/).map(function (part) { return part.trim(); }).filter(Boolean);
    var rows = [];
    parts.forEach(function (part) {
      var match = part.match(/^((?:(?:vt|vi|adj|adv|prep|pron|conj|interj|num|art|aux|n|v)(?:\.|\/)?)+)\s*(.*)$/i);
      if (match) {
        var pos = match[1].replace(/\/$/, '').toLowerCase();
        var meaning = match[2].trim();
        var existing = rows.find(function (row) { return row.pos === pos; });
        if (meaning) {
          if (existing) existing.meaning += '；' + meaning;
          else rows.push({ pos: pos, meaning: meaning });
        }
      } else if (rows.length) {
        rows[rows.length - 1].meaning += '；' + part;
      } else if (part) {
        rows.push({ pos: '', meaning: part });
      }
    });
    if (!rows.length) rows.push({ pos: '', meaning: String(w.a || w.def || '') });
    el('answerText').innerHTML = rows.map(function (row) {
      return '<div class="meaning-entry">' + (row.pos ? '<span class="meaning-pos">' + esc(row.pos) + '</span>' : '') + '<span class="meaning-text">' + esc(row.meaning) + '</span></div>';
    }).join('');
  }

  // 揭晓中文释义。复习记录照旧在后台写，这一屏不展示间隔和底层数字。
  function revealMeaning() {
    document.querySelector('.drill').classList.remove('is-recall');
    document.querySelector('.drill').classList.add('is-reveal');
    renderMeaning();
    el('fullDef').classList.remove('show');
    el('rateFeedback').hidden = true;
    el('rateFeedback').textContent = '';
    el('rateRow').classList.remove('show');
    el('rateRow').classList.add('is-finished');
    el('btnMeaningNext').hidden = false;
    el('btnMeaningNext').focus();
    el('hints').textContent = '空格 / 回车 下一个单词　·　R 重听发音';
    renderMasterBtn();
  }

  // 背词只做熟悉度判断：先存记录，再揭晓释义
  function rate(g) {
    if (state.phase !== 'recall') return;
    finish(g);
    revealMeaning();
  }

  // 右上角「熟悉」：这个词算过了，标成已完成，以后不再出现。
  // 想反悔只能在设置里重置这本词书（整本学习记录一起清掉）。
  function markDone() {
    if (state.phase !== 'recall' || !state.current) return;
    state.phase = 'judged';
    KB.updateHint();

    var w = state.current;
    var rec = getRec(w.w);
    var now = Date.now();
    var wasNew = rec.seen === 0;

    rec.done = 1;
    rec.skip = 1;
    rec.doneAt = now;
    rec.iv = 0;
    rec.dueAt = 0;                 // 不进复习队列
    rec.step = Math.max(rec.step || 0, MASTERED);
    if (!rec.masteredAt) rec.masteredAt = now;
    rec.seen += 1;
    rec.last = 3;
    rec.lastAt = now;

    var d = dayEntry();
    d.words += 1;
    d.clean += 1;
    if (wasNew) d.newWords += 1;

    ctx.save();
    renderProgress();
    renderMasterBtn();
    revealMeaning();
    beep(660, 0.07, 'sine', 0.04);
  }

  // 自评落库：grade 1 忘了 / 2 模糊 / 3 熟悉。间隔怎么走全在 applyGrade（schedule.js）
  function finish(grade) {
    state.phase = 'judged';
    KB.updateHint();   // 这一词已结束，清掉键位提示

    var w = state.current;
    var rec = getRec(w.w);
    var wasNew = rec.seen === 0;

    // applyGrade 内部写 step / iv / dueAt / last / lastAt / forgot，这里不再重复写时间
    applyGrade(rec, grade, w.w);
    rec.seen += 1;
    if (grade < 3) rec.wrong += 1;

    var d = dayEntry();
    d.words += 1;
    if (grade === 3) d.clean += 1;
    if (wasNew) d.newWords += 1;

    // 学习池：点「熟悉」当天就算过了，不再排回队列（进度跨天累计，攒满 3 次才很熟）；
    // 忘了 / 模糊的留在队列里继续轮，直到过掉或换榜。
    if (state.mode === 'learn' && !rec.masteredAt) {
      if (grade === 3) rec.learnedOn = todayKey();
      else state.queue.push(w);
    }

    ctx.save();
    renderProgress();
    renderMasterBtn();
    beep(520, 0.045, 'sine', 0.025);
  }

  function next() {
    state.step += 1;
    loadNext();
  }

  // 揭晓释义后，「空格 / 回车 / 下一个单词按钮」共用这个入口，防止连按跳两个词
  function nextFromReveal() {
    if (state.phase !== 'judged') return;
    next();
  }

    // 已经有正在计时就不重开：从别的页面点「背词」回来时不能把计时清零
    function ensureTimer() {
      if (!timerId) startTimer();
    }

    return {
      startLearn: startLearn,
      startReview: startReview,
      loadNext: loadNext,
      ensureTimer: ensureTimer,
      startTimer: startTimer,
      stopTimer: stopTimer,
      endSession: endSession,
      loadWord: loadWord,
      rate: rate,
      markDone: markDone,
      next: next,
      nextFromReveal: nextFromReveal,
      renderProgress: renderProgress,
      watchFlush: watchFlush,
      watchBegin: watchBegin,
      watchEnd: watchEnd,
      renderMasterBtn: renderMasterBtn,
      clearAnswer: clearAnswer
    };
  }
};
