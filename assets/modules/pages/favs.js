/* ============================================================
   Review Words · 我的收藏
   从 app.js 拆出来：收藏/取关、收藏页渲染、练习页星标与顶栏数字对齐。

   数据只存 { 单词: 收藏时间戳 }，释义和音标一律回词库现取，不复制词条；
   时间戳既判断收藏与否，也用来做「最新收藏排最前」。

   外面交给它（ctx）：el / db() / state() / save() / esc() / humanGap() / wordByKey()
   ============================================================ */
window.RWFavs = {
  create: function (ctx) {
    'use strict';

  // ================= 收藏 =================
  // 数据只存 { 单词: 收藏时间戳 }，释义、音标一律回词库现取，不复制词条。
  // 时间戳有双重作用：既判断收藏与否，也用来做「最新收藏排最前」的排序。
  var FAV_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.7l2.55 5.2 5.72.83-4.14 4.03.98 5.7L12 16.75l-5.11 2.69.98-5.7-4.14-4.03 5.72-.83z"/></svg>';

  function isFav(word) {
    return !!(word && ctx.db().favs && ctx.db().favs[word]);
  }

  // 有效收藏数：词表换过之后，收藏里可能有词库里已经找不到的旧词，
  // 那些照样留在数据里（不删除用户数据），但不计入显示数量。
  function favItems() {
    var idx = ctx.wordByKey();
    return Object.keys(ctx.db().favs)
      .sort(function (a, b) { return ctx.db().favs[b] - ctx.db().favs[a]; })
      .map(function (k) { return idx[k]; })
      .filter(Boolean);
  }

  function toggleFav(word) {
    if (!word) return false;
    if (!ctx.db().favs) ctx.db().favs = {};
    var on;
    if (ctx.db().favs[word]) { delete ctx.db().favs[word]; on = false; }
    else { ctx.db().favs[word] = Date.now(); on = true; }
    ctx.save();
    syncFavUI();
    // 收藏页正在看的时候：新收藏整体重排（要排到最前），取消收藏只摘掉那一行，
    // 免得整张列表重画、滚动位置跳回顶部
    if (ctx.state().view === 'favs') {
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
  }

  function favTime(ts) {
    var d = Date.now() - (ts || 0);
    if (!ts) return '';
    if (d < 50000) return '刚刚';
    return ctx.humanGap(d) + '前';
  }

  function favRow(w) {
    var ph = w.ph ? '/' + String(w.ph).replace(/^\/|\/$/g, '') + '/' : '';
    var ts = ctx.db().favs[w.w] || 0;
    return '<div class="fav-row" data-w="' + ctx.esc(w.w) + '" data-ph="' + ctx.esc(ph) + '"' +
      ' data-def="' + ctx.esc(w.def || w.a) + '" role="button" tabindex="0">' +
      '<button class="fav-btn is-on" type="button" data-fav="' + ctx.esc(w.w) + '"' +
      ' title="取消收藏" aria-label="取消收藏 ' + ctx.esc(w.w) + '">' + FAV_SVG + '</button>' +
      '<div class="fav-body">' +
      '<div class="fav-line"><span class="fav-word">' + ctx.esc(w.w) + '</span>' +
      '<span class="fav-ph">' + ctx.esc(ph) + '</span></div>' +
      '<div class="fav-def">' + ctx.esc(w.a || w.def) + '</div>' +
      '</div>' +
      '<span class="fav-time">' + ctx.esc(favTime(ts)) + '</span>' +
      '</div>';
  }

  function renderFavs() {
    var items = favItems();
    var host = ctx.el('favList');
    var empty = ctx.el('favEmpty');
    if (!host) return;

    if (!items.length) {
      host.innerHTML = '';
      host.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }

    host.innerHTML = items.map(favRow).join('');
    host.hidden = false;
    if (empty) empty.hidden = true;
    if (sub) {
      sub.innerHTML = '共 <b>' + items.length + '</b> 个词，最新收藏的排在最前面，点词看词根和例句。';
    }
  }

  // 练习页星标、顶栏数字、收藏页列表，统一在这里对齐
  function syncFavUI() {
    var btn = ctx.el('btnFav');
    if (btn) {
      var on = ctx.state().current ? isFav(ctx.state().current.w) : false;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? '取消收藏' : '收藏这个词';
      btn.setAttribute('aria-label', on ? '取消收藏' : '收藏这个词');
    }

    var n = favItems().length;
    var badge = ctx.el('navFavCount');
    if (badge) {
      badge.textContent = n;
      badge.hidden = !n;
    }
  }

    return {
      isFav: isFav,
      toggleFav: toggleFav,
      favItems: favItems,
      renderFavs: renderFavs,
      syncFavUI: syncFavUI
    };
  }
};
