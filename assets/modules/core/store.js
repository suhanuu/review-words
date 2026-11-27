/* ============================================================
   Review Words · 统一存储层
   以前 localStorage 的读写散在 app.js、reviewwords-enhancements.js 和
   persistence-bootstrap.js 三处，键名各写各的，写失败还被 catch(e){} 吞掉。
   现在只留这一个入口：

     RWStore.get(key, 兜底)      读 JSON，坏了就给兜底值
     RWStore.getText(key)        读原始字符串
     RWStore.set(key, 值)        写 JSON，失败会返回 {ok:false}
     RWStore.setText(key, 字符串) 写原始字符串（当前书 id 这种）
     RWStore.remove(key)         删
     RWStore.entries(/正则/)     备份导出用
     RWStore.usage()             用了多少、占比多少

   写失败（多半是配额满）不再静默：
     · 立刻弹提示条，提醒先导出备份；
     · 同时把这条数据直接补写进 IndexedDB，避免整本词书当场丢；
     · 用量超过八成时提前提醒一次。

   数据放在哪儿没变（还是 localStorage 那几个键 + IndexedDB 镜像），
   键名表在下面的 KEYS 里，新增键只往这里加。

   浏览器里挂到 window.RWStore，Node 里能直接 require（单测用），
   用 RWStore.resetForTest({storage}) 换成假存储。
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RWStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ===================== 键名表（唯一真相） =====================
  var KEYS = {
    legacyBook: 'wordtype.v1',                 // 老版本「一本书一个键」，只在迁移时读
    bookPrefix: 'wordtype.v1:book:',           // wordtype.v1:book:<词书 id>，整本书一个 JSON
    books: 'reviewwords.books.v1',             // 书架列表
    activeBook: 'reviewwords.activeBook.v1',   // 当前词书 id（裸字符串，不是 JSON）
    typingRecords: 'reviewwords.typingRecords.v1',
    articles: 'reviewwords.articles.v1',
    dailyTasks: 'reviewwords.dailyTasks.v1',
    aiSettings: 'reviewwords.aiSettings.v1',
    weakSelection: 'reviewwords.weakSelection.v1',
    reviewLogPrefix: 'reviewwords.revlog.',   // reviewwords.revlog.<词书 id>.<YYYY-MM>，由 review-log.js 追加
    weakHistoryPrefix: 'reviewwords.weakhis.', // reviewwords.weakhis.<词书 id>.<YYYY-MM>，由 weak-history.js 追加
    uiPrefs: 'reviewwords.ui.v1'              // 界面小偏好（日历收起之类），跟学习数据无关
  };

  // 备份导出/恢复认这两个前缀
  var BACKUP_PREFIX = /^(wordtype\.v1|reviewwords\.)/;

  // 浏览器 localStorage 一般给 5MB；Chrome/Edge 按 UTF-16 算，一个字符占 2 字节
  var DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024;
  var DEFAULT_WARN_RATIO = 0.8;

  var storageOverride = null;
  var quotaBytes = DEFAULT_QUOTA_BYTES;
  var warnRatio = DEFAULT_WARN_RATIO;
  var writeErrorHandlers = [];
  var highUsageHandlers = [];
  var warnedThisSession = false;

  function storage() {
    if (storageOverride) return storageOverride;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* 隐私模式下访问 localStorage 本身就可能抛 */ }
    return null;
  }

  function bookKey(id) { return KEYS.bookPrefix + id; }
  function isBackupKey(k) { return BACKUP_PREFIX.test(String(k || '')); }

  // ===================== 通知 =====================
  function emit(list, payload) {
    var handled = false;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); handled = true; } catch (e) { /* 提示失败不能连带把写入搞崩 */ }
    }
    return handled;
  }

  function toast(message, isError) {
    if (typeof root.RWToast === 'function') { root.RWToast(message, isError); return true; }
    if (root.console && root.console.warn) root.console.warn(message);
    return false;
  }

  function reportWriteError(key, err) {
    var quota = isQuotaError(err);
    var message = quota
      ? '本地存储空间满了，刚才的修改没能存下。请先到「备份」里导出备份，再删掉不用的词书腾地方。'
      : '保存失败（' + ((err && err.name) || '未知错误') + '），刚才的修改没能存下。建议先导出备份。';
    var payload = { key: key, error: err, quota: quota, message: message };
    if (!emit(writeErrorHandlers, payload)) toast(message, true);
    return payload;
  }

  function isQuotaError(err) {
    if (!err) return false;
    var name = String(err.name || '');
    var code = err.code;
    return name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      code === 22 ||
      code === 1014 ||
      /quota/i.test(String(err.message || ''));
  }

  // 写失败时兜底：直接补进 IndexedDB 镜像，别等下一次成功写入才同步
  function mirrorToIndexedDB(key, text) {
    try {
      var db = root.ReviewWordsDB;
      if (db && typeof db.put === 'function') db.put(key, text);
    } catch (e) { /* 镜像失败就只当没镜像 */ }
  }

  // ===================== 读 =====================
  function getText(key) {
    var s = storage();
    if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }

  function get(key, fallback) {
    var raw = getText(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
      var val = JSON.parse(raw);
      return (val === null || val === undefined) ? fallback : val;
    } catch (e) {
      return fallback;
    }
  }

  // ===================== 写 =====================
  function setText(key, text) {
    var s = storage();
    var str = String(text);
    if (!s) {
      var noStore = new Error('localStorage 不可用');
      noStore.name = 'NoStorage';
      return { ok: false, error: noStore, message: reportWriteError(key, noStore).message };
    }
    try {
      s.setItem(key, str);
    } catch (err) {
      // 本地盘写不进去：先补 IndexedDB，再提醒用户导出备份
      mirrorToIndexedDB(key, str);
      var info = reportWriteError(key, err);
      return { ok: false, error: err, message: info.message };
    }
    checkUsage();
    return { ok: true };
  }

  function set(key, value) {
    var text;
    try { text = JSON.stringify(value); } catch (e) { return { ok: false, error: e, message: '数据无法序列化：' + e.message }; }
    if (text === undefined) return { ok: false, error: new Error('值无法序列化'), message: '数据无法序列化。' };
    return setText(key, text);
  }

  function remove(key) {
    var s = storage();
    if (!s) return { ok: false, error: new Error('localStorage 不可用') };
    try { s.removeItem(key); return { ok: true }; } catch (e) { return { ok: false, error: e }; }
  }

  // 备份导出/恢复用：[{key, value}]，按前缀过滤
  function entries(matcher) {
    var s = storage();
    if (!s) return [];
    var test = typeof matcher === 'function' ? matcher : (matcher ? function (k) { return matcher.test(k); } : isBackupKey);
    var out = [];
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (k && test(k)) out.push({ key: k, value: s.getItem(k) });
      }
    } catch (e) { /* 个别浏览器遍历时抛错，返回已经拿到的部分 */ }
    return out;
  }

  // ===================== 用量 =====================
  function usage() {
    var s = storage();
    var bytes = 0, count = 0;
    if (s) {
      try {
        for (var i = 0; i < s.length; i++) {
          var k = s.key(i);
          if (!k) continue;
          var v = s.getItem(k) || '';
          bytes += (k.length + v.length) * 2;   // UTF-16
          count++;
        }
      } catch (e) { /* 拿不到就报 0 */ }
    }
    var ratio = quotaBytes > 0 ? bytes / quotaBytes : 0;
    return { bytes: bytes, limitBytes: quotaBytes, ratio: ratio, count: count };
  }

  function checkUsage() {
    if (warnedThisSession) return;
    var u = usage();
    if (u.ratio < warnRatio) return;
    warnedThisSession = true;
    var pct = Math.round(u.ratio * 100);
    var message = '本地存储已用 ' + pct + '%，快满了。建议先导出备份，再清理不用的词书，免得之后写不进去。';
    if (!emit(highUsageHandlers, { usage: u, message: message })) toast(message, false);
  }

  // ===================== 测试/调试 =====================
  function onWriteError(fn) { if (typeof fn === 'function') writeErrorHandlers.push(fn); }
  function onHighUsage(fn) { if (typeof fn === 'function') highUsageHandlers.push(fn); }

  function resetForTest(opts) {
    opts = opts || {};
    storageOverride = opts.storage || null;
    quotaBytes = typeof opts.quotaBytes === 'number' ? opts.quotaBytes : DEFAULT_QUOTA_BYTES;
    warnRatio = typeof opts.warnRatio === 'number' ? opts.warnRatio : DEFAULT_WARN_RATIO;
    writeErrorHandlers = [];
    highUsageHandlers = [];
    warnedThisSession = false;
  }

  return {
    KEYS: KEYS,
    BACKUP_PREFIX: BACKUP_PREFIX,
    bookKey: bookKey,
    isBackupKey: isBackupKey,
    getText: getText,
    get: get,
    setText: setText,
    set: set,
    remove: remove,
    entries: entries,
    usage: usage,
    checkUsage: checkUsage,
    onWriteError: onWriteError,
    onHighUsage: onHighUsage,
    resetForTest: resetForTest
  };
});
