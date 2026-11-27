/* ============================================================
   Review Words · 备份导出与恢复
   从 reviewwords-enhancements.js 拆出来：把本地数据导成一个 JSON 文件，
   或者把以前导出的 JSON 灌回去。

   规则和以前一样：
     · 导出走 RWStore.entries()，只导出 wordtype.v1 / reviewwords. 开头的键；
     · AI 设置（含 API Key）不写进备份；
     · 恢复前要确认，恢复完直接重载页面。
   ============================================================ */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var RWStore = window.RWStore;
  var KEYS = RWStore.KEYS;
  var AI_SETTINGS = KEYS.aiSettings;

  function today() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function backup() {
    var data = {
      format: "review-words-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: {},
    };
    RWStore.entries().forEach(function (it) {
      if (it.key !== AI_SETTINGS) data.items[it.key] = it.value;
    });
    var blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      }),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review-words-backup-" + today() + ".json";
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 1000);
    $("backupStatus").textContent =
      "已导出 " + Object.keys(data.items).length + " 项本地数据。";
  }
  function restore(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(String(reader.result || ""));
        if (d.format !== "review-words-backup" || !d.items)
          throw new Error("不是有效的 Review Words 备份文件");
        if (
          !confirm(
            "恢复将覆盖备份中同名的数据键，建议先导出当前备份。确定继续吗？",
          )
        )
          return;
        Object.keys(d.items).forEach(function (k) {
          if (k !== AI_SETTINGS && /^(wordtype\.v1|reviewwords\.)/.test(k))
            RWStore.setText(k, String(d.items[k]));
        });
        $("backupStatus").textContent = "恢复成功，页面即将重新载入。";
        setTimeout(function () {
          location.reload();
        }, 500);
      } catch (e) {
        $("backupStatus").textContent = "恢复失败：" + e.message;
      }
    };
    reader.readAsText(file, "UTF-8");
  }

  function bind() {
    var exp = $("btnExportBackup");
    if (exp) exp.addEventListener("click", backup);
    var file = $("backupFile");
    if (file) {
      file.addEventListener("change", function () {
        if (this.files[0]) restore(this.files[0]);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
