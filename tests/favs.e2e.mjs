// 端到端冒烟：收藏（modules/pages/favs.js）——练习页星标、顶栏数字、收藏页列表
// 跑法：node tests/favs.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8129;
const CDP_PORT = 9229;
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-favs-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWFavs && document.getElementById("view-today"))'));

  check('一开始没有收藏', await cdp.eval('window.__review.favItems().length') === 0);

  // 进背词页，收藏当前这个词
  await cdp.eval('document.getElementById("btnStartLearn").click()');
  await waitFor(() => cdp.eval('document.getElementById("view-drill").classList.contains("is-active")'));
  const word = await cdp.eval('document.getElementById("wordText").textContent');
  await cdp.eval('document.getElementById("btnFav").click()');
  await sleep(250);

  check('星标点亮', await cdp.eval('document.getElementById("btnFav").classList.contains("is-on")'));
  check('顶栏数字变成 1', (await cdp.eval('document.getElementById("navFavCount").textContent')) === '1');
  check('favItems 里有这个词', await cdp.eval(`window.__review.favItems().some(w => w.w === ${JSON.stringify(word)})`));
  check('写进了当前词书的 favs', await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return !!(db.favs && db.favs[${JSON.stringify(word)}]);
  })()`));

  // 收藏页：一行、显示词、显示「刚刚」
  await cdp.eval(`document.querySelector('.nav-btn[data-view="favs"]').click()`);
  await sleep(400);
  const rows = await cdp.eval(`(() => {
    const list = document.querySelectorAll('#favList .fav-row');
    const first = list[0];
    return {
      n: list.length,
      word: first ? first.dataset.w : '',
      time: first ? first.querySelector('.fav-time').textContent : '',
      sub: document.getElementById('favSub').textContent
    };
  })()`);
  check('收藏页只一行', rows.n === 1, JSON.stringify(rows));
  check('显示收藏的词', rows.word === word, rows.word);
  check('时间是「刚刚」', /刚刚/.test(rows.time), rows.time);
  check('副标题写了 1 个词', /1/.test(rows.sub), rows.sub);

  // 在收藏页取消收藏：行要消失、回到空状态
  await cdp.eval(`document.querySelector('#favList .fav-btn').click()`);
  await sleep(400);
  const after = await cdp.eval(`(() => {
    return {
      n: document.querySelectorAll('#favList .fav-row').length,
      hidden: document.getElementById('favList').hidden,
      empty: document.getElementById('favEmpty').hidden,
      sub: document.getElementById('favSub').textContent,
      count: document.getElementById('navFavCount').textContent
    };
  })()`);
  check('取消后列表清空', after.n === 0, JSON.stringify(after));
  check('列表隐藏、空状态显示', after.hidden === true && after.empty === false);
  check('顶栏数字消失', after.count === '' || after.count === '0', after.count);
  check('副标题变回「还没收藏」', /还没收藏/.test(after.sub), after.sub);

  // 回到背词页，星标应该灭了
  await cdp.eval(`document.querySelector('.nav-btn[data-view="today"]').click()`);
  await sleep(300);
  await cdp.eval('document.getElementById("btnStartLearn").click()');
  await sleep(500);
  check('星标已灭', (await cdp.eval('document.getElementById("btnFav").classList.contains("is-on")')) === false);
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
