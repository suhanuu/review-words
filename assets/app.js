(function () {
  'use strict';

  // 存储统一走 assets/modules/core/store.js：键名表、写失败提示、用量提醒都在那边
  var RWStore = window.RWStore;
  var KEYS = RWStore.KEYS;
  var DEFAULT_BOOK_ID = 'redbook-2024';
  var USER_SCOPE = '';               // 预留给以后的多账号，现在恒为空
  var activeBookId = RWStore.getText(KEYS.activeBook) || DEFAULT_BOOK_ID;

  var MIN = 60000;
  var DAY = 86400000;

  // 背词节奏：
  // 学习期 step 0–2：规则在 assets/schedule.js，忘了 15 分钟、模糊 20 分钟、熟悉 1 天；
  // 复习期（很熟过）：规则在 assets/modules/core/scheduler.js，FSRS-6，最长 365 天，不再毕业。
  var MASTERED = RWSchedule.MASTERED;
  // 复习间隔上限：FSRS 封顶 365 天（老阶梯最多 180 天）
  var LADDER_MAX = RWScheduler.MAX_DAYS * DAY;
  var DEFAULTS = {
    theme: 'light',
    sound: true,
    autoplay: true,
    fontScale: 1,
    dailyGoal: 10,     // 学习目标（今天新学几个），学习页右上角可以改
    reviewGoal: 10     // 复习目标（今天复习几个）
  };

  var el = function (id) { return document.getElementById(id); };

  // ================= 书架（多词书） =================
  // 词书清单与卡片都在 assets/modules/pages/bookshelf.js；这边只接上下文。
  // reloadCurrent() 是「重新学习当前书」之后要做的复位，涉及 db/state，所以留在 app.js。
  var Books = window.RWBookshelf.create({
    el: el,
    store: RWStore,
    keys: KEYS,
    defaultBookId: DEFAULT_BOOK_ID,
    defaultSettings: DEFAULTS,
    log: RWLog,
    parseImport: function (text) { return Words.parseImport(text); },
    activeId: function () { return activeBookId; },
    reloadCurrent: function () {
      db = load();
      wordCache = null;
      wordIndex = null;
      state.queue = [];
      state.current = null;
      state.phase = 'idle';
      save();
      setView('today');
    }
  });
  // 当前书 id 在清单里找不到（比如被删掉的那本还记着），退回内置红宝书
  if (!Books.list().some(function (b) { return b.id === activeBookId; })) activeBookId = DEFAULT_BOOK_ID;

  // ================= 存储 =================
  function storeKey() { return RWStore.bookKey(activeBookId) + (USER_SCOPE ? ':' + USER_SCOPE : ''); }
  // 老版本「一本书一个键」的数据，第一次升级时复制到分书键下（老键不动，出问题还能回退）
  if (activeBookId === DEFAULT_BOOK_ID && !RWStore.getText(storeKey()) && RWStore.getText(KEYS.legacyBook)) {
    RWStore.setText(storeKey(), RWStore.getText(KEYS.legacyBook));
  }
  var db = load();

  function load() {
    var raw = RWStore.get(storeKey(), {});
    var recs = raw.records || {};
    // 兼容旧数据：把按「天」存的 due 换成时间戳
    Object.keys(recs).forEach(function (k) {
      var r = recs[k];
      if (r.dueAt === undefined) {
        r.dueAt = 0;
        if (r.due && r.seen) {
          var t = new Date(r.due + 'T00:00:00').getTime();
          if (!isNaN(t)) r.dueAt = t;
        }
        delete r.due;
      }
      if (r.iv === undefined) r.iv = (r.interval || 0) * DAY;
      // 新增字段：累计忘记次数（老数据没有，从 0 起算，不清空任何已有内容）
      if (r.forgot === undefined) r.forgot = 0;
      delete r.interval;

      // 新节奏只认 step：老数据的间隔按阶梯折算成台阶，之前的进度不清零；
      // 已经在复习期的，到期时间按新阶梯重新对齐，免得被老间隔拖到几个月后。
      if (r.step === undefined) {
        r.step = RWSchedule.stepFromIv(r.iv);
        if (r.step >= MASTERED) {
          r.masteredAt = r.lastAt || r.dueAt || Date.now();
          var delay = RWSchedule.delayFor(r.step);
          r.iv = delay;
          r.dueAt = (r.lastAt || Date.now()) + delay;
        }
      }
      if (r.masteredAt === undefined) r.masteredAt = 0;
      if (r.done === undefined) r.done = 0;
      // 很熟过、还没毕业的词换成 FSRS 卡片：稳定度按原阶梯天数折算，到期时间不动。
      // 带 rec.fsrs.sch = 6 的不会再折算一遍（幂等），重复打开页面也不会把进度推快。
      RWScheduler.migrate(r, Date.now());
    });
    return {
      settings: Object.assign({}, DEFAULTS, raw.settings || {}),
      records: recs,
      days: raw.days || {},
      custom: raw.custom || [],
      // 收藏：{ 单词: 收藏时间戳 }，时间戳只用来排序（最新收藏排最前）
      favs: (raw.favs && typeof raw.favs === 'object') ? raw.favs : {}
    };
  }

  // 整本词书仍然是一个 JSON：写失败时 store 会弹提示条并补一次 IndexedDB 镜像，
  // 这里不再吞掉错误，只是别让一次失败把整页交互打断。
  function save() {
    RWStore.set(storeKey(), db);
  }

  // 记录字段（沿用旧结构，只多两个字段）：
  //   word          → db.records 的键
  //   step          连续熟悉次数（0–10，界面上只当进度展示，到期时间由 FSRS 决定）
  //   fsrs          FSRS 记忆状态 { sch, s 稳定度, d 难度, state, last }
  //   iv / dueAt    下次间隔（毫秒）与到期时刻
  //   last / lastAt 上次评价等级与时刻（last：1 忘了 / 2 模糊 / 3 熟悉）
  //   seen / wrong  复习次数与错误次数
  //   forgot        累计忘记次数
  //   masteredAt    第一次达到「很熟」的时刻（统计用，只增不减）
  function getRec(word) {
    if (!db.records[word]) {
      db.records[word] = { ease: 2.5, reps: 0, iv: 0, dueAt: 0, last: 0, seen: 0, wrong: 0, lastAt: 0, forgot: 0, step: 0, masteredAt: 0, done: 0 };
    }
    var r = db.records[word];
    if (r.dueAt === undefined) r.dueAt = 0;
    if (r.iv === undefined) r.iv = 0;
    if (r.forgot === undefined) r.forgot = 0;
    if (r.step === undefined) r.step = 0;
    if (r.masteredAt === undefined) r.masteredAt = 0;
    if (r.done === undefined) r.done = 0;
    return r;
  }

  var wordCache = null;
  var wordIndex = null;

  function allWords() {
    if (!wordCache) wordCache = activeBookId === DEFAULT_BOOK_ID ? db.custom.concat(window.WORD_BANK || []) : db.custom.slice();
    return wordCache;
  }

  // 单词 → 词条。收藏只存单词和时间戳，释义、音标一律回词库取，不重复存数据。
  function wordByKey() {
    if (!wordIndex) {
      wordIndex = {};
      allWords().forEach(function (w) { wordIndex[w.w] = w; });
    }
    return wordIndex;
  }

  // ================= 日期与文案 ===================
  // 纯函数都在 assets/modules/core/format.js（带单测），这里取本地别名，调用处不用改。
  var Fmt = window.RWFormat;
  var pad = Fmt.pad, todayKey = Fmt.todayKey, dayKeyOf = Fmt.dayKeyOf, mmss = Fmt.mmss,
      humanGap = Fmt.humanGap, countdownText = Fmt.countdownText,
      minutesText = Fmt.minutesText, hoursText = Fmt.hoursText, durationLabel = Fmt.durationLabel,
      monthSeries = Fmt.monthSeries, shiftMonthKey = Fmt.shiftMonthKey;

  function dayEntry() {
    var k = todayKey();
    if (!db.days[k]) db.days[k] = { words: 0, clean: 0, chars: 0, seconds: 0, newWords: 0 };
    return db.days[k];
  }


  // 「很熟」的词：masteredAt 是第一次攒满 3 次的时刻，只增不减
  function masteredOn(key) {
    var ks = Object.keys(db.records), n = 0;
    for (var i = 0; i < ks.length; i++) {
      var r = db.records[ks[i]];
      if (r.masteredAt && dayKeyOf(r.masteredAt) === key) n++;
    }
    return n;
  }

  function masteredTotal() {
    var ks = Object.keys(db.records), n = 0;
    for (var i = 0; i < ks.length; i++) {
      if (db.records[ks[i]].masteredAt) n++;
    }
    return n;
  }



  // ================= 背词节奏 =================
  // 学习期（还没很熟）的规则在 assets/schedule.js，很熟之后交给 assets/modules/core/scheduler.js
  // 里的 FSRS-6；两个文件都带单测。这里只负责把结果落到记录上，全部按「实际完成评价的时刻」起算。

  // 写入一条复习记录
  function applyGrade(rec, grade) {
    var now = Date.now();
    var plan = RWScheduler.grade(rec, grade, now);
    rec.last = grade;
    rec.lastAt = now;
    if (rec.step >= MASTERED && !rec.masteredAt) rec.masteredAt = now;
    if (grade === 1) rec.forgot = (rec.forgot || 0) + 1;
    // 复习日志单独按月存（core/review-log.js），不占词书那个 JSON
    RWLog.append(activeBookId, grade, plan.delay, now);
    return plan;
  }

  // ================= 取词 =================
  // 到期待复习的词，逾期最久的排最前
  // 只认 dueAt：评价完立刻把 dueAt 推到未来，自然就离开了当前队列，
  // 同一轮里不会再次被抽到；到期没复习也不会被自动顺延
  function duePool(now) {
    var ws = allWords(), out = [];
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.seen > 0 && !r.done && r.dueAt <= now) {
        out.push({ w: ws[i], at: r.dueAt });
      }
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  // 已到期但还没复习的词数（含逾期）。正在学的那一个不算在里面。
  // 直接遍历记录而不是整本词库：6687 个词里绝大多数还没有记录，
  // 而且顶栏每秒刷新一次，走 records 只几十~几千条，开销可以忽略。
  function dueCount(now) {
    now = now || Date.now();
    var cur = state.current && state.current.w;
    var ks = Object.keys(db.records), n = 0;
    for (var i = 0; i < ks.length; i++) {
      var r = db.records[ks[i]];
      if (r.seen > 0 && !r.done && r.dueAt <= now && ks[i] !== cur) n++;
    }
    return n;
  }

  // 已逾期的词数：到期已超过 1 天还没复习。
  // 用 1 天做阈值，避免刚过点几分钟就报逾期吓人。
  function overdueCount(now) {
    now = now || Date.now();
    var cur = state.current && state.current.w;
    var ks = Object.keys(db.records), n = 0;
    for (var i = 0; i < ks.length; i++) {
      var r = db.records[ks[i]];
      if (r.seen > 0 && !r.done && r.dueAt > 0 && now - r.dueAt > DAY && ks[i] !== cur) n++;
    }
    return n;
  }

  // 排队中最靠前的那个词还有多久到期（0 = 没有在排队的词）。
  // 「待复习」只数已经到期的，所以刚评价完的词（比如忘了→15 分钟后）
  // 必然不在里面；这里把它还有多久回来算出来，顶栏才解释得通。
  function nextDueIn(now) {
    now = now || Date.now();
    var ks = Object.keys(db.records), best = 0;
    for (var i = 0; i < ks.length; i++) {
      var r = db.records[ks[i]];
      if (r.seen > 0 && !r.done && r.dueAt > now && (!best || r.dueAt < best)) best = r.dueAt;
    }
    return best ? best - now : 0;
  }


  // ================= 两个池子 =================
  // 学习池：今天批次里的词（还没很熟）。当天反复轮，攒满 3 次就离开。
  // 复习池：很熟过的词（masteredAt），按阶梯到期才回来，永不回学习池。
  var BATCH_SIZE = 10;

  // 还没很熟、也没被右上角「熟悉」划掉
  function isOpen(w) {
    var r = db.records[w.w];
    if (!r) return true;
    return !r.masteredAt && !r.done;
  }

  // 今天批次里还没很熟的词（保持书里的顺序）
  function todayBatch() {
    var today = todayKey();
    return allWords().filter(function (w) {
      var r = db.records[w.w];
      return r && r.batch === today && isOpen(w);
    });
  }

  // 凑满今天的 10 个：今天批次不够就从「还没很熟」的词里按书序补
  function ensureBatch() {
    var today = todayKey();
    var batch = todayBatch();
    if (batch.length >= BATCH_SIZE) return batch.slice(0, BATCH_SIZE);

    var need = BATCH_SIZE - batch.length;
    var ws = allWords();
    var touched = false;
    for (var i = 0; i < ws.length && need > 0; i++) {
      var w = ws[i];
      var r = db.records[w.w];
      if (r && r.batch === today) continue;   // 已经在今天批次里
      if (!isOpen(w)) continue;               // 很熟过 / 被划掉的不要
      getRec(w.w).batch = today;
      batch.push(w);
      need--;
      touched = true;
    }
    if (touched) save();
    return batch;
  }

  // 过了 12 点：昨天没攒满 3 次的次数清零、退回池子
  function resetStaleBatch() {
    var today = todayKey();
    var changed = false;
    Object.keys(db.records).forEach(function (k) {
      var r = db.records[k];
      if (!r.batch || r.batch === today) return;
      if (r.masteredAt || r.done) { r.batch = ''; return; }
      r.step = 0;
      r.iv = 0;
      r.dueAt = 0;
      r.batch = '';
      changed = true;
    });
    if (changed) save();
  }

  // 今天这 10 个的进度（含「再学 10 个」加上来的）
  function batchStats() {
    var today = todayKey();
    var total = 0, done = 0;
    Object.keys(db.records).forEach(function (k) {
      var r = db.records[k];
      if (r.batch !== today) return;
      total++;
      if (r.masteredAt) done++;
    });
    return { total: total, done: done, left: Math.max(0, total - done) };
  }

  // 复习池：很熟过、到期的，逾期最久的排最前
  function reviewPool(now) {
    now = now || Date.now();
    var ws = allWords(), out = [];
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.masteredAt && !r.done && r.dueAt > 0 && r.dueAt <= now) {
        out.push({ w: ws[i], at: r.dueAt });
      }
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  // ================= 状态 =================
  var state = {
    view: 'today',
    mode: 'learn',       // learn = 今天这 10 个 / review = 很熟的到期词
    queue: [],           // 学习池的轮换队列
    phase: 'idle',
    current: null,
    origin: 'new',
    step: 0
  };



  // ================= 键盘指法与手型（独立模块） ===================
  // 原来这一整块（约 290 行）在 app.js 里，现在拆到 assets/modules/drill/keyboard.js。
  // 虚拟键盘、键位高亮、手部图层、hands.js 懒加载都在那边；这里只给上下文。
  var KB = window.RWKeyboard.create({ el: el, state: state });


  // ================= 提示音 =================
  var actx = null;

  function ensureCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function beep(freq, dur, type, vol) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;
    try {
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      o.connect(g); g.connect(actx.destination);
      var t = actx.currentTime;
      g.gain.setValueAtTime(vol || 0.04, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }

  // ================= 发音 =================
  var player = null;
  var preloader = null;

  function voiceUrl(word) {
    return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=2';
  }

  function tts(word) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.92;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function speak(word, force) {
    if (!word) return;
    if (!db.settings.autoplay && !force) return;

    var fellBack = false;
    var fallback = function () {
      if (fellBack) return;
      fellBack = true;
      tts(word);
    };

    try {
      if (!player) player = new Audio();
      player.onerror = fallback;
      player.pause();
      player.src = voiceUrl(word);
      var p = player.play();
      if (p && p.catch) p.catch(fallback);
    } catch (e) {
      fallback();
    }
  }

  // 预取下一个词的发音（只窥探，不改动队列）
  function peekNext() {
    if (state.mode === 'review') {
      var due = reviewPool(Date.now());
      return due.length ? due[0].w : null;
    }
    return state.queue[0] || null;
  }

  function preloadNext() {
    var n = peekNext();
    if (!n) return;
    try {
      if (!preloader) { preloader = new Audio(); preloader.preload = 'auto'; }
      preloader.src = voiceUrl(n.w);
    } catch (e) {}
  }

  // ================= 文本处理 =================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function extractAnswer(def) {
    var s = String(def).replace(/^[a-zA-Z]{1,5}\.\s*/, '');
    s = s.split(/[；;、\/]/)[0];
    s = s.replace(/[\s，。,.；;、：:]/g, '');
    return s.slice(0, 14);
  }

  // ================= 汉字判定（词表搜索用）=================
  var HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/;
  // ================= 视图切换 =================
  function setView(name) {
    state.view = name;
    ['today', 'drill', 'done', 'writing', 'typing', 'article-history', 'weak-words', 'books', 'stats', 'typing-history', 'words', 'favs'].forEach(function (v) {
      var node = el('view-' + v);
      if (node) node.classList.toggle('is-active', v === name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active',
        b.dataset.view === name ||
        (name === 'typing' && b.dataset.view === 'writing') ||
        ((name === 'done' || name === 'drill') && b.dataset.view === 'today'));
    });
    if (name === 'today') Today.renderToday();
    if (name === 'stats') Stats.renderStats();
    if (name === 'words') Words.renderWords(true);
    if (name === 'favs') Favs.renderFavs();
    if (name === 'books') Books.renderBookshelf();
    // 键盘和手部提示只属于作文训练，不再出现在背词页；手部 SVG 第一次进打字页才拉。
    if (name === 'typing') KB.mountHands();
    KB.showKeyboard(name === 'typing');
    document.body.classList.toggle('is-typing-screen', name === 'typing');
    if (name === 'drill') KB.updateHint();
    // 学习页锁住文档滚动：练习时页面不能因为聚焦、锚定或内容变高而整体位移
    var lock = name === 'drill';
    document.documentElement.classList.toggle('is-drill-locked', lock);
    document.body.classList.toggle('is-drill-locked', lock);
    // 「今天学了多久」只在学习页计时，切到别的页面就停表
    if (lock) Drill.watchBegin(); else Drill.watchEnd();
    if (!lock) window.scrollTo(0, 0);
    // 切走再回来时星标要跟上（收藏页里取消过收藏，学习页的星标也得灭掉）
    Favs.syncFavUI();
  }



  // ================= 统计与图表（独立模块） ===================
  // 统计页的渲染、月度图、浮层、打字成绩、复习日志都在 assets/modules/pages/stats.js。
  var Stats = window.RWStats.create({
    el: el, setView: setView, db: function () { return db; }, bookId: function () { return activeBookId; },
    store: RWStore, keys: KEYS, log: RWLog, fmt: Fmt,
    watchFlush: function () { return Drill.watchFlush(); }, masteredTotal: masteredTotal
  });

  // ================= 今天页（独立模块） ===================
  // 日期、两个入口卡、学习设置弹层、顶栏待复习数字都在 assets/modules/pages/today.js。
  var Today = window.RWToday.create({
    el: el,
    stats: Stats,
    fmt: Fmt,
    allWords: allWords,
    isOpen: isOpen,
    batchSize: BATCH_SIZE,
    batchStats: batchStats,
    reviewPool: reviewPool,
    dueCount: dueCount,
    overdueCount: overdueCount,
    nextDueIn: nextDueIn,
    dayEntry: dayEntry,
    masteredTotal: masteredTotal,
    renderProgress: function () { return Drill.renderProgress(); },
    day: DAY,
    db: function () { return db; },
    save: save
  });



  // ================= 词库（独立模块） ===================
  // 词典懒加载、搜索、首字母条、滚动续批、「加进词书」都在 assets/modules/pages/words.js。
  var Words = window.RWWords.create({
    el: el,
    db: function () { return db; },
    allWords: allWords,
    save: save,
    esc: esc,
    humanGap: humanGap,
    HAN: HAN,
    extractAnswer: extractAnswer,
    invalidateWords: function () { wordCache = null; wordIndex = null; },
    wordByKey: wordByKey
  });


  // ================= 详细资料（独立模块） ===================
  // 词根/例句的离线分片加载、二分定位、弹层渲染都在 assets/modules/pages/detail.js。
  var Detail = window.RWDetail.create({ el: el, state: state, esc: esc });


  // ================= 收藏（独立模块） ===================
  // 收藏/取关、收藏页渲染、星标与顶栏数字都在 assets/modules/pages/favs.js。
  var Favs = window.RWFavs.create({
    el: el,
    db: function () { return db; },
    state: function () { return state; },
    save: save,
    esc: esc,
    humanGap: humanGap,
    wordByKey: wordByKey
  });

  // ================= 背词页（独立模块） ===================
  // 取词、自评、揭晓释义、下一个词都在 assets/modules/pages/drill.js；
  // 放在最后实例化，因为它的画进度要回调今天页、星标要回调收藏页。
  var Drill = window.RWDrill.create({
    el: el,
    state: state,
    setView: setView,
    resetStaleBatch: resetStaleBatch,
    reviewPool: reviewPool,
    todayBatch: todayBatch,
    ensureBatch: ensureBatch,
    batchStats: batchStats,
    batchSize: BATCH_SIZE,
    nextDueIn: nextDueIn,
    stats: Stats,
    today: Today,
    kb: KB,
    favs: Favs,
    getRec: getRec,
    applyGrade: applyGrade,
    dayEntry: dayEntry,
    mastered: MASTERED,
    day: DAY,
    fmt: Fmt,
    esc: esc,
    beep: beep,
    speak: speak,
    prefetchDetail: function (w) { return Detail.prefetchDetail(w); },
    preloadNext: preloadNext,
    db: function () { return db; },
    save: save
  });



  // ================= 设置 =================
  function applySettings() {
    document.documentElement.dataset.theme = db.settings.theme;
    document.documentElement.style.setProperty('--scale', db.settings.fontScale);
    syncControls();
  }

  function syncControls() {
    document.querySelectorAll('[data-toggle]').forEach(function (node) {
      node.classList.toggle('on', !!db.settings[node.dataset.toggle]);
    });
    document.querySelectorAll('[data-seg]').forEach(function (seg) {
      var key = seg.dataset.seg;
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', String(db.settings[key]) === b.dataset.val);
      });
    });
  }

  function openDrawer() {
    el('drawer').classList.add('open');
    el('drawerMask').classList.add('open');
  }

  function closeDrawer() {
    el('drawer').classList.remove('open');
    el('drawerMask').classList.remove('open');
  }

  // ================= 事件绑定 =================

  // ================= 书架（独立模块） ===================
  // 词书清单、卡片、切换/改名/删除/重新学习、新建并导入都在
  // assets/modules/pages/bookshelf.js；上面靠近存储那一行已经把它实例化了。


  function bind() {
    Books.bind();   // 新建词书弹层的开关在 modules/pages/bookshelf.js 里

    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'drill') {
          // 已经有正在学的词就原样回来，不要跳到下一个（不然敲一半的内容会丢）
          if (!state.current) {
            Drill.ensureTimer();
            Drill.loadNext();
          } else {
            setView('drill');
          }
          return;
        }
        setView(b.dataset.view);
      });
    });

    el('btnTheme').addEventListener('click', function () {
      db.settings.theme = db.settings.theme === 'dark' ? 'light' : 'dark';
      save();
      applySettings();
    });

    el('btnSettings').addEventListener('click', openDrawer);
    el('btnDrawerClose').addEventListener('click', closeDrawer);
    el('drawerMask').addEventListener('click', closeDrawer);

    // 入口页：开始学习 / 开始复习 / 学习设置
    el('btnStartLearn').addEventListener('click', function () { Drill.startLearn(); });
    el('btnStartReview').addEventListener('click', function () { Drill.startReview(); });
    Today.bind();   // 学习设置弹层在 modules/pages/today.js 里

    el('btnDrillBack').addEventListener('click', function () { setView('today'); });

    // 收尾卡：主按钮跟着场景变（去复习 / 再学 10 个 / 回今天）
    el('btnDonePrimary').addEventListener('click', function () {
      var action = this.dataset.action;
      if (action === 'review') Drill.startReview();
      else if (action === 'learn') Drill.startLearn();
      else setView('today');
    });
    el('btnDoneToday').addEventListener('click', function () { setView('today'); });
    el('btnHome').addEventListener('click', function () { setView('stats'); });

    el('btnSpeak').addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.current) speak(state.current.w, true);
    });

    // 「详细」：词根 / 词组 / 固定搭配 / 例句
    el('btnDetail').addEventListener('click', function (e) {
      e.stopPropagation();
      Detail.openCurrentDetail();
    });

    // 自评揭晓释义后，由用户主动进入下一个单词。
    el('btnMeaningNext').addEventListener('click', function (e) {
      e.stopPropagation();
      Drill.nextFromReveal();
    });

    Stats.bind();   // 统计页的点击/切月/切英中都在 modules/pages/stats.js 里


    // 右上角「熟悉」：这个词算过了，点一下标成已完成，以后不再出现
    var masterBtn = el('btnDrillMaster');
    if (masterBtn) {
      masterBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        Drill.markDone();
      });
    }

    // 收藏当前词：再点一次取消
    el('btnFav').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!state.current) return;
      var on = Favs.toggleFav(state.current.w);
      if (on) beep(660, 0.05);
    });

    // 收藏页：星标取消收藏，点整行看详细
    el('favList').addEventListener('click', function (e) {
      var star = e.target && e.target.closest ? e.target.closest('.fav-btn') : null;
      if (star) {
        e.stopPropagation();
        Favs.toggleFav(star.dataset.fav);
        return;
      }
      var row = e.target && e.target.closest ? e.target.closest('.fav-row') : null;
      if (row) Detail.openDetail(row.dataset.w, row.dataset.ph, row.dataset.def);
    });

    el('favList').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target && e.target.closest ? e.target.closest('.fav-row') : null;
      if (!row || e.target.closest('.fav-btn')) return;
      e.preventDefault();
      Detail.openDetail(row.dataset.w, row.dataset.ph, row.dataset.def);
    });

    el('btnFavGo').addEventListener('click', function () {
      if (!state.current) { Drill.ensureTimer(); Drill.loadNext(); }
      else setView('drill');
    });
    el('detailClose').addEventListener('click', function () { Detail.closeDetail(); });
    el('detailMask').addEventListener('click', function () { Detail.closeDetail(); });
    el('detailBody').addEventListener('scroll', function () { Detail.updateDetailScroll(); });

    // 词库表格：整行点开「详细」，「加进词书」单独拦一层
    el('wordTableBody').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var add = t.closest('.row-add');
      if (add) {
        e.stopPropagation();
        Words.addWordToBook(add.dataset.w);
        return;
      }
      var tr = t.closest('tr');
      if (!tr || !tr.dataset.w) return;
      var item = Words.dictItem(tr.dataset.w);
      if (!item) return;
      Detail.openDetail(item.w, item.ph, item.d, item.ex);
    });

    document.querySelectorAll('.rate').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        Drill.rate(parseInt(b.dataset.grade, 10));
      });
    });

    document.addEventListener('keydown', function (e) {
      // 详细面板打开时，键盘交给面板：只认 Esc，别把 J/K/L 当成自评
      if (Detail.isShown()) {
        if (e.key === 'Escape') { e.preventDefault(); Detail.closeDetail(); }
        return;
      }
      if (state.view !== 'drill') return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        if (tag === 'INPUT' && e.key !== 'Enter') return;
      }

      // 看词阶段先自评：J/K/L 定了级，才揭晓中文
      if (state.phase === 'recall') {
        if (e.key === 'j' || e.key === 'J' || e.key === '1') { e.preventDefault(); Drill.rate(1); return; }
        if (e.key === 'k' || e.key === 'K' || e.key === '2') { e.preventDefault(); Drill.rate(2); return; }
        if (e.key === 'l' || e.key === 'L' || e.key === '3') { e.preventDefault(); Drill.rate(3); return; }
        if (e.key === 'r' || e.key === 'R') { if (state.current) speak(state.current.w, true); return; }
      }

      // 释义已经揭晓：空格 / 回车进入下一个词（按钮有焦点时也走这里，避免触发两次）
      if (state.phase === 'judged') {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); Drill.nextFromReveal(); return; }
        if (e.key === 'r' || e.key === 'R') { if (state.current) speak(state.current.w, true); return; }
      }
    });

    document.addEventListener('keydown', function (e) { KB.visualKey(e, true); });
    document.addEventListener('keyup', function (e) { KB.visualKey(e, false); });
    window.addEventListener('blur', KB.clearKeyboard);

    // 设置项
    document.querySelectorAll('[data-toggle]').forEach(function (node) {
      node.addEventListener('click', function () {
        var key = node.dataset.toggle;
        db.settings[key] = !db.settings[key];
        save();
        applySettings();
        if (key === 'sound' && db.settings.sound) beep(880, 0.06, 'sine', 0.04);
      });
    });

    document.querySelectorAll('[data-seg]').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = seg.dataset.seg;
          var val = b.dataset.val;
          db.settings[key] = key === 'fontScale' ? parseFloat(val) : val;
          save();
          applySettings();
        });
      });
    });

    // 作文打字：在原文位置逐字呈现输入反馈，虚拟键盘位于原文下方。
    // 中英文共用同一套渲染与统计，区别只在数据源、字体和输入法处理。
    var writingStartedAt = 0;
    var writingSource = '';
    var writingInput = el('writingInput');
    var typingLang = 'en';          // en / zh
    var typingComposing = false;    // 中文输入法还在拼拼音：没上屏之前不能按拼音算错

    // 校验一律忽略大小写：原文照原样显示，比较时两边都转小写。
    function sameChar(a, b) {
      return a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
    }

    function typingLangText(lang) {
      var node = el(lang === 'zh' ? 'articleTranslation' : 'articleSource');
      return node ? String(node.value || '').trim() : '';
    }

    function syncTypingLangUi() {
      var view = el('view-typing');
      if (view) view.classList.toggle('is-cn', typingLang === 'zh');
      var label = el('typingSourceLabel');
      if (label) label.textContent = typingLang === 'zh' ? '中文原文' : '英文原文';
      var unit = el('typingSpeedUnit');
      if (unit) unit.textContent = typingLang === 'zh' ? '字/分' : 'WPM';
      var mode = el('typingScreenMode');
      if (mode) mode.textContent = typingLang === 'zh' ? '使用中文输入法输入' : '使用实体键盘输入';
      var kbHint = el('kbHintText');
      if (kbHint) kbHint.textContent = typingLang === 'zh' ? '虚拟键盘 · 用输入法输入' : '虚拟键盘 · 请使用实体键盘输入';
      document.querySelectorAll('[data-typing-lang]').forEach(function (btn) {
        btn.classList.toggle('is-active', btn.dataset.typingLang === typingLang);
      });
    }

    // 方向键、Home/End、翻页键在打字页没意义：它们会把光标从末尾挪走，
    // 下一个字母就插到句子中间，后面整段错位、显示成大片的红。
    // 这里直接拦掉，光标永远钉在末尾。
    var TYPING_CURSOR_KEYS = {
      ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
      Home: 1, End: 1, PageUp: 1, PageDown: 1, Insert: 1, Delete: 1
    };

    // 打字页里焦点一旦跑掉（点页面、拖滚动条之后），空格会变成浏览器的「翻页」键，
    // 结果既翻了页、字也没进输入框。这里兜住：在打字页一敲键就把焦点抓回输入框，
    // 空格永远不翻页——焦点本来丢了的话，手动补一个空格，手感不断。
    document.addEventListener('keydown', function (e) {
      if (state.view !== 'typing') return;
      var inp = el('writingInput');
      if (!inp || inp.disabled) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (TYPING_CURSOR_KEYS[e.key]) {
        // 中文输入法在候选框里选字要用方向键，拼音还没上屏时放行
        if (typingLang === 'zh' && typingComposing) return;
        e.preventDefault();
        if (document.activeElement === inp) inp.setSelectionRange(inp.value.length, inp.value.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Shift') return;
      if (document.activeElement === inp) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        inp.focus();
        inp.value += ' ';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      // 其他可打字的键（字母、退格、回车）同样把焦点抓回来
      if (e.key && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) inp.focus();
    }, true);

    // 当前这一行顶到窗口第一行（打字机式上滚）。
    // 用「当前字符相对第一个字符的纵向距离」当滚动目标，不自己算行高，
    // 所以字号/行距被浏览器放大（手机字体缩放）也不会偏。
    // 内容坐标不受滚动动画影响，连续敲键测得的位置是稳的。
    function keepCursorOnTopLine(host) {
      var chars = host.querySelectorAll('.typing-char');
      if (!chars.length) return;
      var node = host.querySelector('.typing-char.is-current');
      if (!node) node = chars[chars.length - 1];
      var box = host.getBoundingClientRect();
      var scroll = host.scrollTop;
      var curY = node.getBoundingClientRect().top - box.top + scroll;
      var firstY = chars[0].getBoundingClientRect().top - box.top + scroll;
      var target = Math.max(0, Math.round(curY - firstY));
      if (Math.abs(target - scroll) < 1) return;
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // 手动滚远了再回到当前输入位置：直接跳过去，别慢慢滑一大段
      var far = Math.abs(target - scroll) > 200;
      if (host.scrollTo) host.scrollTo({ top: target, behavior: (reduce || far) ? 'auto' : 'smooth' });
      else host.scrollTop = target;
    }

    function renderTypingPrompt(typed, keepScroll) {
      var host = el('typingPrompt'); if (!host) return;
      // 重建字符节点会让 scrollTop 归零，先记住再写回去，避免每敲一键就闪回顶部
      var prevScroll = host.scrollTop;
      host.innerHTML = '';
      for (var i = 0; i < writingSource.length; i++) {
        var span = document.createElement('span'); span.className = 'typing-char';
        if (i < typed.length) span.classList.add(sameChar(typed[i], writingSource[i]) ? 'is-correct' : 'is-wrong');
        else if (i === typed.length) span.classList.add('is-current');
        span.textContent = writingSource[i]; host.appendChild(span);
      }
      if (typed.length > writingSource.length) {
        for (var j = writingSource.length; j < typed.length; j++) {
          var extra = document.createElement('span'); extra.className = 'typing-char is-wrong'; extra.textContent = typed[j]; host.appendChild(extra);
        }
      }
      host.scrollTop = prevScroll;
      if (!keepScroll) keepCursorOnTopLine(host);
    }
    function beginTyping() {
      writingSource = typingLangText(typingLang);
      if (!writingSource) {
        el('articleStatus').textContent = typingLang === 'zh'
          ? '这篇还没有中文译文，先让 AI 生成一篇'
          : '请先生成或填写文章';
        return false;
      }
      typingComposing = false;
      writingInput.disabled = false; writingInput.value = ''; writingStartedAt = Date.now();
      window.__rwTypingStarted = writingStartedAt;
      // 提交成绩要用「这次真正在练的那段字」和语言，不能再拿英文原文去对中文
      window.__rwTyping = { lang: typingLang, source: writingSource, startedAt: writingStartedAt };
      // 背词页留下的「下一步敲哪个键」高亮和状态文字别带到打字页
      KB.clearHint();
      if (el('kbState')) el('kbState').textContent = '等待输入';
      renderTypingPrompt('');
      if (el('typingPrompt')) el('typingPrompt').scrollTop = 0;
      el('typingState').textContent = '开始输入';
      el('articleStatus').textContent = '练习中';
      el('writingErrors').textContent = '0'; el('writingWpm').textContent = '0'; el('writingAccuracy').textContent = '—';
      return true;
    }
    el('btnStartWriting').addEventListener('click', function () {
      if (!beginTyping()) return;
      setView('typing'); writingInput.focus();
    });

    // 中英文切换：正在练就按新语言重开，免得两种文字混在一起
    document.querySelectorAll('[data-typing-lang]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.dataset.typingLang === 'zh' ? 'zh' : 'en';
        if (next === typingLang) return;
        if (state.view === 'typing' && !typingLangText(next)) {
          el('articleStatus').textContent = next === 'zh' ? '这篇还没有中文译文' : '还没有英文原文';
          return;
        }
        typingLang = next;
        syncTypingLangUi();
        if (state.view === 'typing' && beginTyping()) writingInput.focus();
      });
    });
    syncTypingLangUi();

    function refreshTyping() {
      // 兜底：插入点必须停在末尾，任何方式把光标挪走都在这里拽回来，
      // 避免下一个字插进句子中间、后面整段错位。
      if (writingInput.selectionStart !== writingInput.value.length || writingInput.selectionEnd !== writingInput.value.length) {
        try { writingInput.setSelectionRange(writingInput.value.length, writingInput.value.length); } catch (err) {}
      }
      var typed = writingInput.value;
      renderTypingPrompt(typed);
      var mins = Math.max((Date.now() - writingStartedAt) / 60000, 1 / 60000);
      var correct = 0, errors = 0;
      for (var i = 0; i < typed.length; i++) { if (sameChar(typed[i], writingSource[i])) correct++; else errors++; }
      el('writingErrors').textContent = String(errors);
      // 英文按词（5 字符）算 WPM，中文按字算
      el('writingWpm').textContent = String(typingLang === 'zh'
        ? Math.round(correct / mins)
        : Math.round((correct / 5) / mins));
      el('writingAccuracy').textContent = typed.length ? Math.round(correct / typed.length * 100) + '%' : '—';
      el('kbState').textContent = typed.length >= writingSource.length ? '输入完成' : '已输入 ' + typed.length + ' / ' + writingSource.length;
    }

    writingInput.addEventListener('compositionstart', function () { typingComposing = true; });
    writingInput.addEventListener('compositionend', function () {
      typingComposing = false;
      refreshTyping();
    });
    writingInput.addEventListener('input', function () {
      // 拼音还挂在候选框里（value 里是 gongzheng 这种），上屏了再校验
      if (typingComposing) return;
      refreshTyping();
    });
    function returnToArticleView() {
      var writingNav = document.querySelector('.nav-btn[data-view="writing"]');
      if (writingNav) writingNav.click();
    }
    el('btnBackToWriting').addEventListener('click', returnToArticleView);
    el('btnTypingBackBottom').addEventListener('click', returnToArticleView);
    el('btnSubmitWriting').addEventListener('click', function () {
      if (!writingSource) return;
      var typed = writingInput.value, errors = 0, max = Math.max(typed.length, writingSource.length), correct = 0;
      for (var i = 0; i < max; i++) { if (!sameChar(typed[i], writingSource[i])) errors++; else if (i < typed.length) correct++; }
      el('writingErrors').textContent = String(errors);
      el('writingAccuracy').textContent = (max ? Math.round(correct / max * 100) : 0) + '%';
      el('typingState').textContent = errors ? '已提交 · 有差异' : '已完成 · 完全一致';
      el('articleStatus').textContent = '本次练习已提交';
      writingInput.disabled = true;
      // 提交后停在原地看结果，不要因为重绘把窗口滚到文末
      renderTypingPrompt(typed, true);
    });

    // 词库页的搜索/首字母/滚动续批都在 modules/pages/words.js 里
    Words.bind();


    el('btnReset').addEventListener('click', function () {
      if (!confirm('会清空所有学习记录、收藏和导入的词，确定吗？')) return;
      RWStore.remove(storeKey());
      RWLog.clearBook(activeBookId);
      db = load();
      wordCache = null;
      wordIndex = null;
      state.queue = [];
      state.step = 0;
      applySettings();
      closeDrawer();
      setView('today');
    });
  }

  // 回归脚本用：把节奏计算与队列查询暴露出来，便于逐条核对验收场景
  window.__review = {
    schedule: RWSchedule,
    scheduler: RWScheduler,
    applyGrade: applyGrade,
    masteredOn: masteredOn,
    masteredTotal: masteredTotal,
    batchStats: batchStats,
    todayBatch: todayBatch,
    ensureBatch: ensureBatch,
    resetStaleBatch: resetStaleBatch,
    todayDone: Stats.todayDoneCount,
    dailyGoal: Stats.dailyGoal,
    reviewPool: reviewPool,
    duePool: duePool,
    // 给回归脚本直接改记录的入口（只读引用，别在页面里依赖它）
    records: function () { return db.records; },
    dueCount: dueCount,
    overdueCount: overdueCount,
    nextDueIn: nextDueIn,
    max: LADDER_MAX,
    DAY: DAY,
    MIN: MIN,
    // 收藏相关的只读接口，给回归脚本核对持久化与排序
    isFav: Favs.isFav,
    toggleFav: Favs.toggleFav,
    favItems: Favs.favItems,
    syncFavUI: Favs.syncFavUI,
    // 手部 SVG 是懒加载的，回归脚本要能确认：没进打字页就不下载
    ensureHands: KB.ensureHands,
    mountHands: KB.mountHands
  };

  // ================= 启动 =================
  // 打开先落在「今天」：看清还剩多少新词、多少到期，再决定进哪边。
  // 先把 load() 做过的迁移（补 forget_count、老间隔折算成台阶）落盘一次，
  // 免得每次刷新都重算，也保证数据和内存里的状态一致
  save();
  KB.buildKeyboard();
  applySettings();   // hands.js 推迟到进打字页再加载，见 setView('typing')
  bind();
  resetStaleBatch();   // 过了 12 点，昨天没学完的次数清零
  setView('today');
  // 万一没有可学的词（整本书都进了复习间隔），也要把收藏数字摆对
  Favs.syncFavUI();

})();
