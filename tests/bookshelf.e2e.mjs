// 端到端冒烟：书架（modules/pages/bookshelf.js）——卡片、重命名、新建导入、重新学习、删除
// 跑法：node tests/bookshelf.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8130;
const CDP_PORT = 9230;
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

async function waitFor(fn, timeout = 20000, gap = 250) {
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-shelf-e2e-'));
let server, browser, cdp;

const goShelf = `document.querySelector('.nav-btn[data-view="books"]').click()`;
const cardCount = `document.querySelectorAll('#bookshelfGrid .book-card').length`;

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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWBookshelf && document.getElementById("view-today"))'));

  // 1) 初始只有内置红宝书，且标着「当前学习」
  await cdp.eval(goShelf);
  await sleep(400);
  check('初始 1 本词书', (await cdp.eval(cardCount)) === 1, String(await cdp.eval(cardCount)));
  check('内置书标着当前学习', await cdp.eval(`!!document.querySelector('#bookshelfGrid .book-card.is-current .book-badge')`));
  check('卡片上有内置词库字样', /内置词库/.test(await cdp.eval(`document.querySelector('#bookshelfGrid .book-card-sub').textContent`)));

  // 2) 重命名：点「重命名」→ 输入框 → 保存
  await cdp.eval(`Array.from(document.querySelectorAll('#bookshelfGrid .ghost-btn')).find(b => b.textContent === '重命名').click()`);
  await sleep(300);
  check('出现改名输入框', await cdp.eval(`!!document.querySelector('#bookshelfGrid .book-rename-input')`));
  await cdp.eval(`(() => {
    const input = document.querySelector('#bookshelfGrid .book-rename-input');
    input.value = '我的红宝书';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('#bookshelfGrid .ghost-btn')).find(b => b.textContent === '保存').click();
    return true;
  })()`);
  await sleep(400);
  check('改名成功', /我的红宝书/.test(await cdp.eval(`document.querySelector('#bookshelfGrid .book-card strong').textContent`)));
  check('改名写进了存储', (await cdp.eval(`(() => {
    const list = JSON.parse(localStorage.getItem('reviewwords.books.v1') || '[]');
    return list[0] && list[0].name;
  })()`)) === '我的红宝书');

  // 3) 新建词书：填名字 + 塞一个文件 → 导入成功会整页重载
  await cdp.eval(`document.getElementById('btnNewBook').click()`);
  await sleep(300);
  check('新建词书弹层打开', await cdp.eval(`document.getElementById('newBookModal').classList.contains('open')`));
  await cdp.eval(`(() => {
    document.getElementById('newBookName').value = '测试词书';
    // 用数组拼，别在注入的代码里写换行转义（会被外层模板先吃掉一层）
    const nl = String.fromCharCode(10);
    const text = ['apple | /ˈæpəl/ | 苹果', 'banana | /bəˈnɑːnə/ | 香蕉', 'cherry | /ˈtʃeri/ | 樱桃'].join(nl) + nl;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'test.txt', { type: 'text/plain' }));
    document.getElementById('newBookFile').files = dt.files;
    return true;
  })()`);
  await cdp.eval(`document.getElementById('btnCreateBook').click()`);
  await waitFor(() => cdp.eval(`!!(window.__review && (localStorage.getItem('reviewwords.activeBook.v1') || '') !== 'redbook-2024')`), 15000);
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-today"))'), 15000);
  await sleep(500);

  const afterCreate = await cdp.eval(`(() => {
    const list = JSON.parse(localStorage.getItem('reviewwords.books.v1') || '[]');
    return { n: list.length, names: list.map(b => b.name), active: localStorage.getItem('reviewwords.activeBook.v1') };
  })()`);
  check('词书变成 2 本', afterCreate.n === 2, JSON.stringify(afterCreate.names));
  check('新书自动切成当前', afterCreate.active !== 'redbook-2024', afterCreate.active);
  const imported = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:book-') === 0);
    if (!key) return null;
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return { n: (db.custom || []).length, first: (db.custom || [])[0] && db.custom[0].w };
  })()`);
  check('导入 3 个词', !!imported && imported.n === 3, JSON.stringify(imported));
  check('第一个词是 apple', !!imported && imported.first === 'apple');

  await cdp.eval(goShelf);
  await sleep(400);
  check('书架变成 2 张卡', (await cdp.eval(cardCount)) === 2, String(await cdp.eval(cardCount)));

  // 4) 重新学习自定义词书：会弹 confirm，先把它挡成「确定」
  await cdp.eval('window.confirm = function () { return true; }');
  await cdp.eval(`Array.from(document.querySelectorAll('.book-card.is-current .ghost-btn')).find(b => b.textContent === '重新学习').click()`);
  await sleep(600);
  const cleared = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:book-') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return { records: Object.keys(db.records || {}).length, custom: (db.custom || []).length };
  })()`);
  check('重新学习清空记录', cleared.records === 0, JSON.stringify(cleared));
  check('重新学习保留词表', cleared.custom === 3, JSON.stringify(cleared));

  // 5) 删除自定义词书
  await cdp.eval(`Array.from(document.querySelectorAll('.book-card.is-current .ghost-btn')).find(b => b.textContent === '删除').click()`);
  await sleep(300);
  check('出现删除确认', await cdp.eval(`!!document.querySelector('.book-card.is-deleting .book-confirm-text')`));
  await cdp.eval(`Array.from(document.querySelectorAll('.book-card.is-deleting .ghost-btn')).find(b => b.textContent === '确定删除').click()`);
  // 删掉的是当前书，页面会整页重载并落回「今天」页，所以先等重载完再回到书架看
  await waitFor(() => cdp.eval(`(localStorage.getItem('reviewwords.books.v1') || '').indexOf('测试词书') < 0`), 15000);
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-today"))'), 15000);
  await sleep(400);
  await cdp.eval(goShelf);
  await sleep(400);
  check('删除后只剩 1 本', (await cdp.eval(cardCount)) === 1, String(await cdp.eval(cardCount)));
  check('回到内置红宝书', (await cdp.eval(`localStorage.getItem('reviewwords.activeBook.v1')`)) === 'redbook-2024',
    await cdp.eval(`localStorage.getItem('reviewwords.activeBook.v1')`));
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
