/* ============================================================
   Review Words · 虚拟键盘与手部指法
   从 app.js 里拆出来的第一块：虚拟键盘的 DOM、按键高亮、手指提示、
   以及 hands.js（58 层 SVG 手部）的懒加载与图层切换。

   只依赖外面两样东西，由 app.js 传进来：
     ctx.el(id)   取元素
     ctx.state    页面状态（要读 view / phase 判断该提示哪个键）

   浏览器里挂到 window.RWKeyboard.create(ctx)，返回这几个方法：
     buildKeyboard()  showKeyboard(on)  clearKeyboard()  clearHint()
     updateHint()     visualKey(e, d)   mountHands()     ensureHands(cb)
   ============================================================ */
window.RWKeyboard = {
  create: function (ctx) {
    'use strict';

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
    var board = ctx.el('kbBoard');
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
    var host = ctx.el('handsSvg');
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

  // 键盘常驻，时刻告诉用户“现在该做什么”。
  // codes: 要高亮的键（可能多个）；text: 状态栏文案；hand: 手部要伸到哪个键
  function hintState() {
    var out = { codes: [], text: '', hand: '' };
    if (ctx.state.view !== 'drill') return out;

    // 看词自评：J / K / L 三选一，三个键一起亮；评完分就没有键位提示了
    if (ctx.state.phase === 'recall') {
      out.codes = ['KeyJ', 'KeyK', 'KeyL'];
      out.text = '选择记忆程度 · J 忘了 / K 模糊 / L 熟悉';
    }
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
      var live = ctx.el('kbState');
      if (live) live.textContent = h.text || '';
    }
  }

  // hands.js 有 271KB（58 层 SVG 手部），只为打字页服务，所以进打字页才加载。
  // 页面加载时那句 <script> 已经摘掉了，这里用和词库（dict.js）一样的动态插入。
  var handsWaiters = null;
  function ensureHands(done) {
    if (window.HANDS_SVG) { done(); return; }
    if (handsWaiters) { handsWaiters.push(done); return; }
    handsWaiters = [done];
    var s = document.createElement('script');
    s.src = './assets/hands.js';
    s.onload = function () {
      var list = handsWaiters || [];
      handsWaiters = null;
      list.forEach(function (fn) { try { fn(); } catch (e) {} });
    };
    s.onerror = function () { handsWaiters = null; };
    document.body.appendChild(s);
  }

  function mountHands() {
    var host = ctx.el('handsSvg');
    if (!host) return;
    if (window.HANDS_SVG) {
      if (!host.firstChild) host.innerHTML = window.HANDS_SVG;
      syncHands();
      return;
    }
    ensureHands(function () {
      if (!host.firstChild) host.innerHTML = window.HANDS_SVG;
      syncHands();
    });
  }

  function clearKeyboard() {
    document.querySelectorAll('.kb-key.is-down').forEach(function (n) { n.classList.remove('is-down'); });
    heldStack = [];
    clearHint();
    syncHands();
    var live = ctx.el('kbState');
    if (live) live.textContent = '等待输入';
  }

  function showKeyboard(on) {
    var dock = ctx.el('keyboardDock');
    if (!dock) return;
    dock.classList.toggle('on', !!on);
    dock.setAttribute('aria-hidden', on ? 'false' : 'true');
    var drill = document.querySelector('.drill');
    if (drill) drill.classList.toggle('kb-open', !!on);
    if (on) syncHands(); else clearKeyboard();
  }

  function visualKey(e, down) {
    if (ctx.state.view !== 'typing' && ctx.state.view !== 'drill') return;
    if (ctx.state.view === 'drill' && ctx.state.phase !== 'recall') return;
    // 作文训练只响应真实键盘事件，不允许点击屏幕键盘代替输入。
    if (down && ctx.state.view === 'typing' && document.activeElement !== ctx.el('writingInput')) return;
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
      ctx.el('kbState').textContent = (key.dataset.label || '') + (name ? ' · ' + name : '');
    } else if (!document.querySelector('.kb-key.is-down')) {
      ctx.el('kbState').textContent = hintState().text || '';
    }
  }

    return {
      eventCode: eventCode,
      buildKeyboard: buildKeyboard,
      showKeyboard: showKeyboard,
      clearKeyboard: clearKeyboard,
      clearHint: clearHint,
      updateHint: updateHint,
      hintState: hintState,
      visualKey: visualKey,
      mountHands: mountHands,
      ensureHands: ensureHands,
      syncHands: syncHands
    };
  }
};
