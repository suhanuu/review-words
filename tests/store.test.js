// 用 node 跑：node tests/store.test.js
// 只测 assets/modules/core/store.js，不碰页面、不碰真实 localStorage（用假存储）。
const Store = require('../assets/modules/core/store.js');

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}
function truthy(name, got) {
  const ok = !!got;
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got);
}

// ---------- 假 localStorage ----------
function makeStorage(opts) {
  opts = opts || {};
  const map = new Map(opts.seed ? Object.entries(opts.seed) : []);
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) {
      if (opts.failRead) throw new Error('read blocked');
      return map.has(String(k)) ? map.get(String(k)) : null;
    },
    setItem(k, v) {
      if (opts.failAll) throw new Error('setItem blocked');
      if (opts.quotaAfter !== undefined && JSON.stringify(k).length + String(v).length > opts.quotaAfter) {
        const err = new Error('Storage quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(String(k), String(v));
    },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _map: map
  };
}

function fresh(store, storage, opts) {
  store.resetForTest(Object.assign({ storage }, opts || {}));
  return storage;
}

// ---------- 1. 基本读写 ----------
let storage = makeStorage();
Store.resetForTest({ storage });

truthy('set 成功', Store.set('reviewwords.books.v1', [{ id: 'a', name: '红宝书' }]).ok);
eq('get 读回对象', JSON.stringify(Store.get('reviewwords.books.v1', null)), '[{"id":"a","name":"红宝书"}]');
eq('get 缺失键给兜底', Store.get('reviewwords.nope.v1', 'fallback'), 'fallback');
eq('get 空字符串给兜底', (storage._map.set('reviewwords.empty.v1', ''), Store.get('reviewwords.empty.v1', [])).length, 0);

storage._map.set('reviewwords.broken.v1', '{这不是 JSON');
eq('get 坏 JSON 给兜底', Store.get('reviewwords.broken.v1', { safe: 1 }).safe, 1);

truthy('setText 写裸字符串', Store.setText('reviewwords.activeBook.v1', 'book-42').ok);
eq('getText 读裸字符串', Store.getText('reviewwords.activeBook.v1'), 'book-42');
eq('getText 缺失键给 null', Store.getText('reviewwords.missing.v1'), 'null');

truthy('remove 成功', Store.remove('reviewwords.activeBook.v1').ok);
eq('remove 之后读不到', Store.getText('reviewwords.activeBook.v1'), 'null');

// ---------- 2. 键名表 ----------
eq('bookKey 拼法', Store.bookKey('redbook-2024'), 'wordtype.v1:book:redbook-2024');
truthy('legacy 键在备份前缀里', Store.isBackupKey('wordtype.v1'));
truthy('词书键在备份前缀里', Store.isBackupKey('wordtype.v1:book:x'));
truthy('reviewwords 键在备份前缀里', Store.isBackupKey('reviewwords.articles.v1'));
eq('别的前缀不算', Store.isBackupKey('other.key'), 'false');

const listed = Store.entries();
truthy('entries 能列出数据键', listed.length >= 1);
truthy('entries 不列无关键', listed.filter((it) => it.key === 'other.key').length === 0);

// ---------- 3. 写失败：必须报错、必须补镜像 ----------
storage = makeStorage({ quotaAfter: 0 });   // 任何写入都抛 QuotaExceededError
const mirrored = [];
globalThis.ReviewWordsDB = { put(k, v) { mirrored.push([k, v]); } };
const errors = [];
Store.resetForTest({ storage });
Store.onWriteError((info) => errors.push(info));

const failed = Store.set('wordtype.v1:book:redbook-2024', { records: { apple: { step: 2 } } });
eq('写失败返回 ok=false', failed.ok, 'false');
eq('写失败调用了一次提示', errors.length, 1);
eq('写失败标成配额问题', errors[0].quota, 'true');
truthy('提示语提醒导出备份', /导出备份/.test(errors[0].message));
eq('写失败也补了 IndexedDB 镜像', mirrored.length, 1);
eq('镜像的键对得上', mirrored[0][0], 'wordtype.v1:book:redbook-2024');
truthy('镜像的内容是完整 JSON', mirrored[0][1].indexOf('"apple"') > 0);

// 非配额错误也照样提示，但文案不同
storage = makeStorage({ failAll: true });
const otherErrors = [];
Store.resetForTest({ storage });
Store.onWriteError((info) => otherErrors.push(info));
Store.set('reviewwords.books.v1', []);
eq('非配额错误也提示', otherErrors.length, 1);
eq('非配额错误 quota=false', otherErrors[0].quota, 'false');

// 没有注册处理函数时，走提示条
delete globalThis.ReviewWordsDB;
let toastCalls = [];
globalThis.RWToast = (msg, isError) => toastCalls.push({ msg, isError });
Store.resetForTest({ storage: makeStorage({ failAll: true }) });
Store.set('reviewwords.books.v1', []);
eq('没注册处理函数就弹提示条', toastCalls.length, 1);
eq('提示条是错误样式', toastCalls[0].isError, 'true');
delete globalThis.RWToast;

// ---------- 4. 用量与八成提醒 ----------
storage = makeStorage();
const warns = [];
Store.resetForTest({ storage, quotaBytes: 1000, warnRatio: 0.8 });
Store.onHighUsage((info) => warns.push(info));

Store.setText('reviewwords.articles.v1', 'x'.repeat(300));   // (键 + 300) * 2 ≈ 650 字节，65%
eq('六成五不提醒', warns.length, 0);
Store.setText('reviewwords.dailyTasks.v1', 'y'.repeat(300));  // 再加 ~650，超过八成
eq('超过八成提醒一次', warns.length, 1);
truthy('提醒里有百分比', /\d+%/.test(warns[0].message));
Store.setText('reviewwords.weakSelection.v1', 'z'.repeat(10));
eq('同一会话只提醒一次', warns.length, 1);

const u = Store.usage();
truthy('usage 字节数为正', u.bytes > 0);
truthy('usage 比率大于 1 说明算进去了', u.ratio > 1);
eq('usage 统计键数', u.count, 3);

console.log(fails ? '\n有 ' + fails + ' 项没过' : '\n全部通过');
process.exit(fails ? 1 : 0);
