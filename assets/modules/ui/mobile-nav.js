/* ============================================================
   Review Words · 手机底部导航的「更多」面板
   从 reviewwords-enhancements.js 拆出来的独立小块：只操作 DOM，
   不碰存储、不依赖别的模块。

   ≤720px 时底栏多出一个「更多」，点开是个上滑面板（书架 / 词库 / 收藏 / 设置 / 换主题）；
   面板打开时锁 body 滚动，点遮罩、按 Esc、点底栏别处都能关。
   ============================================================ */
/* ---------- 手机底部导航：「更多」面板（UI 第 3 步） ---------- */
(function () {
  var tabbar = document.getElementById("tabbar");
  if (!tabbar) return;
  var sheet = document.getElementById("moreSheet");
  var mask = document.getElementById("moreMask");
  var moreBtn = document.getElementById("btnMore");
  var closeBtn = document.getElementById("btnMoreClose");
  if (!sheet || !mask || !moreBtn) return;

  function isOpen() {
    return sheet.classList.contains("open");
  }
  function open() {
    sheet.classList.add("open");
    mask.classList.add("open");
    document.body.classList.add("more-open");
    moreBtn.setAttribute("aria-expanded", "true");
    sheet.setAttribute("aria-hidden", "false");
  }
  function close() {
    sheet.classList.remove("open");
    mask.classList.remove("open");
    document.body.classList.remove("more-open");
    moreBtn.setAttribute("aria-expanded", "false");
    sheet.setAttribute("aria-hidden", "true");
  }
  function go(view) {
    close();
    var target = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (target) target.click();
  }
  function syncMore() {
    var active = document.querySelector(".view.is-active");
    var name = active ? active.id.replace("view-", "") : "";
    moreBtn.classList.toggle(
      "is-active",
      name === "books" || name === "words" || name === "favs",
    );
  }

  moreBtn.addEventListener("click", function () {
    isOpen() ? close() : open();
  });
  mask.addEventListener("click", close);
  if (closeBtn) closeBtn.addEventListener("click", close);
  Array.prototype.forEach.call(
    sheet.querySelectorAll("[data-goto]"),
    function (b) {
      b.addEventListener("click", function () {
        go(b.getAttribute("data-goto"));
      });
    },
  );
  var settingsBtn = document.getElementById("moreSettings");
  if (settingsBtn)
    settingsBtn.addEventListener("click", function () {
      close();
      var t = document.getElementById("btnSettings");
      if (t) t.click();
    });
  var themeBtn = document.getElementById("moreTheme");
  if (themeBtn)
    themeBtn.addEventListener("click", function () {
      close();
      var t = document.getElementById("btnTheme");
      if (t) t.click();
    });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) close();
  });
  tabbar.addEventListener("click", function (e) {
    if (e.target.closest("#btnMore")) return;
    if (isOpen()) close();
  });
  var main = document.querySelector(".main");
  if (main && window.MutationObserver) {
    new MutationObserver(syncMore).observe(main, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }
  syncMore();
})();
