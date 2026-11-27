/* ============================================================
   Review Words · 单词详细资料弹层
   从 app.js 拆出来：词根 / 词组 / 固定搭配 / 例句。

   数据离线打包在 assets/detail/：manifest.json 存每个分片的首词，
   客户端二分定位到分片，只取那一个 200KB 左右的文件，取到就缓存在内存里；
   启动不加载，点「详细」才发请求，切词时后台预取当前词所在分片。
   ============================================================ */
window.RWDetail = {
  create: function (ctx) {
    'use strict';

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
    var host = ctx.el('detailBody');
    var html = '';

    // 释义：不管有没有扩展资料，先把中文摆出来
    if (intro.def) {
      html += detailSection('释义', '<p class="detail-def">' + ctx.esc(intro.def) + '</p>');
    }

    // 词库里的词带词形变化（过去式、复数……），背词页的词条没有这一项
    if (intro.forms) {
      html += detailSection('词形变化', '<p class="detail-def">' + ctx.esc(intro.forms) + '</p>');
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
        rec.e.map(function (t) { return '<p class="detail-para">' + ctx.esc(t) + '</p>'; }).join(''));
    }

    if (rec.p && rec.p.length) {
      html += detailSection('词组 · 固定搭配',
        '<ul class="detail-list">' + rec.p.map(function (p) {
          return '<li><b>' + ctx.esc(p[0]) + '</b>' +
            (p[1] ? '<span>' + ctx.esc(p[1]) + '</span>' : '') + '</li>';
        }).join('') + '</ul>');
    }

    if (rec.s && rec.s.length) {
      html += detailSection('例句',
        '<ul class="detail-list detail-sent">' + rec.s.map(function (s) {
          return '<li><i>' + ctx.esc(s[0]) + '</i>' +
            (s[1] ? '<span>' + ctx.esc(s[1]) + '</span>' : '') + '</li>';
        }).join('') + '</ul>');
    }

    if (rec.r && rec.r.ws && rec.r.ws.length) {
      html += detailSection('同根词' + (rec.r.root ? ' · ' + ctx.esc(rec.r.root) : ''),
        '<div class="detail-chips">' + rec.r.ws.map(function (w) {
          return '<div class="detail-chip"><b>' + ctx.esc(w[0]) + '</b>' +
            (w[1] ? '<span>' + ctx.esc(w[1]) + '</span>' : '') + '</div>';
        }).join('') + '</div>');
    }

    host.innerHTML = html;
    host.scrollTop = 0;
    updateDetailScroll();
  }

  // 内容超过可视高度时给底部加个淡出，提示还能往下滚
  function updateDetailScroll() {
    var body = ctx.el('detailBody');
    if (!body) return;
    var more = body.scrollHeight - body.scrollTop - body.clientHeight > 6;
    body.classList.toggle('is-scroll', more);
  }

  function openDetail(word, phonetic, def, forms) {
    if (!word) return;
    detailShown = true;
    ctx.el('detailWord').textContent = word;
    ctx.el('detailPh').textContent = phonetic || '';
    ctx.el('detailBody').innerHTML = '<p class="detail-tip">正在取资料…</p>';
    ctx.el('detailMask').classList.add('show');
    ctx.el('detailSheet').classList.add('show');
    ctx.el('detailSheet').setAttribute('aria-hidden', 'false');

    var intro = { w: word, ph: phonetic, def: def, forms: forms || '' };
    detailOf(word).then(function (rec) {
      if (!detailShown) return;         // 取的过程中已经关掉了
      if (ctx.el('detailWord').textContent !== word) return;  // 已经换成别的词了
      renderDetail(intro, rec);
    }, function () {
      renderDetail(intro, null);
    });
  }

  function closeDetail() {
    if (!detailShown) return;
    detailShown = false;
    ctx.el('detailMask').classList.remove('show');
    ctx.el('detailSheet').classList.remove('show');
    ctx.el('detailSheet').setAttribute('aria-hidden', 'true');
  }

  function openCurrentDetail() {
    var w = ctx.state.current;
    if (!w) return;
    openDetail(w.w, w.ph ? '/' + String(w.ph).replace(/^\/|\/$/g, '') + '/' : '', w.def);
  }

    return {
      openDetail: openDetail,
      closeDetail: closeDetail,
      openCurrentDetail: openCurrentDetail,
      prefetchDetail: prefetchDetail,
      updateDetailScroll: updateDetailScroll,
      isShown: function () { return detailShown; }
    };
  }
};
