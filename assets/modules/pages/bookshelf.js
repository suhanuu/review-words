/* ============================================================
   Review Words · 书架（多词书）
   从 app.js 拆出来：词书卡片、进度、切换/重命名/删除/重新学习、新建并导入词书。

   词书清单自己攒着（shelf.books），落盘仍然走 core/store.js 的
   reviewwords.books.v1；每本词书的记录还是各自一个
   wordtype.v1:book:<id> 键，互不串用。

   外面交给它（ctx）：
     el(id)              取元素
     store / keys        统一存储与键名表
     defaultBookId       内置红宝书的 id
     defaultSettings     新词书的默认设置
     log                 core/review-log.js（重新学习时连带清日志）
     parseImport(text)   解析导入的 CSV/TXT
     activeId()          当前是哪本
     reloadCurrent()     重新载入当前词书并回到今天页（app.js 那边做，涉及 db/state）
   ============================================================ */
window.RWBookshelf = {
  create: function (ctx) {
    'use strict';

    var shelf = { books: readBooks() };
    var renamingId = null, deletingId = null;

    function readBooks() {
      var list = ctx.store.get(ctx.keys.books, null);
      if (Array.isArray(list) && list.length) return list;
      var initial = [{
        id: ctx.defaultBookId,
        name: '2024 考研英语词汇·红宝书',
        kind: 'builtin',
        createdAt: Date.now(),
        wordCount: (window.WORD_BANK || []).length
      }];
      ctx.store.set(ctx.keys.books, initial);
      return initial;
    }

  // ================= 多词书管理（本地优先） =================
  function bookArchive(book) {
    var raw = ctx.store.getText(ctx.store.bookKey(book.id));
    if (!raw && book.id === ctx.defaultBookId) raw = ctx.store.getText(ctx.keys.legacyBook); // 老数据兜底
    var data = {};
    try { data = JSON.parse(raw || '{}') || {}; } catch (e) { data = {}; }
    return data;
  }

  function bookStats(book) {
    var data = bookArchive(book), records = data.records || {};
    var words = book.kind === 'builtin'
      ? (data.custom || []).concat(window.WORD_BANK || [])
      : (data.custom || []);
    var learned = 0, mastered = 0;
    for (var i = 0; i < words.length; i++) {
      var r = records[words[i] && words[i].w];
      if (r && r.seen > 0) {
        learned++;
        if (r.last === 3) mastered++;
      }
    }
    return { learned: learned, mastered: mastered, total: words.length || book.wordCount || 0 };
  }

  function fmtDate(ts) {
    var d = new Date(Number(ts) || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  var renamingId = null, deletingId = null;

  function renderBookshelf() {
    var grid = ctx.el('bookshelfGrid'); if (!grid) return; grid.innerHTML = '';
    shelf.books.forEach(function (book) {
      var current = book.id === ctx.activeId();
      var stats = bookStats(book);
      var pct = stats.total ? Math.min(100, (stats.learned / stats.total) * 100) : 0;
      var renaming = book.id === renamingId;
      var deleting = book.id === deletingId;

      var card = document.createElement('article');
      card.className = 'book-card' + (current ? ' is-current' : '') + (deleting ? ' is-deleting' : '');

      var top = document.createElement('div'); top.className = 'book-card-top';
      var cover = document.createElement('div'); cover.className = 'book-cover'; cover.textContent = String(book.name || '词').replace(/[0-9\s·.\-—]/g, '').slice(0, 1) || '词';
      var meta = document.createElement('div'); meta.className = 'book-card-meta';
      if (renaming) {
        var input = document.createElement('input');
        input.type = 'text'; input.className = 'book-rename-input';
        input.value = book.name; input.maxLength = 60;
        input.setAttribute('aria-label', '新的词书名称');
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); commitRename(book, input.value); }
          if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
        });
        meta.appendChild(input);
      } else {
        var title = document.createElement('strong'); title.textContent = book.name;
        meta.appendChild(title);
      }
      var sub = document.createElement('span'); sub.className = 'book-card-sub';
      sub.textContent = (book.kind === 'builtin' ? '内置词库' : '自定义词书') + ' · 创建于 ' + fmtDate(book.createdAt);
      meta.appendChild(sub);
      top.appendChild(cover); top.appendChild(meta);
      if (current) {
        var badge = document.createElement('span'); badge.className = 'book-badge'; badge.textContent = '当前学习';
        top.appendChild(badge);
      }
      card.appendChild(top);

      var prog = document.createElement('div'); prog.className = 'book-progress';
      var bar = document.createElement('div'); bar.className = 'book-progress-bar';
      var fill = document.createElement('i'); fill.style.width = pct.toFixed(1) + '%'; bar.appendChild(fill);
      var line = document.createElement('div'); line.className = 'book-progress-text';
      var left = document.createElement('span'); left.textContent = '已背 ' + stats.learned + ' / ' + stats.total;
      var right = document.createElement('span'); right.textContent = '很熟 ' + stats.mastered;
      line.appendChild(left); line.appendChild(right);
      prog.appendChild(bar); prog.appendChild(line);
      card.appendChild(prog);

      var actions = document.createElement('div'); actions.className = 'book-card-actions';
      if (renaming) {
        var save = document.createElement('button'); save.type = 'button'; save.className = 'ghost-btn'; save.textContent = '保存';
        save.addEventListener('click', function () { commitRename(book, input.value); });
        var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ghost-btn'; cancel.textContent = '取消';
        cancel.addEventListener('click', cancelRename);
        actions.appendChild(save); actions.appendChild(cancel);
      } else if (deleting) {
        actions.className = 'book-card-actions is-confirm';
        var warn = document.createElement('span'); warn.className = 'book-confirm-text'; warn.textContent = '删除后无法恢复';
        var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'ghost-btn is-danger'; ok.textContent = '确定删除';
        ok.addEventListener('click', function () { confirmDelete(book); });
        var no = document.createElement('button'); no.type = 'button'; no.className = 'ghost-btn'; no.textContent = '取消';
        no.addEventListener('click', cancelDelete);
        actions.appendChild(warn); actions.appendChild(ok); actions.appendChild(no);
      } else {
        if (!current) {
          var sw = document.createElement('button'); sw.type = 'button'; sw.className = 'ghost-btn'; sw.textContent = '切换到这本';
          sw.addEventListener('click', function () { ctx.store.setText(ctx.keys.activeBook, book.id); location.reload(); });
          actions.appendChild(sw);
        }
        var rn = document.createElement('button'); rn.type = 'button'; rn.className = 'ghost-btn'; rn.textContent = '重命名';
        rn.addEventListener('click', function () { startRename(book); });
        actions.appendChild(rn);
        var rl = document.createElement('button'); rl.type = 'button'; rl.className = 'ghost-btn'; rl.textContent = '重新学习';
        rl.addEventListener('click', function () { resetBook(book); });
        actions.appendChild(rl);
        if (book.kind !== 'builtin') {
          var del = document.createElement('button'); del.type = 'button'; del.className = 'ghost-btn is-danger'; del.textContent = '删除';
          del.addEventListener('click', function () { startDelete(book); });
          actions.appendChild(del);
        }
      }
      card.appendChild(actions);
      grid.appendChild(card);
    });
    if (!shelf.books.length) grid.textContent = '还没有词书。';
    if (renamingId) {
      var focusInput = grid.querySelector('.book-rename-input');
      if (focusInput) { focusInput.focus(); focusInput.select(); }
    }
  }

  // 重新学习：清掉这本书的学习记录（收藏、词表、设置都保留）
  function resetBook(book) {
    if (!confirm('确认重新学习吗？\n重新学习会重置这本书的学习进度。')) return;

    var key = ctx.store.bookKey(book.id);
    var raw = ctx.store.get(key, {});
    raw.records = {};
    raw.days = {};
    ctx.store.set(key, raw);
    ctx.log.clearBook(book.id);   // 复习日志跟着这本书一起重置，别的书不动

    if (book.id === ctx.activeId()) {
      ctx.reloadCurrent();
    }
    renderBookshelf();
  }

  function startRename(book) { renamingId = book.id; deletingId = null; renderBookshelf(); }  function cancelRename() { renamingId = null; renderBookshelf(); }
  function commitRename(book, value) {
    var name = String(value || '').trim();
    renamingId = null;
    if (name && name !== book.name) {
      book.name = name;
      ctx.store.set(ctx.keys.books, shelf.books);
    }
    renderBookshelf();
  }

  function startDelete(book) { deletingId = book.id; renamingId = null; renderBookshelf(); }
  function cancelDelete() { deletingId = null; renderBookshelf(); }
  function confirmDelete(book) {
    if (book.kind === 'builtin') return;
    deletingId = null;
    shelf.books = shelf.books.filter(function (b) { return b.id !== book.id; });
    ctx.store.set(ctx.keys.books, shelf.books);
    ctx.store.remove(ctx.store.bookKey(book.id));
    if (ctx.activeId() === book.id) { ctx.store.setText(ctx.keys.activeBook, ctx.defaultBookId); location.reload(); return; }
    renderBookshelf();
  }

  function openNewBook() {
    var modal = ctx.el('newBookModal'), mask = ctx.el('newBookMask');
    if (!modal || !mask) return;
    mask.classList.add('open');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    var hint = ctx.el('bookImportHint'); if (hint) hint.textContent = '每行格式：单词 | 音标 | 中文释义。也支持逗号或 Tab 分隔。';
    setTimeout(function () { var n = ctx.el('newBookName'); if (n) n.focus(); }, 60);
  }

  function closeNewBook() {
    var modal = ctx.el('newBookModal'), mask = ctx.el('newBookMask');
    if (!modal || !mask) return;
    mask.classList.remove('open');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function createBookFromFile() {
    var name = (ctx.el('newBookName').value || '').trim(), file = ctx.el('newBookFile').files && ctx.el('newBookFile').files[0], hint = ctx.el('bookImportHint');
    if (!name) { hint.textContent = '请先填写词书名称。'; return; }
    if (!file) { hint.textContent = '请选择 CSV 或 TXT 文件。'; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = ctx.parseImport(String(reader.result || ''));
      if (!parsed.length) { hint.textContent = '没有识别到有效单词。每行格式：单词 | 音标 | 中文释义。'; return; }
      var seen = {}, words = [];
      parsed.forEach(function (w) { var k = String(w.w || '').toLowerCase(); if (k && !seen[k]) { seen[k] = 1; words.push(w); } });
      if (!words.length) { hint.textContent = '文件中没有有效单词。'; return; }
      var id = 'book-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      shelf.books.push({ id: id, name: name, kind: 'custom', createdAt: Date.now(), wordCount: words.length });
      ctx.store.set(ctx.keys.books, shelf.books);
      ctx.store.set(ctx.store.bookKey(id), { settings: Object.assign({}, ctx.defaultSettings), records: {}, days: {}, custom: words, favs: {} });
      ctx.store.setText(ctx.keys.activeBook, id); hint.textContent = '已导入 ' + words.length + ' 个单词，正在切换……';
      setTimeout(function () { location.reload(); }, 250);
    };
    reader.onerror = function () { hint.textContent = '文件读取失败。'; };
    reader.readAsText(file, 'UTF-8');
  }

    // 新建词书弹层的开关与 ESC 收尾
    function bind() {
      if (ctx.el('btnCreateBook')) ctx.el('btnCreateBook').addEventListener('click', createBookFromFile);
      if (ctx.el('btnNewBook')) ctx.el('btnNewBook').addEventListener('click', openNewBook);
      if (ctx.el('btnNewBookClose')) ctx.el('btnNewBookClose').addEventListener('click', closeNewBook);
      if (ctx.el('btnNewBookCancel')) ctx.el('btnNewBookCancel').addEventListener('click', closeNewBook);
      if (ctx.el('newBookMask')) ctx.el('newBookMask').addEventListener('click', closeNewBook);
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var m = ctx.el('newBookModal');
        if (m && m.classList.contains('open')) closeNewBook();
      });
    }

    return {
      list: function () { return shelf.books; },
      renderBookshelf: renderBookshelf,
      bind: bind
    };
  }
};
