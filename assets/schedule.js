/* ============================================================
   Review Words · 背词节奏
   一个词身上只挂一个数：step（连续答对了几次）。

   学习期（step 0–2）：还没很熟，答对一次 step+1，明天再见。
   复习期（step 3–10）：很熟了，按 1/2/4/7/15/30/90/180 天走。
   step 11：180 天那一档也过了，毕业，不再出现。

   评价口径：
     忘了（1）→ step 归零，15 分钟后当天再来；
     模糊（2）→ step 退一档；退到学习期就 20 分钟后当天再来；
     熟悉（3）→ step 加一，按下一次的阶梯间隔。

   右上角「熟悉」不走这里：它是「这个词算过了，以后别再出现」的标记，
   由 app.js 直接写成 done（跳过整套复习）。

   这个文件不碰 DOM，浏览器里挂到 window.RWSchedule，Node 里能直接 require，
   规则改错了用 node 跑一遍就知道。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN = 60000;
  var DAY = 86400000;

  // 复习阶梯：这一档答对之后，隔几天再来
  var LADDER_DAYS = [1, 2, 4, 7, 15, 30, 90, 180];
  var LADDER = LADDER_DAYS.map(function (d) { return d * DAY; });

  var MASTERED = 3;   // 连续熟悉 3 次 = 很熟
  var DONE = 11;      // 走完 180 天那一档 = 毕业

  var FORGOT = 15 * MIN;   // 忘了：当天再回来
  var FUZZY = 20 * MIN;    // 模糊：也留在当天

  function clampStep(step) {
    var n = Math.round(Number(step) || 0);
    if (n < 0) return 0;
    return n > DONE ? DONE : n;
  }

  // 当前 step 对应的「下次隔多久」
  function delayFor(step) {
    step = clampStep(step);
    if (step >= DONE) return 0;            // 毕业
    if (step < MASTERED) return DAY;       // 学习期：明天见
    return LADDER[step - MASTERED];        // 3→1 天，4→2 天 …… 10→180 天
  }

  // 评价一次之后的新 step / 下次间隔
  function next(step, grade) {
    step = clampStep(step);

    if (grade === 1) {
      return { step: 0, delay: FORGOT, graduated: false };
    }
    if (grade === 2) {
      // 学习期里「模糊」等于没学会：直接清零，当天再来；
      // 进了复习期才只退一档，别把攒了很久的进度一把推平。
      if (step < MASTERED) {
        return { step: 0, delay: FUZZY, graduated: false };
      }
      var back = step - 1;
      return {
        step: back,
        delay: back < MASTERED ? FUZZY : delayFor(back),
        graduated: false
      };
    }
    var up = Math.min(DONE, step + 1);
    return {
      step: up,
      delay: delayFor(up),
      graduated: up >= DONE
    };
  }

  // 老数据迁移：把原来存着的「间隔毫秒」折算成台阶。
  // 原来「很熟」第一次就是 1 天，所以满 1 天的一律算已经进复习期。
  function stepFromIv(iv) {
    var ms = Number(iv) || 0;
    if (ms < DAY) return 0;
    var k = 0;
    for (var i = 0; i < LADDER.length; i++) {
      if (ms >= LADDER[i]) k = i;
    }
    return clampStep(MASTERED + k);
  }

  function isMastered(step) { return clampStep(step) >= MASTERED; }
  function isDone(step) { return clampStep(step) >= DONE; }

  return {
    MIN: MIN,
    DAY: DAY,
    LADDER_DAYS: LADDER_DAYS,
    MASTERED: MASTERED,
    DONE: DONE,
    FORGOT: FORGOT,
    FUZZY: FUZZY,
    clampStep: clampStep,
    delayFor: delayFor,
    next: next,
    stepFromIv: stepFromIv,
    isMastered: isMastered,
    isDone: isDone
  };
});
