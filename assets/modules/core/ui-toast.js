/* ============================================================
   Review Words · 提示条
   全站共用的一个小条，挂在 body 顶部居中出现 4 秒。
   之所以单独拆出来：存储层（core/store.js）也要能弹提示，
   而它比作文模块（reviewwords-enhancements.js）先加载。

   用法：window.RWToast('已保存');  window.RWToast('空间不足', true);
   样式在 assets/css/13-reveal.css（.rw-toast）。
   ============================================================ */
(function (root) {
  'use strict';
  var timer = 0;

  function toast(message, isError) {
    var doc = root.document;
    if (!doc || !doc.body) return false;

    var node = doc.getElementById('rwToast');
    if (!node) {
      node = doc.createElement('div');
      node.id = 'rwToast';
      node.className = 'rw-toast';
      node.setAttribute('role', 'status');
      doc.body.appendChild(node);
    }
    node.textContent = String(message == null ? '' : message);
    node.classList.toggle('is-error', !!isError);
    node.classList.add('is-visible');

    clearTimeout(timer);
    timer = setTimeout(function () { node.classList.remove('is-visible'); }, 4200);
    return true;
  }

  if (!root.RWToast) root.RWToast = toast;
})(typeof globalThis !== 'undefined' ? globalThis : this);
