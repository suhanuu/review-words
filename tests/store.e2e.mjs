// 端到端冒烟：存储写失败时必须弹提示条，而且数据要补救进 IndexedDB
// 跑法：node tests/store.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8125;
const CDP_PORT = 9225;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { Connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

async function waitFor(fn, timeout = 15000, gap = 200) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error('等待超时');
    await sleep(gap);
  }
}

class CDP {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' :: ' + expression);
    return res.result.value;
  }
}

let fails = 0;
function check(name, cond, extra = '') {
  if (!cond) fails++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
}

const profile = await mkdtemp(path.join(tmpdir(), 'rw-store-e2e-'));
let server, browser, cdp;

try {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore'
  });
  await waitFor(async () => (await request(`http://127.0.0.1:${PORT}/`)).status === 200, 10000);

  browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  await waitFor(async () => (await request(`http://127.0.0.1:${CDP_PORT}/json/version`)).status === 200, 15000);
  const created = await request(
    `http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/`, 'PUT'
  );
  const target = JSON.parse(created.body);

  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 等 app.js 起来（它由 IndexedDB 引导脚本异步插入）
  await waitFor(() => cdp.eval('!!(window.__review && window.RWStore && document.getElementById("view-today"))'));

  // 1) 存储层已经接管：键名表、用量都能读到
  const keys = await cdp.eval('JSON.stringify(window.RWStore.KEYS)');
  check('RWStore 提供了键名表', /"bookPrefix":"wordtype\.v1:book:"/.test(keys), keys.slice(0, 60));
  const usage = await cdp.eval('window.RWStore.usage()');
  check('usage 能算出现有数据量', usage && usage.bytes > 0 && usage.count > 0, JSON.stringify(usage));

  // 2) 进背词页，拿第一个词
  await cdp.eval('document.getElementById("btnStartLearn").click()');
  await waitFor(() => cdp.eval('document.getElementById("view-drill").classList.contains("is-active")'));
  const word = await cdp.eval('document.getElementById("wordText").textContent');
  check('进到背词页', !!word, word);

  const recBefore = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return db.records[${JSON.stringify(word)}] || null;
  })()`);
  check('评价前还没评过', !recBefore || !recBefore.seen);

  // 3) 模拟配额写满：之后的 setItem 一律抛 QuotaExceededError
  await cdp.eval(`(() => {
    window.__realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    };
    return 'patched';
  })()`);

  // 4) 正常点「熟悉」——写入会失败
  await cdp.eval(`document.querySelector('.rate[data-grade="3"]').click()`);
  await sleep(400);

  const toast = await cdp.eval(`(() => {
    const n = document.getElementById('rwToast');
    return n ? { text: n.textContent, visible: n.classList.contains('is-visible'), error: n.classList.contains('is-error') } : null;
  })()`);
  check('写失败弹出提示条', !!toast && toast.visible === true, JSON.stringify(toast));
  check('提示条说明没存下', !!toast && /没能存下/.test(toast.text), toast && toast.text);
  check('提示条让人先导出备份', !!toast && /导出备份/.test(toast.text));
  check('提示条是错误样式', !!toast && toast.error === true);

  // 5) localStorage 里确实没写进去（说明这一下真的失败了）
  const wrote = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    const r = db.records[${JSON.stringify(word)}];
    return !!(r && r.seen > 0);   // ensureBatch 会先建一条只有 batch 的空记录

  })()`);
  check('这次评分没写进 localStorage', wrote === false);

  // 6) 但数据补救进了 IndexedDB，不至于整条丢
  await sleep(400);
  const mirrored = await cdp.eval(`(async () => {
    if (!window.ReviewWordsDB || !window.ReviewWordsDB.exportAll) return { ok: false, reason: 'no-db' };
    const rows = await window.ReviewWordsDB.exportAll();
    const row = rows.find(r => String(r.key).indexOf('wordtype.v1:book:') === 0);
    if (!row) return { ok: false, reason: 'no-key' };
    let db = {};
    try { db = JSON.parse(row.value) || {}; } catch (e) { return { ok: false, reason: 'bad-json' }; }
    return { ok: true, hasWord: !!(db.records && db.records[${JSON.stringify(word)}]) };
  })()`);
  check('写失败也补了 IndexedDB 镜像', mirrored && mirrored.ok === true && mirrored.hasWord === true, JSON.stringify(mirrored));

  // 7) 页面没被打断：还能揭晓释义、还能翻到下一个词
  const revealed = await cdp.eval('document.querySelector(".drill").classList.contains("is-reveal")');
  check('评价后照常揭晓释义', revealed === true);
  await cdp.eval('document.getElementById("btnMeaningNext").click()');
  await sleep(300);
  const nextWord = await cdp.eval('document.getElementById("wordText").textContent');
  check('还能翻到下一个词', !!nextWord && nextWord !== word, nextWord);

  // 8) 恢复存储能力后，写入正常且不再弹错误提示
  await cdp.eval(`(() => { Storage.prototype.setItem = window.__realSetItem; document.getElementById('rwToast').classList.remove('is-visible'); return 'restored'; })()`);
  await cdp.eval(`document.querySelector('.rate[data-grade="3"]').click()`);
  await sleep(400);
  const after = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    const n = document.getElementById('rwToast');
    return { saved: !!(db.records && db.records[${JSON.stringify(nextWord)}]), shown: n ? n.classList.contains('is-visible') : false };
  })()`);
  check('恢复后写入正常', after && after.saved === true, JSON.stringify(after));
  check('恢复后不再弹错误提示', after && after.shown === false);
} catch (e) {
  fails++;
  console.error('执行出错：', e.message);
} finally {
  try { cdp && cdp.ws.close(); } catch (e) {}
  try { browser && browser.kill(); } catch (e) {}
  try { server && server.kill(); } catch (e) {}
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(fails ? `\n${fails} 项不通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
