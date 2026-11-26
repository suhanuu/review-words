/* ============================================================
   Review Words · 复习调度（FSRS-6）
   分两层，别混：

   1) 学习期（还没很熟，step 0–2）：完全沿用 assets/schedule.js 的老规则——
      忘了 15 分钟、模糊 20 分钟、熟悉明天见。这一层是「当天批次」的会话规则，
      换算法也不会动它。
   2) 复习期（很熟过，rec.masteredAt 有值）：每次评分交给 ts-fsrs 6.0.1 的
      FSRS-6 算下次间隔，封顶 365 天、关掉随机抖动。
        忘了 → Again（15 分钟后再练）
        模糊 → Hard
        熟悉 → Good

   不再有「毕业」：走完 180 天那档以后继续按 FSRS 排期，最长 365 天。
   以前已经毕业的老数据（step 11 / done=1）保持不再出现，只读不动。

   旧进度迁移：复习期的词按原来的阶梯天数折算成稳定度
   （step 3→1 天、4→2 天、5→4 天 …… 10→180 天），到期时间照旧不改，
   记录里写一个 rec.fsrs.sch = 6 的版本标记，重复迁移不会把稳定度再折算一遍。

   浏览器里挂到 window.RWScheduler；Node 里能直接 require（单测用）。
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DAY = 86400000;
  var MAX_DAYS = 365;          // 封顶：一年
  var MODEL = 'FSRS-6';
  var SCH_VERSION = 6;         // rec.fsrs.sch 的值，变了才需要重新迁移
  var VENDOR = '../../vendor/ts-fsrs-6.0.1.umd.js';

  // ---------- 依赖：两个都是 UMD，浏览器读全局、Node 走 require ----------
  function rules() {
    if (root.RWSchedule) return root.RWSchedule;
    if (typeof require === 'function') {
      try { return require('../../schedule.js'); } catch (e) { /* 下面统一处理 */ }
    }
    return null;
  }

  function lib() {
    if (root.FSRS && root.FSRS.FSRS) return root.FSRS;
    if (typeof require === 'function') {
      try {
        var m = require(VENDOR);
        if (m && m.FSRS) return m;
      } catch (e) { /* 下面统一处理 */ }
    }
    return (root.FSRS && root.FSRS.FSRS) ? root.FSRS : null;
  }

  var engineRef = null;
  var initDifficulty = 0;

  function engine() {
    if (engineRef) return engineRef;
    var L = lib();
    if (!L) return null;
    var params = {
      request_retention: 0.9,     // 目标记忆保持率
      maximum_interval: MAX_DAYS, // 封顶 365 天（库默认是 100 年）
      enable_fuzz: false,         // 关随机抖动：同一天同样的评分结果可复现
      enable_short_term: true,    // 忘了之后按 15 分钟步长再练
      learning_steps: ['15m'],
      relearning_steps: ['15m']
    };
    // 显式钉住权重：库里导出的默认权重就是 FSRS-6 那 21 个
    if (L.default_w) params.w = L.default_w;
    engineRef = new L.FSRS(params);
    return engineRef;
  }

  // 复习卡片的初始难度：让库自己算「新卡第一次点熟悉」的难度，别硬编码
  function seedDifficulty() {
    if (initDifficulty) return initDifficulty;
    var e = engine();
    var L = lib();
    if (!e || !L) return 5;
    try {
      var probe = e.repeat(L.createEmptyCard(new Date()), new Date());
      initDifficulty = probe[L.Rating.Good].card.difficulty || 5;
    } catch (err) {
      initDifficulty = 5;
    }
    return initDifficulty;
  }

  // ---------- 记录 → 卡片 ----------
  function isMastered(rec) {
    if (!rec) return false;
    if (rec.masteredAt) return true;
    var R = rules();
    return !!(R && R.clampStep(rec.step) >= R.MASTERED);
  }

  function ladderDays(step) {
    var R = rules();
    var s = R.clampStep(step);
    if (s < R.MASTERED) return 0;
    var idx = Math.min(s - R.MASTERED, R.LADDER_DAYS.length - 1);
    return R.LADDER_DAYS[idx];
  }

  function reviewMs(rec) {
    var last = Number(rec.lastAt) || 0;
    if (!last && rec.dueAt) last = Number(rec.dueAt) - (Number(rec.iv) || DAY);
    return last || Date.now();
  }

  function toCard(rec, now) {
    var f = rec.fsrs || {};
    var last = Number(f.last) || reviewMs(rec);
    var due = Number(rec.dueAt) || (last + (Number(f.s) || 1) * DAY);
    var stability = Number(f.s) || 1;
    return {
      due: new Date(due),
      stability: stability,
      difficulty: Number(f.d) || seedDifficulty(),
      elapsed_days: Math.max(0, Math.round((now - last) / DAY)),
      scheduled_days: Math.max(0, Math.round((due - last) / DAY)),
      reps: Number(rec.seen) || 0,
      lapses: Number(rec.forgot) || 0,
      state: Number(f.state) || 2,   // 2 = Review
      last_review: new Date(last)
    };
  }

  // ---------- 迁移（幂等） ----------
  // 已经有 sch=6 的卡：不动，只把离谱的到期时间拉回 365 天以内
  // 学习期的词：不建卡（它们还不在复习池里）
  // 老毕业的词（done=1）：不建卡，保持「不再出现」
  function migrate(rec, now) {
    now = now || Date.now();
    if (!rec) return false;

    if (rec.fsrs && Number(rec.fsrs.sch) === SCH_VERSION) {
      var cap = MAX_DAYS * DAY;
      if (rec.dueAt && rec.dueAt - now > cap) {
        rec.dueAt = now + cap;
        rec.iv = cap;
        return true;
      }
      return false;
    }

    if (rec.done || !isMastered(rec)) return false;

    var R = rules();
    if (R && R.clampStep(rec.step) >= R.DONE) return false;   // 老毕业数据，保持退休

    var days = ladderDays(rec.step) || 1;
    var last = reviewMs(rec);
    var due = Number(rec.dueAt) > 0 ? Number(rec.dueAt) : last + days * DAY;

    rec.fsrs = {
      sch: SCH_VERSION,
      s: days,
      d: seedDifficulty(),
      state: 2,
      last: last
    };
    // 到期时间照旧（用户已经等了的时间不白等），只把超长间隔收进 365 天
    var capMs = MAX_DAYS * DAY;
    if (due - now > capMs) due = now + capMs;
    rec.dueAt = due;
    rec.iv = Math.max(0, due - last);
    return true;
  }

  // ---------- 评分 ----------
  var GRADE_TO_RATING = { 1: 'Again', 2: 'Hard', 3: 'Good' };

  // 老规则里的 step 只用来给界面/统计展示，FSRS 说了算以后它不再决定到期时间
  function mirrorStep(step, grade) {
    var R = rules();
    var s = R.clampStep(step);
    if (grade === 1) return 0;
    if (grade === 2) return Math.max(0, s - 1);
    return Math.min(R.DONE - 1, s + 1);   // 封在毕业前一档，不再产生新毕业
  }

  // 学习期：原样交给 schedule.js
  function learnGrade(rec, grade, now) {
    var R = rules();
    var plan = R.next(rec.step || 0, grade);
    rec.step = plan.step;
    rec.done = plan.graduated ? 1 : 0;
    rec.iv = plan.graduated ? 0 : plan.delay;
    rec.dueAt = plan.graduated ? 0 : now + plan.delay;
    return { kind: 'learn', graduated: plan.graduated, delay: rec.iv };
  }

  // 复习期：FSRS 算间隔
  function reviewGrade(rec, grade, now) {
    var e = engine();
    var L = lib();
    if (!e || !L) {
      // 极端情况（vendor 没加载）：退回老阶梯，别让评价按钮失灵
      var R = rules();
      var plan = R.next(rec.step || 0, grade);
      rec.step = Math.min(R.DONE - 1, plan.step);
      rec.done = 0;
      rec.iv = plan.delay;
      rec.dueAt = now + plan.delay;
      return { kind: 'review-fallback', graduated: false, delay: rec.iv };
    }

    var card = toCard(rec, now);
    var rating = L.Rating[GRADE_TO_RATING[grade] || 'Good'];
    var out = e.repeat(card, new Date(now));
    var res = out[rating];
    var next = res.card;
    var due = next.due.getTime();
    var delay = Math.max(60000, due - now);
    if (delay > MAX_DAYS * DAY) {           // 双保险：封顶 365 天
      delay = MAX_DAYS * DAY;
      due = now + delay;
    }

    rec.fsrs = {
      sch: SCH_VERSION,
      s: next.stability,
      d: next.difficulty,
      state: next.state,
      last: now
    };
    rec.iv = delay;
    rec.dueAt = due;
    rec.step = mirrorStep(rec.step, grade);
    rec.done = 0;
    return { kind: 'review', graduated: false, delay: delay };
  }

  function grade(rec, g, now) {
    now = now || Date.now();
    rec = rec || {};
    if (isMastered(rec)) return reviewGrade(rec, g, now);
    var out = learnGrade(rec, g, now);
    // 刚刚攒满 3 次：立刻建卡，下一次按 FSRS 走（老规则是 1 天后见）
    if (!rec.done && isMastered(rec)) {
      rec.fsrs = null;
      migrate(rec, now);
    }
    return out;
  }

  function reset() {          // 单测用：清掉缓存的引擎和难度
    engineRef = null;
    initDifficulty = 0;
  }

  return {
    MODEL: MODEL,
    SCH_VERSION: SCH_VERSION,
    MAX_DAYS: MAX_DAYS,
    isMastered: isMastered,
    ladderDays: ladderDays,
    migrate: migrate,
    grade: grade,
    reset: reset,
    _engine: engine,
    _toCard: toCard
  };
});
