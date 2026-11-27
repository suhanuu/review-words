/* ============================================================
   Review Words · 今天（入口页）
   从 app.js 拆出来：日期、两个入口卡（学习/复习）、进度文案、学习设置弹层、
   顶栏那个「待复习 N」小格子。

   页面自己不判题、不排期，只把外面算好的数摆上去：
     stats.dailyGoal() / dayStats()                 目标与今日完成数
     batchStats() / BATCH_SIZE                        今天这批的进度
     reviewPool() / dueCount() / overdueCount()       到期、逾期、下一个多久回来
     nextDueIn() / fmt.countdownText()                倒计时文案
   ============================================================ */
window.RWToday = {
  create: function (ctx) {
    'use strict';

    var el = ctx.el;
    var Stats = ctx.stats;
    var todayKey = ctx.fmt.todayKey, countdownText = ctx.fmt.countdownText;
    var allWords = ctx.allWords, isOpen = ctx.isOpen, BATCH_SIZE = ctx.batchSize;
    var batchStats = ctx.batchStats, reviewPool = ctx.reviewPool;
    var dueCount = ctx.dueCount, overdueCount = ctx.overdueCount, nextDueIn = ctx.nextDueIn;
    var dayEntry = ctx.dayEntry, masteredTotal = ctx.masteredTotal, DAY = ctx.day;
    var renderProgress = ctx.renderProgress;

  // ================= 今天（入口页） =================
  function dateLabel() {
    var d = new Date();
    var week = '日一二三四五六'.charAt(d.getDay());
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 星期' + week;
  }

  function openWordCount() {
    var ws = allWords(), n = 0;
    for (var i = 0; i < ws.length; i++) if (isOpen(ws[i])) n++;
    return n;
  }

  function renderToday() {
    renderProgress();   // 学习/复习两个数都从这儿来
    var st = batchStats();
    var total = st.total > 0 ? st.total : Math.min(BATCH_SIZE, openWordCount());
    var done = Math.min(st.done, total);
    var left = Math.max(0, total - done);

    var goalL = Stats.dailyGoal();
    var ds = Stats.dayStats(todayKey());
    var learnedCount = ctx.learnedToday();
    var due = reviewPool(Date.now());

    // 学习卡：今天新学几个 / 学习目标
    el('todayLearnChip').textContent = '已学习 ' + learnedCount + ' / ' + goalL;
    el('todayLearnBar').style.width = Math.min(100, goalL ? Math.round(learnedCount / goalL * 100) : 0) + '%';
    var learnCard = el('todayLearnCard');
    var learnBtn = el('btnStartLearn');
    if (learnedCount >= goalL) {
      el('todayLearnBig').innerHTML = '<span class="tick">✓</span><small>今日已完成</small>';
      el('todayLearnNote').textContent = '已学习 ' + learnedCount + ' 词';
      learnBtn.className = 'ghost-btn today-btn';
      learnBtn.textContent = '继续学习';
      learnBtn.dataset.action = 'learn';
      learnCard.classList.remove('is-hot');
      learnCard.classList.add('is-done');
    } else {
      el('todayLearnBig').innerHTML = (goalL - learnedCount) + '<small>个到目标</small>';
      el('todayLearnNote').textContent = '今天已过 ' + learnedCount + ' 个';
      learnBtn.className = 'primary-btn today-btn';
      learnBtn.textContent = learnedCount > 0 || st.done > 0 ? '继续学习' : '开始学习';
      learnBtn.dataset.action = 'learn';
      learnCard.classList.add('is-hot');
      learnCard.classList.remove('is-done');
    }

    // 复习卡：不设目标。大数字 = 还有几个到期，右上角 = 今天已经复习了几个词
    el('todayReviewChip').textContent = '已复习 ' + ds.reviewed + ' 词';
    var reviewCard = el('todayReviewCard');
    var reviewBtn = el('btnStartReview');
    if (due.length) {
      el('todayReviewBig').innerHTML = due.length + '<small>个待复习</small>';
      reviewCard.classList.remove('is-done');
    } else {
      el('todayReviewBig').innerHTML = '<span class="tick">✓</span><small>今天清完了</small>';
      reviewCard.classList.add('is-done');
    }
    el('todayReviewNote').textContent = '';

    reviewBtn.disabled = !due.length;
    reviewBtn.className = due.length
      ? (learnedCount >= goalL ? 'primary-btn today-btn' : 'ghost-btn today-btn')
      : 'ghost-btn today-btn';
    // 今天已经复习过就写「继续复习」，否则「开始复习」
    reviewBtn.textContent = due.length ? (ds.reviewed > 0 ? '继续复习' : '开始复习') : '暂时没有要复习的';
    reviewCard.classList.toggle('is-hot', due.length > 0 && learnedCount >= goalL);

    // 底下那行汇总
    el('todayMastered').textContent = ds.total;
    el('todayMinutes').textContent = Math.round((dayEntry().seconds || 0) / 60);
    el('todayTotalMastered').textContent = masteredTotal();
    el('todayDate').textContent = dateLabel();
  }

  // 学习设置（今天页右上角）：只调「每天新学几个」
  function openGoalPop() {
    var input = el('goalInput');
    input.value = String(Stats.dailyGoal());
    el('goalPop').hidden = false;
    input.focus();
    input.select();
  }

  function closeGoalPop() {
    el('goalPop').hidden = true;
  }

  // 只刷顶栏那个小格子，切词/每秒 tick 都调它
  function refreshDueStat() {
    var stat = el('dueStat');
    if (!stat) return;
    var now = Date.now();
    var due = dueCount(now);
    var late = overdueCount(now);
    if (due) {
      stat.innerHTML = '待复习 <b>' + due + '</b>' +
        (late ? ' · 逾期 <b class="late">' + late + '</b>' : '');
      return;
    }
    var wait = nextDueIn(now);
    stat.innerHTML = '待复习 <b>0</b>' +
      (wait ? ' · <span class="due-next">下一词 ' + countdownText(wait) + '</span>' : '');
  }

    // 学习设置弹层（今天页右上角）：打开/关闭/保存都在这里
    function bind() {
      el('btnTodaySettings').addEventListener('click', openGoalPop);
      el('btnGoalCancel').addEventListener('click', closeGoalPop);
      el('btnGoalSave').addEventListener('click', function () {
        var n = Math.round(Number(el('goalInput').value));
          if (!(n > 0)) { el('goalInput').focus(); return; }
          ctx.db().settings.dailyGoal = Math.min(999, n);
          ctx.save();
        closeGoalPop();
        renderToday();
      });
      el('goalPop').addEventListener('click', function (e) {
        if (e.target && e.target.id === 'goalPop') closeGoalPop();
      });
    }

    return {
      bind: bind,
      renderToday: renderToday,
      refreshDueStat: refreshDueStat,
      openGoalPop: openGoalPop,
      closeGoalPop: closeGoalPop
    };
  }
};
