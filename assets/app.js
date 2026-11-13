(function () {
  'use strict';

  var STORE_KEY = 'wordtype.v1';
  var BOOKS_KEY = 'reviewwords.books.v1';
  var ACTIVE_BOOK_KEY = 'reviewwords.activeBook.v1';
  var DEFAULT_BOOK_ID = 'redbook-2024';
  var USER_SCOPE = '';
  function readBooks() {
    try { var list = JSON.parse(localStorage.getItem(BOOKS_KEY) || 'null'); if (Array.isArray(list) && list.length) return list; } catch (e) {}
    var initial = [{ id: DEFAULT_BOOK_ID, name: '2024 考研英语词汇·红宝书', kind: 'builtin', createdAt: Date.now(), wordCount: (window.WORD_BANK || []).length }];
    localStorage.setItem(BOOKS_KEY, JSON.stringify(initial)); return initial;
  }
  var books = readBooks();
  var activeBookId = localStorage.getItem(ACTIVE_BOOK_KEY) || DEFAULT_BOOK_ID;
  if (!books.some(function (b) { return b.id === activeBookId; })) activeBookId = DEFAULT_BOOK_ID;
  var MAX_TRIES = 3;
  var MIN = 60000;
  var DAY = 86400000;

  // 动态间隔复习的参数（放这么靠前，是因为 load() 迁移旧数据时要用到 IV_MAX）
  // 首次：忘了 15 分钟、模糊 20 分钟、很熟 1 天
  // 之后：忘了重置 15 分钟；模糊 ×1.5（至少 1 小时）；很熟 ×2.2（至少 1 天）；最多 15 天
  var IV_FORGOT = 15 * MIN;
  var IV_FUZZY = 20 * MIN;
  var IV_FAMILIAR = DAY;
  var IV_FUZZY_MIN = 60 * MIN;
  var IV_FAMILIAR_MIN = DAY;
  var IV_MAX = 15 * DAY;
  var DEFAULTS = {
    theme: 'light',
    sound: true,
    autoplay: true,
    hideAnswer: false,
    showPinyin: true,
    fontScale: 1
  };

  var el = function (id) { return document.getElementById(id); };

  // ================= 存储 =================
  function storeKey() { return STORE_KEY + ':book:' + activeBookId + (USER_SCOPE ? ':' + USER_SCOPE : ''); }
  if (activeBookId === DEFAULT_BOOK_ID && !localStorage.getItem(storeKey()) && localStorage.getItem(STORE_KEY)) {
    localStorage.setItem(storeKey(), localStorage.getItem(STORE_KEY));
  }
  var db = load();

  function load() {
    var raw = {};
    try { raw = JSON.parse(localStorage.getItem(storeKey()) || '{}') || {}; } catch (e) { raw = {}; }
    var recs = raw.records || {};
    // 兼容旧数据：把按「天」存的 due 换成时间戳
    var cap = Date.now() + IV_MAX;
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
      // 新规则上限 15 天：老数据可能算到几个月之后，统一压回上限内，
      // 否则这些词会长期不出现，和「逾期优先」的规则也对不上
      if (r.iv > IV_MAX) r.iv = IV_MAX;
      if (r.dueAt > cap) r.dueAt = cap;
      // 新增字段：累计忘记次数（老数据没有，从 0 起算，不清空任何已有内容）
      if (r.forgot === undefined) r.forgot = 0;
      delete r.interval;
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

  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify(db)); } catch (e) {}
  }

  // 记录字段（复用旧的，不新建结构）：
  //   word          → db.records 的键
  //   review_count  → seen
  //   last_rating   → last
  //   interval      → iv（毫秒；跨「天」时除以 DAY 即为 interval_days）
  //   last_review_at→ lastAt
  //   next_review_at→ dueAt
  //   forget_count  → forgot
  function getRec(word) {
    if (!db.records[word]) {
      db.records[word] = { ease: 2.5, reps: 0, iv: 0, dueAt: 0, last: 0, seen: 0, wrong: 0, lastAt: 0, forgot: 0 };
    }
    var r = db.records[word];
    if (r.dueAt === undefined) r.dueAt = 0;
    if (r.iv === undefined) r.iv = 0;
    if (r.forgot === undefined) r.forgot = 0;
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

  // ================= 日期 =================
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function dayEntry() {
    var k = todayKey();
    if (!db.days[k]) db.days[k] = { words: 0, clean: 0, chars: 0, seconds: 0, newWords: 0 };
    return db.days[k];
  }

  function mmss(sec) {
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
  }

  // 「3 分钟前」「2 天后」这类相对时间，给复习提示用
  function humanGap(ms) {
    var a = Math.abs(ms);
    var s = Math.round(a / 1000);
    if (s < 50) return '刚刚';
    var m = Math.round(s / 60);
    if (m < 60) return m + '分钟';
    var h = Math.round(m / 60);
    if (h < 24) return h + '小时';
    var d = Math.round(h / 24);
    if (d < 30) return d + '天';
    return Math.round(d / 30) + '个月';
  }

  // ================= 动态间隔复习 =================
  // 参数见文件头的 IV_* 常量。全部按「实际完成评价的时刻」起算，存时间戳，
  // 不碰日期字符串，所以跨天、跨月、跨年、换时区都不会算错。

  // 向上取整到分钟：30.0001 分钟这类零头不进位会越滚越偏
  function ceilMinute(ms) {
    return Math.ceil(ms / MIN) * MIN;
  }

  // 算出这次评价之后该隔多久再出现
  function nextInterval(rec, grade) {
    var first = !(rec.seen > 0);        // 第一次评价这个单词
    var prev = rec.iv || 0;             // 上一次的复习间隔
    var next;
    if (grade === 1) {
      next = IV_FORGOT;                 // 忘了：不论第几次都重置
    } else if (grade === 2) {
      next = first ? IV_FUZZY : Math.max(IV_FUZZY_MIN, ceilMinute(prev * 1.5));
    } else {
      next = first ? IV_FAMILIAR : Math.max(IV_FAMILIAR_MIN, ceilMinute(prev * 2.2));
    }
    return Math.min(next, IV_MAX);
  }

  // 写入一条复习记录：interval / next_review_at / last_rating / last_review_at
  // 复用现有字段：iv = interval_days、dueAt = next_review_at、
  // last = last_rating、lastAt = last_review_at、seen = review_count、forgot = forget_count
  function applyGrade(rec, grade) {
    var now = Date.now();
    rec.iv = nextInterval(rec, grade);
    rec.dueAt = now + rec.iv;
    rec.last = grade;
    rec.lastAt = now;
    if (grade === 1) rec.forgot = (rec.forgot || 0) + 1;
  }

  // ================= 取词 =================
  // 到期待复习的词，逾期最久的排最前
  // 只认 dueAt：评价完立刻把 dueAt 推到未来，自然就离开了当前队列，
  // 同一轮里不会再次被抽到；到期没复习也不会被自动顺延
  function duePool(now) {
    var ws = allWords(), out = [];
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.seen > 0 && r.dueAt <= now) {
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
      if (r.seen > 0 && r.dueAt <= now && ks[i] !== cur) n++;
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
      if (r.seen > 0 && r.dueAt > 0 && now - r.dueAt > DAY && ks[i] !== cur) n++;
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
      if (r.seen > 0 && r.dueAt > now && (!best || r.dueAt < best)) best = r.dueAt;
    }
    return best ? best - now : 0;
  }

  // 倒计时文案：向上取整，免得 14:59 显示成「15 分钟」
  function countdownText(ms) {
    if (ms < MIN) return '不到 1 分钟后';
    if (ms < 60 * MIN) return Math.ceil(ms / MIN) + ' 分钟后';
    if (ms < DAY) return Math.ceil(ms / (60 * MIN)) + ' 小时后';
    var d = ms / DAY;
    return (d < 10 ? Math.ceil(d * 10) / 10 : Math.ceil(d)) + ' 天后';
  }

  // 下一个没学过的词，严格按书的顺序
  function nextNew() {
    var ws = allWords();
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (!r || !r.seen) return ws[i];
    }
    return null;
  }

  // 返回 { w, mode }：mode = due（到期复习）/ new（新词）
  // 到期复习永远优先于新词，但两者都不设数量上限
  function pickNext() {
    if (state.forced.length) return { w: state.forced.shift(), mode: 'due' };

    var due = duePool(Date.now());
    if (due.length) return { w: due[0].w, mode: 'due' };

    var fresh = nextNew();
    if (fresh) return { w: fresh, mode: 'new' };

    return null;
  }

  // 卡里最该复习的 n 个词，用来「再复习一组」
  function reviewBatch(n) {
    var ws = allWords().filter(function (w) {
      var r = db.records[w.w];
      return r && r.seen > 0;
    });
    ws.sort(function (a, b) {
      return (db.records[a.w].dueAt || 0) - (db.records[b.w].dueAt || 0);
    });
    return ws.slice(0, n);
  }

  // ================= 状态 =================
  var state = {
    view: 'drill',
    phase: 'idle',
    current: null,
    origin: 'new',
    grade: 0,
    errors: 0,
    mistakes: 0,
    locked: false,
    lockValue: '',
    composing: false,
    committed: '',
    comp: '',
    wordStart: 0,
    step: 0,
    forced: []
  };

  var timerId = null;
  var startedAt = Date.now();


  // ================= 键盘指法 =================
  var KB_ROWS = [
    [['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'],
     ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'],
     ['Digit0', '0'], ['Minus', '-'], ['Equal', '='], ['Backspace', '退格', 2.05, 1]],
    [['Tab', 'tab', 1.5, 1], ['KeyQ', 'q'], ['KeyW', 'w'], ['KeyE', 'e'], ['KeyR', 'r'],
     ['KeyT', 't'], ['KeyY', 'y'], ['KeyU', 'u'], ['KeyI', 'i'], ['KeyO', 'o'],
     ['KeyP', 'p'], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 1.5, 1]],
    [['CapsLock', 'caps', 1.8, 1], ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd'],
     ['KeyF', 'f'], ['KeyG', 'g'], ['KeyH', 'h'], ['KeyJ', 'j'], ['KeyK', 'k'],
     ['KeyL', 'l'], ['Semicolon', ';'], ['Quote', "'"], ['Enter', '回车', 2.2, 1]],
    [['ShiftLeft', 'shift', 2.2, 1], ['KeyZ', 'z'], ['KeyX', 'x'], ['KeyC', 'c'],
     ['KeyV', 'v'], ['KeyB', 'b'], ['KeyN', 'n'], ['KeyM', 'm'], ['Comma', ','],
     ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'shift', 2.2, 1]],
    [['ControlLeft', 'ctrl', 1.4, 1], ['AltLeft', 'alt', 1.2, 1], ['Space', '空格', 7.2],
     ['AltRight', 'alt', 1.2, 1], ['ControlRight', 'ctrl', 1.4, 1]]
  ];

  var FINGER_MAP = {};
  [
    ['left-pinky', ['Backquote', 'Digit1', 'KeyQ', 'KeyA', 'KeyZ', 'Tab', 'CapsLock', 'ShiftLeft', 'ControlLeft']],
    ['left-ring', ['Digit2', 'KeyW', 'KeyS', 'KeyX']],
    ['left-middle', ['Digit3', 'KeyE', 'KeyD', 'KeyC']],
    ['left-index', ['Digit4', 'Digit5', 'KeyR', 'KeyT', 'KeyF', 'KeyG', 'KeyV', 'KeyB']],
    ['right-index', ['Digit6', 'Digit7', 'KeyY', 'KeyU', 'KeyH', 'KeyJ', 'KeyN', 'KeyM']],
    ['right-middle', ['Digit8', 'KeyI', 'KeyK', 'Comma']],
    ['right-ring', ['Digit9', 'KeyO', 'KeyL', 'Period']],
    ['right-pinky', ['Digit0', 'Minus', 'Equal', 'KeyP', 'BracketLeft', 'BracketRight',
      'Backslash', 'Semicolon', 'Quote', 'Slash', 'Enter', 'Backspace', 'ShiftRight', 'ControlRight']],
    ['thumb', ['Space', 'AltLeft', 'AltRight']]
  ].forEach(function (g) {
    g[1].forEach(function (code) { FINGER_MAP[code] = g[0]; });
  });

  var FINGER_NAMES = {
    'left-pinky': '左手小指',
    'left-ring': '左手无名指',
    'left-middle': '左手中指',
    'left-index': '左手食指',
    'right-index': '右手食指',
    'right-middle': '右手中指',
    'right-ring': '右手无名指',
    'right-pinky': '右手小指',
    'thumb': '拇指'
  };

  function buildKeyboard() {
    var board = el('kbBoard');
    if (!board) return;
    board.innerHTML = KB_ROWS.map(function (row) {
      return '<div class="kb-row">' + row.map(function (k) {
        var flex = k[2] ? ' style="flex:' + k[2] + ' 1 0"' : '';
        var cls = 'kb-key' + (k[3] ? ' is-wide' : '') + (k[0] === 'Space' ? ' kb-space' : '');
        return '<span class="' + cls + '" data-code="' + k[0] + '" data-label="' + k[1] + '"' + flex + '>' +
          k[1] + '</span>';
      }).join('') + '</div>';
    }).join('');
  }

  function eventCode(e) {
    var c = e.code || '';
    if (c === 'NumpadEnter') return 'Enter';
    if (c) return c;

    var k = e.key || '';
    if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    var fallback = {
      ' ': 'Space', 'Backspace': 'Backspace', 'Enter': 'Enter', 'Tab': 'Tab',
      'CapsLock': 'CapsLock', 'Shift': 'ShiftLeft', 'Control': 'ControlLeft',
      'Alt': 'AltLeft', '`': 'Backquote', '-': 'Minus', '=': 'Equal',
      '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
      "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash'
    };
    return fallback[k] || '';
  }

  // ================= 手部 =================
  // 照搬 edclub 的机制：一张 716×380 的 SVG 里预先画好 58 个姿势图层，
  // 每个图层就是一整只手的静态画（放松 / 某根手指按某个键）。
  // 运行时只切 display，不做任何变形计算；左右手各显示一层，同时出现。

  // KeyboardEvent.code → 图层 id
  var LAYER_OF_CODE = {
    Backquote: 'tilda', Digit1: 'key-1', Digit2: 'key-2', Digit3: 'key-3', Digit4: 'key-4',
    Digit5: 'key-5', Digit6: 'key-6', Digit7: 'key-7', Digit8: 'key-8', Digit9: 'key-9',
    Digit0: 'key-0', Minus: 'minus', Equal: 'equal',
    BracketLeft: 'open-bracket', BracketRight: 'close-bracket', Backslash: 'backslash',
    KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u',
    KeyI: 'i', KeyO: 'o', KeyP: 'p',
    KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyJ: 'j',
    KeyK: 'k', KeyL: 'l',
    KeyZ: 'z', KeyX: 'x', KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm',
    Semicolon: 'semicolon', Quote: 'quote', Comma: 'comma', Period: 'dot', Slash: 'slash',
    Tab: 'tab', Enter: 'enter', Space: 'space',
    ShiftLeft: 'shift-left', ShiftRight: 'shift-right'
  };

  // 按住键的先后顺序，最新的在最前
  var heldStack = [];

  // 键盘提示：hintCode 是当前要伸手指的那个键（手部用），
  // hintKey 是提示状态的指纹，只有它变了才动 DOM
  var hintCode = '';
  var hintKey = '';

  function heldPush(code) {
    var i = heldStack.indexOf(code);
    if (i >= 0) heldStack.splice(i, 1);
    heldStack.unshift(code);
  }

  function heldDrop(code) {
    var i = heldStack.indexOf(code);
    if (i >= 0) heldStack.splice(i, 1);
  }

  // 某个手该显示哪一层：取这只手最近按下的键；
  // 没有按键（或该键没有画姿势层）就用放松层。
  function layerOfHand(side) {
    var neutral = side === 'left' ? 'neutral-left' : 'neutral-right';
    for (var i = 0; i < heldStack.length; i++) {
      var f = FINGER_MAP[heldStack[i]];
      if (!f) continue;
      var belong = f === 'thumb' ? 'right' : f.split('-')[0];
      if (belong !== side) continue;
      var layer = LAYER_OF_CODE[heldStack[i]];
      if (layer) return layer;
    }

    // 没按键时，把「下一个要敲的字母」那条手指伸到键上，当作指法提示
    var hf = FINGER_MAP[hintCode];
    if (hf && hintCode) {
      var hSide = hf === 'thumb' ? 'right' : hf.split('-')[0];
      if (hSide === side && LAYER_OF_CODE[hintCode]) return LAYER_OF_CODE[hintCode];
    }

    return neutral;
  }

  // 与 edclub 的 focus_hand(l, r) 逐行对应：
  // 两只手各亮一层，缺的一侧退回 neutral。
  function focusHand(leftId, rightId) {
    var host = el('handsSvg');
    if (!host) return;
    var layers = host.querySelectorAll('g.st0');
    var shown = [false, false];
    var neutral = [null, null];

    for (var i = 0; i < layers.length; i++) {
      var g = layers[i];
      var id = g.id.replace(/^hb-/, '');
      if (id === 'neutral-left') neutral[0] = g;
      if (id === 'neutral-right') neutral[1] = g;
      if (id === leftId || id === rightId) {
        g.style.display = 'block';
        shown[id === leftId ? 0 : 1] = true;
      } else {
        g.style.display = 'none';
      }
    }

    for (var k = 0; k < 2; k++) {
      if (!shown[k] && neutral[k]) neutral[k].style.display = 'block';
    }
  }

  function syncHands() {
    focusHand(layerOfHand('left'), layerOfHand('right'));
  }

  // ===== 下一个字母的指法提示 =====
  // 整串推进：从当前字开始，把后面所有字的拼音接成一条，减去输入法缓冲里已敲的字母，
  // 剩下的第一个就是下一个字母。这样一路敲到底，不会在每个字边界停下。
  function restPinyin() {
    var w = state.current;
    if (!w) return '';
    var chars = Array.from(w.a || '');
    var py = pinyinAlign(w.a || '');
    var typed = Array.from(state.committed || '').length;
    var rest = '';
    for (var j = typed; j < chars.length; j++) rest += (py[j] || '');
    return rest.replace(/ü/g, 'v').replace(/[^a-z]/g, '');
  }

  // 键盘常驻，时刻告诉用户“现在该做什么”。
  // codes: 要高亮的键（可能多个）；text: 状态栏文案；hand: 手部要伸到哪个键
  function hintState() {
    var out = { codes: [], text: '', hand: '' };
    if (state.view !== 'drill') return out;

    // ① 看词自评：J / K / L 三选一，三个键一起亮
    if (state.phase === 'recall') {
      out.codes = ['KeyJ', 'KeyK', 'KeyL'];
      out.text = '选择记忆程度 · J 忘了 / K 模糊 / L 很熟';
      return out;
    }

    if (state.phase !== 'typing') return out;

    // ② 打错了被锁住：先把错的删掉
    if (state.locked) {
      out.codes = ['Backspace'];
      out.text = '打错了 · Backspace 删掉重来';
      return out;
    }

    var w = state.current;
    if (!w) return out;

    var chars = Array.from(w.a || '');
    var typed = Array.from(state.committed || '').length;

    // ③ 答案已全部上屏：Enter 提交
    if (typed >= chars.length) {
      out.codes = ['Enter'];
      out.text = '答案已输入完 · Enter 提交';
      out.hand = 'Enter';
      return out;
    }

    // 开了「隐藏答案」就不再提示字母，否则等于把读音漏出来
    if (db.settings.hideAnswer) {
      out.text = '按拼音输入中文';
      return out;
    }

    var target = restPinyin();
    if (!target) return out;

    var buf = String(state.comp || '').toLowerCase().replace(/[^a-z]/g, '');
    var n = 0;
    while (n < buf.length && n < target.length && buf.charAt(n) === target.charAt(n)) n++;

    // ④ 整串拼音敲完：空格上屏
    if (n >= target.length) {
      out.codes = ['Space'];
      out.text = '拼音已敲完 · 空格上屏';
      out.hand = 'Space';
      return out;
    }

    // ⑤ 逐字母提示；敲错/简拼对不上时，提示的仍是「这一位该敲的字母」，把人带回来
    var letter = target.charAt(n);
    var code = 'Key' + letter.toUpperCase();
    var name = FINGER_NAMES[FINGER_MAP[code]] || '';
    out.codes = [code];
    out.text = '下一个 ' + letter + (name ? ' · ' + name : '');
    out.hand = code;
    return out;
  }

  function clearHint() {
    hintCode = '';
    hintKey = '';
    document.querySelectorAll('.kb-key.is-hint').forEach(function (n) {
      n.classList.remove('is-hint');
    });
  }

  // 提示变化时才动 DOM：换高亮的键、换手的图层
  function updateHint() {
    var h = hintState();
    var codes = h.codes || [];
    var fp = codes.join(',') + '|' + h.text;

    if (fp === hintKey) return;
    hintKey = fp;

    hintCode = h.hand || '';

    document.querySelectorAll('.kb-key.is-hint').forEach(function (n) {
      n.classList.remove('is-hint');
    });
    codes.forEach(function (code) {
      var keyEl = document.querySelector('.kb-key[data-code="' + code + '"]');
      if (keyEl) keyEl.classList.add('is-hint');
    });

    syncHands();
    if (!document.querySelector('.kb-key.is-down')) {
      var live = el('kbState');
      if (live) live.textContent = h.text || '';
    }
  }

  function mountHands() {
    var host = el('handsSvg');
    if (!host || !window.HANDS_SVG) return;
    host.innerHTML = window.HANDS_SVG;
    syncHands();
  }

  function clearKeyboard() {
    document.querySelectorAll('.kb-key.is-down').forEach(function (n) { n.classList.remove('is-down'); });
    heldStack = [];
    clearHint();
    syncHands();
    var live = el('kbState');
    if (live) live.textContent = '等待输入';
  }

  function showKeyboard(on) {
    var dock = el('keyboardDock');
    if (!dock) return;
    dock.classList.toggle('on', !!on);
    dock.setAttribute('aria-hidden', on ? 'false' : 'true');
    var drill = document.querySelector('.drill');
    if (drill) drill.classList.toggle('kb-open', !!on);
    if (on) syncHands(); else clearKeyboard();
  }

  function visualKey(e, down) {
    if (state.view !== 'typing' && state.view !== 'drill') return;
    if (state.view === 'drill' && state.phase !== 'typing' && state.phase !== 'recall') return;
    // 作文训练只响应真实键盘事件，不允许点击屏幕键盘代替输入。
    if (down && state.view === 'typing' && document.activeElement !== el('writingInput')) return;
    if (down && state.view === 'drill' && state.phase === 'typing' && document.activeElement !== el('typeInput')) return;
    var code = eventCode(e);
    if (!code) return;
    var key = document.querySelector('.kb-key[data-code="' + code + '"]');
    if (!key) return;

    key.classList.toggle('is-down', !!down);
    if (down) heldPush(code); else heldDrop(code);
    syncHands();
    var finger = FINGER_MAP[code];

    if (down) {
      var name = FINGER_NAMES[finger] || '';
      el('kbState').textContent = (key.dataset.label || '') + (name ? ' · ' + name : '');
    } else if (!document.querySelector('.kb-key.is-down')) {
      el('kbState').textContent = hintState().text || '';
    }
  }

  // ================= 音效 =================
  var actx = null;
  var noiseBuf = null;

  function ensureCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function noiseSource() {
    if (!noiseBuf) {
      // 一段平坦白噪，包络完全交给 gain 控制，这样每次敲击都能硬起硬落
      var len = Math.floor(actx.sampleRate * 0.06);
      noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    var s = actx.createBufferSource();
    s.buffer = noiseBuf;
    return s;
  }

  // 机械键盘「嗒」：1.5ms 起音 + 十几毫秒急收，不留尾巴
  // kind: 'down' 按下 / 'up' 抬起 / 'space' 空格 / 'enter' 回车
  var CLICK = {
    down: { f: 3300, q: 0.95, hp: 1300, dur: 0.021, amp: 0.62, body: 0.042, bf: 620 },
    up: { f: 4700, q: 1.2, hp: 2200, dur: 0.012, amp: 0.30, body: 0.012, bf: 760 },
    space: { f: 2900, q: 0.8, hp: 1100, dur: 0.025, amp: 0.68, body: 0.058, bf: 420 },
    enter: { f: 2600, q: 0.78, hp: 1000, dur: 0.028, amp: 0.70, body: 0.062, bf: 350 }
  };

  function keyClick(kind) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;

    var c = CLICK[kind] || CLICK.down;
    var t = actx.currentTime;
    var j = 0.94 + Math.random() * 0.12;

    try {
      var src = noiseSource();
      var bp = actx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = c.f * j;
      bp.Q.value = c.q;

      var hp = actx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = c.hp;

      // 提亮 7.2kHz，让「嗒」更脆
      var pk = actx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = 7200 * j;
      pk.Q.value = 1.1;
      pk.gain.value = 8;

      var g1 = actx.createGain();
      g1.gain.setValueAtTime(0, t);
      g1.gain.linearRampToValueAtTime(c.amp, t + 0.0015);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);

      src.connect(bp); bp.connect(hp); hp.connect(pk); pk.connect(g1); g1.connect(actx.destination);
      src.start(t); src.stop(t + c.dur + 0.004);

      // 一点点腔体厚度，只做 10ms 左右的起音，不拖
      if (c.body > 0.012) {
        var o = actx.createOscillator();
        var g2 = actx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(c.bf * j, t);
        o.frequency.exponentialRampToValueAtTime(c.bf * 0.5, t + c.dur * 0.7);
        g2.gain.setValueAtTime(0, t);
        g2.gain.linearRampToValueAtTime(c.body, t + 0.0018);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + c.dur * 0.8);
        o.connect(g2); g2.connect(actx.destination);
        o.start(t); o.stop(t + c.dur);
      }
    } catch (e) {}
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

  function isClickKey(e) {
    var k = e.key;
    if (!k) return false;
    return k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta' &&
      k !== 'CapsLock' && k !== 'AltGraph' && k !== 'Tab' && k !== 'Dead' &&
      k !== 'ContextMenu' && k !== 'Escape';
  }

  // 打错的提示音：两声下行的方波，明显区别于键盘咔声
  function errBeep(vol) {
    if (!db.settings.sound) return;
    if (!ensureCtx()) return;
    try {
      var t = actx.currentTime;
      var lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1900;
      lp.connect(actx.destination);

      [0, 0.085].forEach(function (off, i) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'square';
        o.frequency.value = i ? 152 : 214;
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.linearRampToValueAtTime(vol || 0.15, t + off + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.075);
        o.connect(g); g.connect(lp);
        o.start(t + off); o.stop(t + off + 0.09);
      });
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
    if (state.forced.length) return state.forced[0];
    var due = duePool(Date.now());
    if (due.length) return due[0].w;
    return nextNew();
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

  function normalize(s) {
    return String(s)
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。、；：！？·…—\-–—""''（）()《》〈〉【】\[\]{}~～]/g, '')
      .toLowerCase();
  }

  function extractAnswer(def) {
    var s = String(def).replace(/^[a-zA-Z]{1,5}\.\s*/, '');
    s = s.split(/[；;、\/]/)[0];
    s = s.replace(/[\s，。,.；;、：:]/g, '');
    return s.slice(0, 14);
  }

  // ================= 拼音 =================
  var HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/;
  var pyCache = {};

  // 返回与字符一一对应的无声调拼音；非汉字位置为空串
  function pinyinAlign(text) {
    if (pyCache[text]) return pyCache[text];

    var chars = Array.from(text);
    var out = chars.map(function () { return ''; });
    var zh = '', idx = [];

    chars.forEach(function (c, i) {
      if (HAN.test(c)) { zh += c; idx.push(i); }
    });

    var arr = [];
    if (zh && window.pinyinPro) {
      try {
        arr = window.pinyinPro.pinyin(zh, { toneType: 'none', type: 'array', nonZh: 'removed' }) || [];
      } catch (e) { arr = []; }
    }

    idx.forEach(function (pos, k) {
      var p = String(arr[k] || '').toLowerCase();
      out[pos] = /^[a-zü]+$/.test(p) ? p : '';
    });

    pyCache[text] = out;
    return out;
  }

  // ================= 视图切换 =================
  function setView(name) {
    state.view = name;
    ['drill', 'done', 'writing', 'typing', 'article-history', 'books', 'stats', 'words', 'favs'].forEach(function (v) {
      var node = el('view-' + v);
      if (node) node.classList.toggle('is-active', v === name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name || (name === 'typing' && b.dataset.view === 'writing') || (name === 'done' && b.dataset.view === 'drill'));
    });
    if (name === 'stats') renderStats();
    if (name === 'words') renderWords(true);
    if (name === 'favs') renderFavs();
    // 键盘和手部提示只属于作文训练，不再出现在背词页。
    showKeyboard(name === 'typing');
    document.body.classList.toggle('is-typing-screen', name === 'typing');
    if (name === 'drill') updateHint();
    // 学习页锁住文档滚动：练习时页面不能因为聚焦、锚定或内容变高而整体位移
    var lock = name === 'drill';
    document.documentElement.classList.toggle('is-drill-locked', lock);
    document.body.classList.toggle('is-drill-locked', lock);
    if (!lock) window.scrollTo(0, 0);
    // 切走再回来时星标要跟上（收藏页里取消过收藏，学习页的星标也得灭掉）
    syncFavUI();
  }

  // ================= 学习流程 =================
  // 没有「每日任务」：进来就接着上次的位置往下走，取词规则见 pickNext
  function loadNext() {
    var pick = pickNext();
    if (!pick) { endAll(); return; }
    setView('drill');
    loadWord(pick.w, pick.mode);
  }

  function startTimer() {
    stopTimer();
    el('drillTimer').textContent = '00:00';
    startedAt = Date.now();
    timerId = setInterval(function () {
      el('drillTimer').textContent = mmss(Math.floor((Date.now() - startedAt) / 1000));
      // 停在一个词上不动时，「下一词 3 分钟后」要跟着走秒，到点了也要翻成待复习
      refreshDueStat();
    }, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function loadWord(w, mode) {
    state.current = w;
    state.origin = mode || 'new';
    state.phase = 'recall';
    state.grade = 0;
    state.errors = 0;
    state.mistakes = 0;
    state.locked = false;
    state.lockValue = '';
    state.wordStart = Date.now();

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
    el('typeRow').classList.remove('show');
    // 这一屏还没有答案，把答案区收起来，别留一大片空白
    document.querySelector('.drill').classList.add('is-recall');
    document.querySelector('.drill').classList.remove('is-reveal');
    // 背词阶段只看词义并自评；键盘与手部动画统一放到作文训练。
    showKeyboard(false);

    var inp = el('typeInput');
    inp.value = '';
    inp.disabled = true;
    inp.classList.remove('is-ok', 'is-bad');
    state.committed = '';
    state.comp = '';

    setFeedback('');
    renderAnswer();
    renderProgress();
    syncFavUI();
    el('hints').textContent = hintText(w, state.origin);

    if (db.settings.autoplay) speak(w.w);
    preloadNext();
  }

  // 提示语随取词来源变化：复习的词告诉用户隔了多久、有没有逾期
  function hintText(w, mode) {
    var tail = '　·　R 重听发音';
    var rate = 'J 忘了　·　K 模糊　·　L 很熟';
    if (mode === 'due') {
      var r = db.records[w.w];
      var gap = r && r.lastAt ? humanGap(Date.now() - r.lastAt) : '';
      var late = r && r.dueAt && Date.now() - r.dueAt > DAY
        ? ' · 已逾期 ' + humanGap(Date.now() - r.dueAt)
        : '';
      return '复习间隔到了' + (gap ? ' · 距上次 ' + gap : '') + late + '　·　' + rate + tail;
    }
    return '先凭印象判断：' + rate + tail;
  }

  function renderProgress() {
    var ws = allWords();
    var learned = 0;
    for (var i = 0; i < ws.length; i++) {
      var r = db.records[ws[i].w];
      if (r && r.seen > 0) learned++;
    }
    var total = ws.length || 1;
    el('drillIndex').textContent = '已学 ' + learned + ' / ' + ws.length;
    el('drillBar').style.width = (learned / total) * 100 + '%';

    // 复习队列的实时状态：待复习（含逾期）与其中已逾期多少；
    // 一个都没到期时，报出最近的一个还要多久回来，否则永远是「待复习 0」
    refreshDueStat();
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

  // ================= 打字判定 =================
  function firstMismatch(typed) {
    var w = state.current;
    if (!w) return -1;
    var chars = Array.from(w.a || '');
    for (var i = 0; i < typed.length; i++) {
      if (i >= chars.length || typed[i] !== chars[i]) return i;
    }
    return -1;
  }

  function onWrongChar() {
    errBeep(0.16);
    var ans = el('answerText');
    ans.classList.add('shake');
    setTimeout(function () { ans.classList.remove('shake'); }, 340);
    setFeedback('打错了 · Backspace 删掉这个字再继续', 'bad');
  }

  function refreshTyped() {
    var inp = el('typeInput');
    state.committed = inp.value;
    var bad = firstMismatch(Array.from(state.committed));

    if (bad >= 0) {
      if (!state.locked) {
        state.locked = true;
        state.lockValue = inp.value;
        state.mistakes += 1;
        onWrongChar();
      }
    } else if (state.locked) {
      state.locked = false;
      setFeedback('');
    }

    renderAnswer();
  }

  // 上锁期间只接受从尾部删除，其它一律回滚
  function acceptEdit() {
    var inp = el('typeInput');
    if (state.locked) {
      var v = inp.value, old = state.lockValue;
      var isDelete = v.length < old.length && old.indexOf(v) === 0;
      if (v !== old && !isDelete) {
        inp.value = old;
        renderAnswer();
        beep(120, 0.03, 'square', 0.028);
        return;
      }
    }
    refreshTyped();
  }

  function renderAnswer() {
    var w = state.current;
    if (!w) return;

    var host = el('answerText');
    var chars = Array.from(w.a || '');
    var py = pinyinAlign(w.a || '');
    var typed = Array.from(state.committed || '');
    var masked = state.phase === 'recall' || state.phase === 'idle';
    var hide = db.settings.hideAnswer && state.phase === 'typing';
    var showPy = !masked && !hide && db.settings.showPinyin !== false;

    // 自评阶段整个答案区都不出现，连字数也不透露
    if (masked) {
      host.innerHTML = '';
      updateHint();
      return;
    }

    // 每个字起始位置对应的字母序号
    var pre = [0];
    for (var k = 0; k < chars.length; k++) pre.push(pre[k] + (py[k] || '').length);
    var base = pre[Math.min(typed.length, chars.length)];

    // 输入法组词中：数出当前已经敲对的字母（前缀匹配，错位即停）
    var compOn = 0;
    var comp = String(state.comp || '').toLowerCase().replace(/[^a-z]/g, '');
    if (showPy && comp && !state.locked) {
      var rest = '';
      for (var j = typed.length; j < chars.length; j++) rest += (py[j] || '');
      rest = rest.replace(/ü/g, 'v');
      var n = 0;
      while (n < comp.length && n < rest.length && comp.charAt(n) === rest.charAt(n)) n++;
      compOn = n;
    }

    var html = '';

    // 下一个待敲字母在整串拼音里的序号（用于拼音行与键盘的同步提示）
    var nextIdx = base + compOn;
    // 一路走到整条拼音串末尾：字边界不再是提示的终点
    var nxLimit = pre[chars.length];

    chars.forEach(function (ch, i) {
      var cls = 'pending';
      if (i < typed.length) cls = typed[i] === ch ? 'ok' : 'bad';

      if (hide) {
        var color = cls === 'ok' ? '--accent' : cls === 'bad' ? '--bad' : '--pending';
        html += '<span class="cell"><span class="py"></span>' +
          '<span class="mask" style="opacity:1;background:var(' + color + ')"></span></span>';
        return;
      }

      var pyHtml = '';
      var p = py[i] || '';
      if (showPy && p) {
        pyHtml = Array.from(p).map(function (L, li) {
          var g = pre[i] + li;
          var on = i < typed.length
            ? cls === 'ok'
            : (g >= base && g < base + compOn);
          // 紧挨着已敲字母后的那一个，就是键盘上要提示、手指要落下的字母
          var nx = (!on && !state.locked && state.phase === 'typing' && g === nextIdx && nextIdx < nxLimit);
          return '<i class="' + (on ? 'on' : '') + (nx ? ' nx' : '') + '">' + esc(L) + '</i>';
        }).join('');
      }

      html += '<span class="cell">' +
        '<span class="py">' + pyHtml + '</span>' +
        '<span class="ch ' + cls + '">' + esc(ch) + '</span>' +
        '</span>';
    });

    if (!hide && typed.length > chars.length) {
      for (var i = chars.length; i < typed.length; i++) {
        html += '<span class="cell"><span class="py"></span>' +
          '<span class="ch bad">' + esc(typed[i]) + '</span></span>';
      }
    }

    host.innerHTML = html;
    updateHint();
  }

  function setFeedback(msg, kind) {
    var f = el('feedback');
    f.textContent = msg || '';
    f.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  // 自评揭晓：把中文意思放进原来打字的大字位置，任何窗口高度都先看到意思；
  // 完整释义、已记录提示依次排在下面，实在放不下时先裁掉最下面的提示。
  function renderMeaning() {
    var w = state.current;
    if (!w) return;
    el('answerText').innerHTML =
      '<span class="reveal-answer">' + esc(w.a || w.def || '') + '</span>';
  }

  // 背词只做熟悉度判断。先保存复习记录，再停留在当前词上展示中文释义。
  function rate(g) {
    if (state.phase !== 'recall') return;
    state.grade = g;
    finish(true, g, true, true);

    // 揭晓释义；详细词根、搭配和例句仍由原有「详细释义」抽屉按需加载。
    document.querySelector('.drill').classList.remove('is-recall');
    document.querySelector('.drill').classList.add('is-reveal');
    renderMeaning();
    // 用户只需要看到单词意思；复习等级和间隔继续在后台记录，不在揭晓区显示。
    el('fullDef').classList.remove('show');
    el('rateFeedback').hidden = true;
    el('rateFeedback').textContent = '';
    el('rateRow').classList.remove('show');
    el('rateRow').classList.add('is-finished');
    el('btnMeaningNext').hidden = false;
    el('btnMeaningNext').focus();
    el('hints').textContent = '空格 / 回车 下一个单词　·　R 重听发音';
  }

  function submit() {
    if (state.phase !== 'typing') return;

    var w = state.current;
    var inp = el('typeInput');
    var typed = inp.value;
    if (!typed.trim()) return;

    if (normalize(typed) === normalize(w.a)) {
      finish(true);
      return;
    }

    state.errors += 1;
    inp.classList.add('is-bad');
    el('typeRow').classList.add('shake');
    errBeep(0.14);
    setTimeout(function () { el('typeRow').classList.remove('shake'); }, 360);

    if (state.errors >= MAX_TRIES) {
      state.phase = 'judged';
      inp.value = w.a;
      state.committed = w.a;
      state.comp = '';
      state.locked = false;
      state.lockValue = '';
      renderAnswer();
      setFeedback('已给出答案 · 这个词记为「忘了」', 'bad');
      setTimeout(function () { finish(false, 1); }, 1200);
      return;
    }

    setFeedback('不对，再试一次（还剩 ' + (MAX_TRIES - state.errors) + ' 次）', 'bad');
    inp.value = '';
    state.committed = '';
    state.comp = '';
    state.locked = false;
    state.lockValue = '';
    renderAnswer();
    setTimeout(function () { inp.classList.remove('is-bad'); }, 500);
  }

  function finish(ok, forcedGrade, reviewOnly, holdForMeaning) {
    if (state.phase === 'judged' && !forcedGrade) return;
    state.phase = 'judged';
    updateHint();   // 这一词已结束，清掉键位提示

    var w = state.current;
    var rec = getRec(w.w);
    var wasNew = rec.seen === 0;

    var grade = forcedGrade || state.grade || 2;
    if (db.settings.hideAnswer && state.errors > 0) grade = Math.min(grade, 2);

    // applyGrade 内部写 iv / dueAt / last / lastAt / forgot，这里不再重复写时间
    applyGrade(rec, grade);
    rec.seen += 1;
    if (reviewOnly ? grade < 3 : (!ok || state.errors > 0 || state.mistakes > 0)) rec.wrong += 1;

    var d = dayEntry();
    d.words += 1;
    if (!reviewOnly) {
      d.chars += Array.from(w.a).length;
      d.seconds += Math.max(1, (Date.now() - state.wordStart) / 1000);
    }
    if (reviewOnly ? grade === 3 : (ok && state.errors === 0 && state.mistakes === 0)) d.clean += 1;
    if (wasNew) d.newWords += 1;

    save();
    renderProgress();

    // 评价完立刻把这个词推进未来的队列，本轮不会再出现
    var gap = ivText(rec.iv);
    var inp = el('typeInput');
    if (reviewOnly) {
      setFeedback((grade === 1 ? '已记录：忘了' : grade === 2 ? '已记录：模糊' : '已记录：很熟') + ' · ' + gap + '后复习', 'ok');
      beep(520, 0.045, 'sine', 0.025);
      if (!holdForMeaning) setTimeout(next, 260);
    } else if (ok) {
      inp.classList.remove('is-bad');
      inp.classList.add('is-ok');
      setFeedback('对了 · ' + gap + '后复习', 'ok');
      beep(660, 0.07, 'sine', 0.04);
      setTimeout(function () { beep(990, 0.09, 'sine', 0.032); }, 75);
      setTimeout(next, 430);
    } else {
      setFeedback('已给出答案 · 记为「忘了」· ' + gap + '后复习', 'bad');
      setTimeout(next, 1150);
    }
  }

  // 间隔转成「15 分钟」「2.2 天」这种短文案
  function ivText(ms) {
    if (ms < 60 * MIN) return Math.round(ms / MIN) + ' 分钟';
    if (ms < DAY) return Math.round(ms / (60 * MIN)) + ' 小时';
    var d = ms / DAY;
    return (d < 10 ? Math.round(d * 10) / 10 : Math.round(d)) + ' 天';
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

  // 全书的词都学过、且当下没有到期复习时才会走到这里
  function endAll() {
    stopTimer();
    var d = dayEntry();
    var cpm = d.seconds ? Math.round(d.chars / (d.seconds / 60)) : 0;
    var acc = d.words ? Math.round((d.clean / d.words) * 100) : 0;

    // 下一次有词要复习是什么时候，给个明确的期待
    var nextAt = 0;
    Object.keys(db.records).forEach(function (k) {
      var r = db.records[k];
      if (r.seen > 0 && r.dueAt > 0 && (!nextAt || r.dueAt < nextAt)) nextAt = r.dueAt;
    });
    var tip = nextAt
      ? '下一个词在 ' + ivText(Math.max(0, nextAt - Date.now())) + '后等你复习'
      : '这本书的词都过完了，暂时没有要复习的词';

    el('doneTitle').textContent = '这一轮结束了 · ' + tip;
    el('doneWords').textContent = d.words;
    el('doneAcc').innerHTML = acc + '<small>%</small>';
    el('doneCpm').innerHTML = cpm + '<small>字/分</small>';
    el('doneTime').innerHTML = Math.max(1, Math.round(d.seconds / 60)) + '<small>分</small>';

    state.current = null;
    state.phase = 'idle';
    setView('done');
  }

  function forceBatch(n) {
    var batch = reviewBatch(n);
    if (!batch.length) return;
    state.step = 0;
    state.forced = batch;
    startTimer();
    loadNext();
  }

  // ================= 统计 =================
  function renderStats() {
    var keys = Object.keys(db.days).sort();
    var tw = 0, tc = 0, tch = 0, ts = 0;
    keys.forEach(function (k) {
      var d = db.days[k];
      tw += d.words; tc += d.clean; tch += d.chars; ts += d.seconds;
    });

    var mastered = 0;
    Object.keys(db.records).forEach(function (k) {
      if (db.records[k].seen > 0) mastered++;
    });

    el('statWords').textContent = tw;
    el('statAcc').innerHTML = (tw ? Math.round((tc / tw) * 100) : 0) + '<small>%</small>';
    el('statCpm').innerHTML = (ts ? Math.round(tch / (ts / 60)) : 0) + '<small>字/分</small>';
    el('statMastered').textContent = mastered;

    var recent = keys.slice(-14);

    var accPts = recent.map(function (k) {
      var d = db.days[k];
      return { k: k, v: d.words ? (d.clean / d.words) * 100 : 0 };
    });
    var cpmPts = recent.map(function (k) {
      var d = db.days[k];
      return { k: k, v: d.seconds ? d.chars / (d.seconds / 60) : 0 };
    });

    el('accLatest').textContent = accPts.length ? Math.round(accPts[accPts.length - 1].v) + '%' : '';
    el('cpmLatest').textContent = cpmPts.length ? Math.round(cpmPts[cpmPts.length - 1].v) + ' 字/分' : '';

    renderChart(document.querySelector('.chart[data-series="acc"]'), accPts, 100, 'var(--ok)', '');
    renderChart(document.querySelector('.chart[data-series="cpm"]'), cpmPts, 0, 'var(--muted)', '');
  }

  var chartSeq = 0;

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

    var maxV = fixedMax || Math.max.apply(null, pts.map(function (p) { return p.v; }).concat([1])) * 1.18;
    var X = function (i) { return pts.length === 1 ? PL + iw / 2 : PL + (iw * i) / (pts.length - 1); };
    var Y = function (v) { return PT + ih - (Math.min(v, maxV) / maxV) * ih; };

    var line = '';
    pts.forEach(function (p, i) {
      line += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1) + ' ';
    });

    var area = line + 'L' + X(pts.length - 1).toFixed(1) + ' ' + (PT + ih) +
      ' L' + X(0).toFixed(1) + ' ' + (PT + ih) + ' Z';

    var dots = pts.map(function (p, i) {
      return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) +
        '" r="2.7" fill="var(--surface)" stroke="' + color + '" stroke-width="1.6" />';
    }).join('');

    var grid = '';
    [0, 0.5, 1].forEach(function (t) {
      var y = PT + ih - t * ih;
      grid += '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
        '" stroke="var(--line)" stroke-width="1" />';
      grid += '<text x="' + (PL - 8) + '" y="' + (y + 4) + '" text-anchor="end" ' +
        'font-size="10" font-family="ui-monospace, Menlo, Consolas, monospace" fill="var(--faint)">' +
        Math.round(maxV * t) + '</text>';
    });

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
      '</svg>';
  }

  // 窗口尺寸变化后图表要按新的剩余高度重新出图，否则 SVG 会被拉伸
  var chartResizeTimer = null;
  window.addEventListener('resize', function () {
    var vs = document.getElementById('view-stats');
    if (!vs || !vs.classList.contains('is-active')) return;
    if (chartResizeTimer) clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(function () {
      if (vs.classList.contains('is-active')) renderStats();
    }, 160);
  });

  // ================= 词库 =================
  var WORD_CHUNK = 200;
  var wordFilter = '';
  var wordShown = 0;
  var wordMatched = 0;

  function wordRow(w) {
    var r = db.records[w.w];
    var badge = '<span class="badge">未学</span>';
    if (r && r.seen > 0) {
      var left = (r.dueAt || 0) - Date.now();
      if (left <= 0) {
        badge = '<span class="badge bad">该复习了</span>';
      } else if (r.last === 1) {
        badge = '<span class="badge bad">' + humanGap(left) + '后再来</span>';
      } else {
        badge = '<span class="badge ok">' + humanGap(left) + '后复习</span>';
      }
    }
    return '<tr>' +
      '<td class="w">' +
      '<button class="row-fav' + (isFav(w.w) ? ' is-on' : '') + '" type="button"' +
      ' data-w="' + esc(w.w) + '" aria-pressed="' + (isFav(w.w) ? 'true' : 'false') + '"' +
      ' title="' + (isFav(w.w) ? '取消收藏' : '收藏') + '">' + FAV_SVG + '</button>' +
      esc(w.w) + '</td>' +
      '<td class="p">' + esc(w.ph || '—') + '</td>' +
      '<td class="a">' + esc(w.a) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td class="d"><button class="row-detail" type="button"' +
      ' data-w="' + esc(w.w) + '" data-ph="' + esc(w.ph || '') + '" data-def="' + esc(w.def || w.a) + '"' +
      ' title="词根、词组、固定搭配、例句">详细</button></td>' +
      '</tr>';
  }

  function renderWords(reset) {
    var words = allWords();
    var q = wordFilter.trim().toLowerCase();

    if (q) {
      words = words.filter(function (w) {
        return w.w.toLowerCase().indexOf(q) >= 0 ||
          String(w.def || '').toLowerCase().indexOf(q) >= 0 ||
          String(w.a || '').indexOf(wordFilter.trim()) >= 0;
      });
    }
    wordMatched = words.length;

    if (reset) {
      el('wordTableBody').innerHTML = '';
      wordShown = 0;
    }

    var slice = words.slice(wordShown, wordShown + WORD_CHUNK);
    if (slice.length) {
      el('wordTableBody').insertAdjacentHTML('beforeend', slice.map(wordRow).join(''));
      wordShown += slice.length;
    }

    var total = allWords().length;
    el('wordCount').textContent = q
      ? '匹配 ' + wordMatched + ' 词 / 共 ' + total
      : '显示 ' + wordShown + ' / ' + total;

    var more = el('btnMoreWords');
    if (more) more.hidden = wordShown >= wordMatched;
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

      var a = extractAnswer(def);
      if (!a) return;
      out.push({ w: w, ph: ph, def: def, a: a });
    });

    return out;
  }

  function doImport() {
    var text = el('importText').value;
    var parsed = parseImport(text);

    if (!parsed.length) {
      el('importHint').textContent = '没认出有效的词，检查一下分隔符';
      return;
    }

    var existing = {};
    allWords().forEach(function (w) { existing[w.w.toLowerCase()] = true; });

    var added = 0;
    parsed.forEach(function (w) {
      if (existing[w.w.toLowerCase()]) return;
      existing[w.w.toLowerCase()] = true;
      db.custom.push(w);
      added++;
    });

    save();
    wordCache = null;
    wordIndex = null;
    el('importHint').textContent = '导入 ' + added + ' 个新词（跳过重复 ' + (parsed.length - added) + ' 个）';
    el('importText').value = '';
    renderWords(true);
  }

  // ================= 详细资料 =================
  // 词根 / 词组 / 固定搭配 / 例句，离线打包在 assets/detail/ 下：
  //   manifest.json 存每个分片的首词（按字母序连成一片），
  //   客户端二分定位到分片，只取那一个 200KB 左右的文件，取到即缓存在内存里。
  // 启动时不加载，点「详细」才发请求；切词时后台预取当前词所在的分片。
  var DETAIL_BASE = 'assets/detail/';
  var detailManifest = null;      // ["abandon", "absorb", ...]
  var detailVer = '';             // 分片内容的版本号，拼到分片 URL 上防缓存错位
  var detailManifestReq = null;
  var detailChunks = {};          // 分片序号 → { 单词: 记录 }
  var detailChunkReq = {};        // 分片序号 → 进行中的请求
  var detailShown = false;

  function detailGet(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function detailManifestLoad() {
    if (detailManifest) return Promise.resolve(detailManifest);
    if (!detailManifestReq) {
      detailManifestReq = detailGet(DETAIL_BASE + 'manifest.json').then(function (m) {
        if (Array.isArray(m)) {
          detailManifest = m;
        } else if (m && Array.isArray(m.c)) {
          detailManifest = m.c;
          detailVer = m.v || '';
        } else {
          detailManifest = [];
        }
        return detailManifest;
      }, function () {
        detailManifest = [];
        return detailManifest;
      });
    }
    return detailManifestReq;
  }

  // 二分：找「首词 <= 目标词」里序号最大的那个分片，就是目标词所在的分片
  function detailChunkIndex(key) {
    var man = detailManifest, lo = 0, hi = man.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (man[mid] <= key) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function detailLoadChunk(i) {
    if (detailChunks[i]) return Promise.resolve(detailChunks[i]);
    if (!detailChunkReq[i]) {
      detailChunkReq[i] = detailGet(DETAIL_BASE + i + '.json' + (detailVer ? '?v=' + detailVer : '')).then(function (data) {
        detailChunks[i] = data || {};
        return detailChunks[i];
      }, function () {
        detailChunks[i] = {};
        return detailChunks[i];
      });
    }
    return detailChunkReq[i];
  }

  // 返回 Promise<记录 | null>
  function detailOf(word) {
    var key = String(word || '').trim().toLowerCase();
    return detailManifestLoad().then(function (man) {
      if (!man.length) return null;
      return detailLoadChunk(detailChunkIndex(key)).then(function (c) {
        return c[key] || null;
      });
    });
  }

  // 切词后有空就把当前词所在的分片先取下来，点「详细」时基本是瞬开
  function prefetchDetail(word) {
    if (!word) return;
    setTimeout(function () {
      detailOf(word).catch(function () { });
    }, 1200);
  }

  function detailSection(title, inner) {
    return '<div class="detail-sec">' +
      '<div class="detail-sec-title">' + title + '</div>' + inner + '</div>';
  }

  function renderDetail(intro, rec) {
    var host = el('detailBody');
    var html = '';

    // 释义：不管有没有扩展资料，先把中文摆出来
    if (intro.def) {
      html += detailSection('释义', '<p class="detail-def">' + esc(intro.def) + '</p>');
    }

    if (!rec) {
      html += '<p class="detail-tip">这个词暂时没有词根 / 搭配资料，先记住释义就够了。</p>';
      host.innerHTML = html;
      host.scrollTop = 0;
      updateDetailScroll();
      return;
    }

    if (rec.e && rec.e.length) {
      html += detailSection('词根 · 词源',
        rec.e.map(function (t) { return '<p class="detail-para">' + esc(t) + '</p>'; }).join(''));
    }

    if (rec.p && rec.p.length) {
      html += detailSection('词组 · 固定搭配',
        '<ul class="detail-list">' + rec.p.map(function (p) {
          return '<li><b>' + esc(p[0]) + '</b>' +
            (p[1] ? '<span>' + esc(p[1]) + '</span>' : '') + '</li>';
        }).join('') + '</ul>');
    }

    if (rec.s && rec.s.length) {
      html += detailSection('例句',
        '<ul class="detail-list detail-sent">' + rec.s.map(function (s) {
          return '<li><i>' + esc(s[0]) + '</i>' +
            (s[1] ? '<span>' + esc(s[1]) + '</span>' : '') + '</li>';
        }).join('') + '</ul>');
    }

    if (rec.r && rec.r.ws && rec.r.ws.length) {
      html += detailSection('同根词' + (rec.r.root ? ' · ' + esc(rec.r.root) : ''),
        '<div class="detail-chips">' + rec.r.ws.map(function (w) {
          return '<div class="detail-chip"><b>' + esc(w[0]) + '</b>' +
            (w[1] ? '<span>' + esc(w[1]) + '</span>' : '') + '</div>';
        }).join('') + '</div>');
    }

    host.innerHTML = html;
    host.scrollTop = 0;
    updateDetailScroll();
  }

  // 内容超过可视高度时给底部加个淡出，提示还能往下滚
  function updateDetailScroll() {
    var body = el('detailBody');
    if (!body) return;
    var more = body.scrollHeight - body.scrollTop - body.clientHeight > 6;
    body.classList.toggle('is-scroll', more);
  }

  function openDetail(word, phonetic, def) {
    if (!word) return;
    detailShown = true;
    el('detailWord').textContent = word;
    el('detailPh').textContent = phonetic || '';
    el('detailBody').innerHTML = '<p class="detail-tip">正在取资料…</p>';
    el('detailMask').classList.add('show');
    el('detailSheet').classList.add('show');
    el('detailSheet').setAttribute('aria-hidden', 'false');

    var inp = el('typeInput');
    if (inp) inp.blur();

    var intro = { w: word, ph: phonetic, def: def };
    detailOf(word).then(function (rec) {
      if (!detailShown) return;         // 取的过程中已经关掉了
      if (el('detailWord').textContent !== word) return;  // 已经换成别的词了
      renderDetail(intro, rec);
    }, function () {
      renderDetail(intro, null);
    });
  }

  function closeDetail() {
    if (!detailShown) return;
    detailShown = false;
    el('detailMask').classList.remove('show');
    el('detailSheet').classList.remove('show');
    el('detailSheet').setAttribute('aria-hidden', 'true');
    // 从打字阶段打开的，关掉就把焦点还给输入框，接着敲
    if (state.view === 'drill' && state.phase === 'typing') {
      var inp = el('typeInput');
      try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    }
  }

  function openCurrentDetail() {
    var w = state.current;
    if (!w) return;
    openDetail(w.w, w.ph ? '/' + String(w.ph).replace(/^\/|\/$/g, '') + '/' : '', w.def);
  }

  // ================= 收藏 =================
  // 数据只存 { 单词: 收藏时间戳 }，释义、音标一律回词库现取，不复制词条。
  // 时间戳有双重作用：既判断收藏与否，也用来做「最新收藏排最前」的排序。
  var FAV_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.7l2.55 5.2 5.72.83-4.14 4.03.98 5.7L12 16.75l-5.11 2.69.98-5.7-4.14-4.03 5.72-.83z"/></svg>';

  function isFav(word) {
    return !!(word && db.favs && db.favs[word]);
  }

  // 有效收藏数：词表换过之后，收藏里可能有词库里已经找不到的旧词，
  // 那些照样留在数据里（不删除用户数据），但不计入显示数量。
  function favItems() {
    var idx = wordByKey();
    return Object.keys(db.favs)
      .sort(function (a, b) { return db.favs[b] - db.favs[a]; })
      .map(function (k) { return idx[k]; })
      .filter(Boolean);
  }

  function toggleFav(word) {
    if (!word) return false;
    if (!db.favs) db.favs = {};
    var on;
    if (db.favs[word]) { delete db.favs[word]; on = false; }
    else { db.favs[word] = Date.now(); on = true; }
    save();
    syncFavUI();
    // 收藏页正在看的时候：新收藏整体重排（要排到最前），取消收藏只摘掉那一行，
    // 免得整张列表重画、滚动位置跳回顶部
    if (state.view === 'favs') {
      if (on) renderFavs();
      else dropFavRow(word);
    }
    return on;
  }

  function dropFavRow(word) {
    var rows = document.querySelectorAll('#favList .fav-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.w === word) { rows[i].parentNode.removeChild(rows[i]); break; }
    }
    var n = favItems().length;
    if (!n) { renderFavs(); return; }
    var sub = el('favSub');
    if (sub) sub.innerHTML = '共 <b>' + n + '</b> 个词，最新收藏的排在最前面，点词看词根和例句。';
  }

  function favTime(ts) {
    var d = Date.now() - (ts || 0);
    if (!ts) return '';
    if (d < 50000) return '刚刚';
    return humanGap(d) + '前';
  }

  function favRow(w) {
    var ph = w.ph ? '/' + String(w.ph).replace(/^\/|\/$/g, '') + '/' : '';
    var ts = db.favs[w.w] || 0;
    return '<div class="fav-row" data-w="' + esc(w.w) + '" data-ph="' + esc(ph) + '"' +
      ' data-def="' + esc(w.def || w.a) + '" role="button" tabindex="0">' +
      '<button class="fav-btn is-on" type="button" data-fav="' + esc(w.w) + '"' +
      ' title="取消收藏" aria-label="取消收藏 ' + esc(w.w) + '">' + FAV_SVG + '</button>' +
      '<div class="fav-body">' +
      '<div class="fav-line"><span class="fav-word">' + esc(w.w) + '</span>' +
      '<span class="fav-ph">' + esc(ph) + '</span></div>' +
      '<div class="fav-def">' + esc(w.a || w.def) + '</div>' +
      '</div>' +
      '<span class="fav-time">' + esc(favTime(ts)) + '</span>' +
      '</div>';
  }

  function renderFavs() {
    var items = favItems();
    var host = el('favList');
    var empty = el('favEmpty');
    var sub = el('favSub');
    if (!host) return;

    if (!items.length) {
      host.innerHTML = '';
      host.hidden = true;
      if (empty) empty.hidden = false;
      if (sub) sub.textContent = '还没收藏任何单词。';
      return;
    }

    host.innerHTML = items.map(favRow).join('');
    host.hidden = false;
    if (empty) empty.hidden = true;
    if (sub) {
      sub.innerHTML = '共 <b>' + items.length + '</b> 个词，最新收藏的排在最前面，点词看词根和例句。';
    }
  }

  // 练习页星标、顶栏数字、词库行内星标、收藏页列表，统一在这里对齐
  function syncFavUI() {
    var btn = el('btnFav');
    if (btn) {
      var on = state.current ? isFav(state.current.w) : false;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? '取消收藏' : '收藏这个词';
      btn.setAttribute('aria-label', on ? '取消收藏' : '收藏这个词');
    }

    var n = favItems().length;
    var badge = el('navFavCount');
    if (badge) {
      badge.textContent = n;
      badge.hidden = !n;
    }

    document.querySelectorAll('.row-fav').forEach(function (b) {
      var on2 = isFav(b.dataset.w);
      b.classList.toggle('is-on', on2);
      b.title = on2 ? '取消收藏' : '收藏';
      b.setAttribute('aria-pressed', on2 ? 'true' : 'false');
    });
  }

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

  // ================= 多词书管理（本地优先） =================
  function renderBookshelf() {
    var grid = el('bookshelfGrid'); if (!grid) return; grid.innerHTML = '';
    books.forEach(function (book) {
      var current = book.id === activeBookId, card = document.createElement('article');
      card.className = 'book-card' + (current ? ' is-current' : '');
      var cover = document.createElement('div'); cover.className = 'book-cover'; cover.textContent = (book.name || '词').slice(0, 1);
      var info = document.createElement('div'), title = document.createElement('strong'), desc = document.createElement('p'), tag = document.createElement('span');
      title.textContent = book.name; desc.textContent = (book.kind === 'builtin' ? '内置词库' : '自定义词书') + ' · ' + (book.wordCount || 0) + ' 词';
      tag.className = 'book-tag'; tag.textContent = current ? '当前学习词书' : '独立学习档案';
      info.appendChild(title); info.appendChild(desc); info.appendChild(tag);
      if (!current) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'ghost-btn book-switch'; b.textContent = '切换到这本';
        b.addEventListener('click', function () { localStorage.setItem(ACTIVE_BOOK_KEY, book.id); location.reload(); }); info.appendChild(b);
      }
      card.appendChild(cover); card.appendChild(info); grid.appendChild(card);
    });
  }
  function createBookFromFile() {
    var name = (el('newBookName').value || '').trim(), file = el('newBookFile').files && el('newBookFile').files[0], hint = el('bookImportHint');
    if (!name) { hint.textContent = '请先填写词书名称。'; return; }
    if (!file) { hint.textContent = '请选择 CSV 或 TXT 文件。'; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = parseImport(String(reader.result || ''));
      if (!parsed.length) { hint.textContent = '没有识别到有效单词。每行格式：单词 | 音标 | 中文释义。'; return; }
      var seen = {}, words = [];
      parsed.forEach(function (w) { var k = String(w.w || '').toLowerCase(); if (k && !seen[k]) { seen[k] = 1; words.push(w); } });
      if (!words.length) { hint.textContent = '文件中没有有效单词。'; return; }
      var id = 'book-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      books.push({ id: id, name: name, kind: 'custom', createdAt: Date.now(), wordCount: words.length });
      localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
      localStorage.setItem(STORE_KEY + ':book:' + id, JSON.stringify({ settings: Object.assign({}, DEFAULTS), records: {}, days: {}, custom: words, favs: {} }));
      localStorage.setItem(ACTIVE_BOOK_KEY, id); hint.textContent = '已导入 ' + words.length + ' 个单词，正在切换……';
      setTimeout(function () { location.reload(); }, 250);
    };
    reader.onerror = function () { hint.textContent = '文件读取失败。'; };
    reader.readAsText(file, 'UTF-8');
  }

  function bind() {
    if (el('btnCreateBook')) el('btnCreateBook').addEventListener('click', createBookFromFile);
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'drill') {
          // 已经有正在学的词就原样回来，不要跳到下一个（不然敲一半的内容会丢）
          if (!state.current) {
            if (!timerId) startTimer();
            loadNext();
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

    el('btnAgain').addEventListener('click', function () { forceBatch(15); });
    el('btnHome').addEventListener('click', function () { setView('stats'); });

    el('btnSpeak').addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.current) speak(state.current.w, true);
    });

    // 「详细」：词根 / 词组 / 固定搭配 / 例句
    el('btnDetail').addEventListener('click', function (e) {
      e.stopPropagation();
      openCurrentDetail();
    });

    // 自评揭晓释义后，由用户主动进入下一个单词。
    el('btnMeaningNext').addEventListener('click', function (e) {
      e.stopPropagation();
      nextFromReveal();
    });

    // 收藏当前词：再点一次取消
    el('btnFav').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!state.current) return;
      var on = toggleFav(state.current.w);
      if (on) beep(660, 0.05);
    });

    // 收藏页：星标取消收藏，点整行看详细
    el('favList').addEventListener('click', function (e) {
      var star = e.target && e.target.closest ? e.target.closest('.fav-btn') : null;
      if (star) {
        e.stopPropagation();
        toggleFav(star.dataset.fav);
        return;
      }
      var row = e.target && e.target.closest ? e.target.closest('.fav-row') : null;
      if (row) openDetail(row.dataset.w, row.dataset.ph, row.dataset.def);
    });

    el('favList').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target && e.target.closest ? e.target.closest('.fav-row') : null;
      if (!row || e.target.closest('.fav-btn')) return;
      e.preventDefault();
      openDetail(row.dataset.w, row.dataset.ph, row.dataset.def);
    });

    el('btnFavGo').addEventListener('click', function () {
      if (!state.current) { if (!timerId) startTimer(); loadNext(); }
      else setView('drill');
    });
    el('detailClose').addEventListener('click', closeDetail);
    el('detailMask').addEventListener('click', closeDetail);
    el('detailBody').addEventListener('scroll', updateDetailScroll);

    // 词库表格里的「详细」「星标」用事件委托，避免给几千行各挂一个监听
    el('wordTableBody').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var star = t.closest('.row-fav');
      if (star) {
        e.stopPropagation();
        toggleFav(star.dataset.w);
        return;
      }
      var b = t.closest('.row-detail');
      if (!b) return;
      e.stopPropagation();
      openDetail(b.dataset.w, b.dataset.ph, b.dataset.def);
    });

    document.querySelectorAll('.rate').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        rate(parseInt(b.dataset.grade, 10));
      });
    });

    var inp = el('typeInput');

    inp.addEventListener('compositionstart', function () {
      state.composing = true;
      state.comp = '';
    });

    // 组词过程中实时读拼音，逐字母点亮
    inp.addEventListener('compositionupdate', function (e) {
      state.composing = true;
      state.comp = e.data || '';
      renderAnswer();
    });

    inp.addEventListener('compositionend', function () {
      state.composing = false;
      state.comp = '';
      acceptEdit();
    });

    inp.addEventListener('input', function () {
      if (state.composing) return;
      acceptEdit();
    });

    // 锁定时拦掉一切插入（含粘贴、拖入）
    inp.addEventListener('beforeinput', function (e) {
      if (!state.locked) return;
      var t = e.inputType || '';
      if (t.indexOf('insert') === 0) {
        e.preventDefault();
        beep(120, 0.03, 'square', 0.028);
      }
    });

    inp.addEventListener('keydown', function (e) {
      // 长按不连发「咔」声，也避免误提交
      if (e.repeat) return;

      if (e.key === 'Enter') {
        if (e.isComposing || state.composing) { keyClick('enter'); return; }
        keyClick('enter');
        e.preventDefault();
        submit();
        return;
      }

      // 打错后锁死：只放行删除与方向键，其余按键无效
      if (state.locked && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        beep(120, 0.03, 'square', 0.028);
        return;
      }

      if (isClickKey(e)) keyClick(e.key === ' ' ? 'space' : 'down');
    });

    inp.addEventListener('keyup', function (e) {
      if (e.key === 'Enter') return;
      if (isClickKey(e)) keyClick('up');
    });

    document.addEventListener('keydown', function (e) {
      // 详细面板打开时，键盘交给面板：只认 Esc，别把 J/K/L 当成自评
      if (detailShown) {
        if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
        return;
      }
      if (state.view !== 'drill') return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        if (tag === 'INPUT' && e.key !== 'Enter') return;
      }

      // 看词阶段先自评：J/K/L 定了级，才揭晓中文
      if (state.phase === 'recall') {
        if (e.key === 'j' || e.key === 'J' || e.key === '1') { e.preventDefault(); rate(1); return; }
        if (e.key === 'k' || e.key === 'K' || e.key === '2') { e.preventDefault(); rate(2); return; }
        if (e.key === 'l' || e.key === 'L' || e.key === '3') { e.preventDefault(); rate(3); return; }
        if (e.key === 'r' || e.key === 'R') { if (state.current) speak(state.current.w, true); return; }
      }

      // 释义已经揭晓：空格 / 回车进入下一个词（按钮有焦点时也走这里，避免触发两次）
      if (state.phase === 'judged') {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); nextFromReveal(); return; }
        if (e.key === 'r' || e.key === 'R') { if (state.current) speak(state.current.w, true); return; }
      }
    });

    document.addEventListener('keydown', function (e) { visualKey(e, true); });
    document.addEventListener('keyup', function (e) { visualKey(e, false); });
    window.addEventListener('blur', clearKeyboard);

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
    var writingStartedAt = 0;
    var writingSource = '';
    var writingInput = el('writingInput');
    function renderTypingPrompt(typed) {
      var host = el('typingPrompt'); if (!host) return;
      host.innerHTML = '';
      for (var i = 0; i < writingSource.length; i++) {
        var span = document.createElement('span'); span.className = 'typing-char';
        if (i < typed.length) span.classList.add(typed[i] === writingSource[i] ? 'is-correct' : 'is-wrong');
        else if (i === typed.length) span.classList.add('is-current');
        span.textContent = writingSource[i]; host.appendChild(span);
      }
      if (typed.length > writingSource.length) {
        for (var j = writingSource.length; j < typed.length; j++) {
          var extra = document.createElement('span'); extra.className = 'typing-char is-wrong'; extra.textContent = typed[j]; host.appendChild(extra);
        }
      }
    }
    el('btnStartWriting').addEventListener('click', function () {
      writingSource = el('articleSource').value.trim();
      if (!writingSource) { el('articleStatus').textContent = '请先生成或填写文章'; return; }
      writingInput.disabled = false; writingInput.value = ''; writingStartedAt = Date.now();
      renderTypingPrompt('');
      el('typingState').textContent = '开始输入';
      el('articleStatus').textContent = '练习中';
      el('writingErrors').textContent = '0'; el('writingWpm').textContent = '0'; el('writingAccuracy').textContent = '—';
      setView('typing'); writingInput.focus();
    });
    writingInput.addEventListener('input', function () {
      var typed = writingInput.value;
      renderTypingPrompt(typed);
      var mins = Math.max((Date.now() - writingStartedAt) / 60000, 1 / 60000);
      var correct = 0, errors = 0;
      for (var i = 0; i < typed.length; i++) { if (typed[i] === writingSource[i]) correct++; else errors++; }
      el('writingErrors').textContent = String(errors + Math.max(0, writingSource.length - typed.length) * 0);
      el('writingWpm').textContent = String(Math.round((correct / 5) / mins));
      el('writingAccuracy').textContent = typed.length ? Math.round(correct / typed.length * 100) + '%' : '—';
      el('kbState').textContent = typed.length >= writingSource.length ? '输入完成' : '已输入 ' + typed.length + ' / ' + writingSource.length;
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
      for (var i = 0; i < max; i++) { if (typed[i] !== writingSource[i]) errors++; else if (i < typed.length) correct++; }
      el('writingErrors').textContent = String(errors);
      el('writingAccuracy').textContent = (max ? Math.round(correct / max * 100) : 0) + '%';
      el('typingState').textContent = errors ? '已提交 · 有差异' : '已完成 · 完全一致';
      el('articleStatus').textContent = '本次练习已提交';
      writingInput.disabled = true;
      renderTypingPrompt(typed);
    });

    el('btnImport').addEventListener('click', doImport);

    // 导入区默认高度随视口：高屏展开，矮屏收起，把行数留给词表
    var importBox = el('importBox');
    var importToggle = el('importToggle');
    if (importBox && importToggle) {
      var caret = importToggle.querySelector('.import-caret');
      var setImportOpen = function (open) {
        importBox.classList.toggle('is-open', open);
        if (caret) caret.textContent = open ? '收起' : '展开';
      };
      setImportOpen(window.innerHeight > 680);
      importToggle.addEventListener('click', function () {
        setImportOpen(!importBox.classList.contains('is-open'));
      });
    }

    var searchTimer = null;
    el('wordSearch').addEventListener('input', function (e) {
      wordFilter = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { renderWords(true); }, 120);
    });

    el('btnMoreWords').addEventListener('click', function () { renderWords(false); });

    // 表格卡片内部滚动到底部时自动续上下一批，省掉一次点击
    var tableCard = document.querySelector('#view-words .table-card');
    if (tableCard) {
      tableCard.addEventListener('scroll', function () {
        if (tableCard.scrollTop + tableCard.clientHeight < tableCard.scrollHeight - 140) return;
        var more = el('btnMoreWords');
        if (more && !more.hidden) renderWords(false);
      });
    }

    el('btnImportDemo').addEventListener('click', function () {
      el('importText').value =
        'apple | /ˈæpəl/ | n. 苹果；苹果树\n' +
        'abandon | /əˈbændən/ | v. 放弃；抛弃\n' +
        'fragile | /ˈfrædʒəl/ | adj. 脆弱的；易碎的';
    });

    el('btnReset').addEventListener('click', function () {
      if (!confirm('会清空所有学习记录、收藏和导入的词，确定吗？')) return;
      localStorage.removeItem(storeKey());
      db = load();
      wordCache = null;
      wordIndex = null;
      state.forced = [];
      state.step = 0;
      applySettings();
      closeDrawer();
      startTimer();
      loadNext();
    });
  }

  // 回归脚本用：把间隔计算与队列查询暴露出来，便于逐条核对验收场景
  window.__review = {
    nextInterval: nextInterval,
    applyGrade: applyGrade,
    duePool: duePool,
    pickNext: pickNext,
    ivText: ivText,
    dueCount: dueCount,
    overdueCount: overdueCount,
    nextDueIn: nextDueIn,
    max: IV_MAX,
    DAY: DAY,
    MIN: MIN,
    // 收藏相关的只读接口，给回归脚本核对持久化与排序
    isFav: isFav,
    toggleFav: toggleFav,
    favItems: favItems
  };

  // ================= 启动 =================
  // 没有欢迎页也没有每日任务：打开就是接着上次的那个词
  // 先把 load() 做过的迁移（补 forget_count、超长间隔压回 15 天）落盘一次，
  // 免得每次刷新都重算，也保证数据和内存里的状态一致
  save();
  buildKeyboard();
  mountHands();
  applySettings();
  bind();
  startTimer();
  loadNext();
  // 万一没有可学的词（整本书都进了复习间隔），也要把收藏数字摆对
  syncFavUI();

})();
