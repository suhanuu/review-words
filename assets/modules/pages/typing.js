/* ============================================================
   Review Words · 全屏打字练习
   从 app.js 的 bind() 里拆出来的一大段：作文原文逐字对照、实时速度/准确率、
   点击补空格、方向键拦截、点击提交后的结果。

   两种情况：英文按词（5 字符）算 WPM，中文按字算；中文输入法上屏前不判错。
   虚拟键盘和手部是 drill/keyboard.js 的事，这里只在开始时清掉上一个提示。
   ============================================================ */
window.RWTyping = {
  create: function (ctx) {
    'use strict';

    function bind() {
    // 作文打字：在原文位置逐字呈现输入反馈，虚拟键盘位于原文下方。
    // 中英文共用同一套渲染与统计，区别只在数据源、字体和输入法处理。
    var writingStartedAt = 0;
    var writingSource = '';
    var writingInput = ctx.el('writingInput');
    var typingLang = 'en';          // en / zh
    var typingComposing = false;    // 中文输入法还在拼拼音：没上屏之前不能按拼音算错

    // 校验一律忽略大小写：原文照原样显示，比较时两边都转小写。
    function sameChar(a, b) {
      return a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
    }

    function typingLangText(lang) {
      var node = ctx.el(lang === 'zh' ? 'articleTranslation' : 'articleSource');
      return node ? String(node.value || '').trim() : '';
    }

    function syncTypingLangUi() {
      var view = ctx.el('view-typing');
      if (view) view.classList.toggle('is-cn', typingLang === 'zh');
      var label = ctx.el('typingSourceLabel');
      if (label) label.textContent = typingLang === 'zh' ? '中文原文' : '英文原文';
      var unit = ctx.el('typingSpeedUnit');
      if (unit) unit.textContent = typingLang === 'zh' ? '字/分' : 'WPM';
      var mode = ctx.el('typingScreenMode');
      if (mode) mode.textContent = typingLang === 'zh' ? '使用中文输入法输入' : '使用实体键盘输入';
      var kbHint = ctx.el('kbHintText');
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
      if (ctx.state.view !== 'typing') return;
      var inp = ctx.el('writingInput');
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
      var host = ctx.el('typingPrompt'); if (!host) return;
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
        ctx.el('articleStatus').textContent = typingLang === 'zh'
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
      ctx.kb.clearHint();
      if (ctx.el('kbState')) ctx.el('kbState').textContent = '等待输入';
      renderTypingPrompt('');
      if (ctx.el('typingPrompt')) ctx.el('typingPrompt').scrollTop = 0;
      ctx.el('typingState').textContent = '开始输入';
      ctx.el('articleStatus').textContent = '练习中';
      ctx.el('writingErrors').textContent = '0'; ctx.el('writingWpm').textContent = '0'; ctx.el('writingAccuracy').textContent = '—';
      return true;
    }
    ctx.el('btnStartWriting').addEventListener('click', function () {
      if (!beginTyping()) return;
      ctx.setView('typing'); writingInput.focus();
    });

    // 中英文切换：正在练就按新语言重开，免得两种文字混在一起
    document.querySelectorAll('[data-typing-lang]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.dataset.typingLang === 'zh' ? 'zh' : 'en';
        if (next === typingLang) return;
        if (ctx.state.view === 'typing' && !typingLangText(next)) {
          ctx.el('articleStatus').textContent = next === 'zh' ? '这篇还没有中文译文' : '还没有英文原文';
          return;
        }
        typingLang = next;
        syncTypingLangUi();
        if (ctx.state.view === 'typing' && beginTyping()) writingInput.focus();
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
      ctx.el('writingErrors').textContent = String(errors);
      // 英文按词（5 字符）算 WPM，中文按字算
      ctx.el('writingWpm').textContent = String(typingLang === 'zh'
        ? Math.round(correct / mins)
        : Math.round((correct / 5) / mins));
      ctx.el('writingAccuracy').textContent = typed.length ? Math.round(correct / typed.length * 100) + '%' : '—';
      ctx.el('kbState').textContent = typed.length >= writingSource.length ? '输入完成' : '已输入 ' + typed.length + ' / ' + writingSource.length;
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
    ctx.el('btnBackToWriting').addEventListener('click', returnToArticleView);
    ctx.el('btnTypingBackBottom').addEventListener('click', returnToArticleView);
    ctx.el('btnSubmitWriting').addEventListener('click', function () {
      if (!writingSource) return;
      var typed = writingInput.value, errors = 0, max = Math.max(typed.length, writingSource.length), correct = 0;
      for (var i = 0; i < max; i++) { if (!sameChar(typed[i], writingSource[i])) errors++; else if (i < typed.length) correct++; }
      ctx.el('writingErrors').textContent = String(errors);
      ctx.el('writingAccuracy').textContent = (max ? Math.round(correct / max * 100) : 0) + '%';
      ctx.el('typingState').textContent = errors ? '已提交 · 有差异' : '已完成 · 完全一致';
      ctx.el('articleStatus').textContent = '本次练习已提交';
      writingInput.disabled = true;
      // 提交后停在原地看结果，不要因为重绘把窗口滚到文末
      renderTypingPrompt(typed, true);
    });
    }

    return { bind: bind };
  }
};
