/* ============================================================
   Review Words · 今天（入口页）
   从 app.js 拆出来：日期、两个入口卡（学习/复习）、进度文案、学习设置弹层、
   顶栏那个「待复习 N」小格子。

   页面自己不判题、不排期，只把外面算好的数摆上去：
     stats.dailyGoal() / reviewGoal() / dayStats()   目标与今日完成数
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
    var goalR = Stats.reviewGoal();
    var ds = Stats.dayStats(todayKey());
    var due = reviewPool(Date.now());
    var late = due.filter(function (x) { return Date.now() - x.at > DAY; }).length;
    var nextAt = nextDueIn(Date.now());

    // 学习卡：今天新学几个 / 学习目标
    el('todayLearnChip').textContent = '已学习 ' + ds.learned + ' / ' + goalL;
    el('todayLearnBar').style.width = Math.min(100, goalL ? Math.round(ds.learned / goalL * 100) : 0) + '%';
    var learnCard = el('todayLearnCard');
    var learnBtn = el('btnStartLearn');
    if (ds.learned >= goalL) {
      el('todayLearnBig').innerHTML = '<span class="tick">✓</span><small>今日已完成</small>';
      el('todayLearnNote').textContent = '已学习 ' + ds.learned + ' 词'
        + (left ? ' · 这一轮还剩 ' + left + ' 个' : '');
      learnBtn.className = 'ghost-btn today-btn';
      learnBtn.textContent = '再学 10 个';
      learnBtn.dataset.action = 'learn';
      learnCard.classList.remove('is-hot');
      learnCard.classList.add('is-done');
    } else {
      el('todayLearnBig').innerHTML = (goalL - ds.learned) + '<small>个到目标</small>';
      el('todayLearnNote').textContent = '今天新学 ' + ds.learned + ' 个'
        + (left ? ' · 这一轮还剩 ' + left + ' 个' : '');
      learnBtn.className = 'primary-btn today-btn';
      learnBtn.textContent = ds.learned > 0 || st.done > 0 ? '继续学习' : '开始学习';
      learnBtn.dataset.action = 'learn';
      learnCard.classList.add('is-hot');
      learnCard.classList.remove('is-done');
    }

    // 复习卡：今天复习几个 / 复习目标
    el('todayReviewChip').textContent = '已复习 ' + ds.reviewed + ' / ' + goalR;
    el('todayReviewBar').style.width = Math.min(100, goalR ? Math.round(ds.reviewed / goalR * 100) : 0) + '%';
    var reviewCard = el('todayReviewCard');
    var reviewBtn = el('btnStartReview');
    if (ds.reviewed >= goalR) {
      el('todayReviewBig').innerHTML = '<span class="tick">✓</span><small>今日复习已完成</small>';
      el('todayReviewNote').textContent = '已复习 ' + ds.reviewed + ' 词'
        + (due.length ? ' · 还有 ' + due.length + ' 个到期' : '');
      reviewCard.classList.add('is-done');
    } else {
      el('todayReviewBig').innerHTML = (goalR - ds.reviewed) + '<small>个到目标</small>';
      var dueNote = due.length
        ? ('还有 ' + due.length + ' 个到期' + (late ? ' · 逾期 ' + late + ' 个' : ''))
        : (nextAt ? '下一个词 ' + countdownText(nextAt) + '回来' : '这本书暂时没有要复习的词了');
      el('todayReviewNote').textContent = dueNote + ' · 已复习 ' + ds.reviewed + ' 词';
      reviewCard.classList.remove('is-done');
    }
    reviewBtn.disabled = !due.length;
    reviewBtn.className = due.length
      ? (ds.learned >= goalL ? 'primary-btn today-btn' : 'ghost-btn today-btn')
      : 'ghost-btn today-btn';
    reviewBtn.textContent = due.length ? '开始复习 ' + due.length + ' 个' : '暂时没有要复习的';
    el('todayReviewCard').classList.toggle('is-hot', due.length > 0 && ds.learned >= goalL);

    // 底下那行汇总
    el('todayMastered').textContent = ds.total;
    el('todayMinutes').textContent = Math.round((dayEntry().seconds || 0) / 60);
    el('todayTotalMastered').textContent = masteredTotal();
    el('todayDate').textContent = dateLabel();
  }

  // 学习设置（今天页右上角）：学习目标 / 复习目标，后续别的可调项也放这个弹层里
  function openGoalPop() {
    var input = el('goalInput');
    input.value = String(Stats.dailyGoal());
    el('goalReviewInput').value = String(Stats.reviewGoal());
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
        var r = Math.round(Number(el('goalReviewInput').value));
        if (!(n > 0)) { el('goalInput').focus(); return; }
        if (!(r > 0)) { el('goalReviewInput').focus(); return; }
        ctx.db().settings.dailyGoal = Math.min(999, n);
        ctx.db().settings.reviewGoal = Math.min(999, r);
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
