// 端到端冒烟：作文训练（modules/pages/writing.js）——薄弱词池、选词页、文章历史
// 跑法：node tests/writing.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8142;
const CDP_PORT = 9242;
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
    } catch (e) {
      // 重试
    }
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-writing-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-writing"))'));

  // 先造两个薄弱词：写入一条「忘了」、一条「模糊」的学习记录
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    db.records = db.records || {};
    db.records['console'] = Object.assign({}, db.records['console'], { seen: 2, last: 1, forgot: 1, lastAt: Date.now() });
    db.records['consist'] = Object.assign({}, db.records['consist'], { seen: 2, last: 2, forgot: 0, lastAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(db));
    return true;
  })()`);
  await cdp.eval(`location.reload()`);
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-today"))'), 15000);
  await sleep(500);

  // 1) 进作文页：薄弱词池要把它俩列出来
  await cdp.eval(`document.querySelector('.nav-btn[data-view="writing"]').click()`);
  await sleep(500);
  const pool = await cdp.eval(`(() => {
    const list = document.getElementById('weakWordList');
    return {
      count: (document.getElementById('weakPoolCount') || {}).textContent || '',
      chips: list ? Array.from(list.querySelectorAll('.weak-word-chip')).map(n => n.textContent) : []
    };
  })()`);
  check('薄弱词池显示了词数', /已选 \d+ \/ 2 个词/.test(pool.count), pool.count);
  check('池里列出了两个薄弱词', pool.chips.some((t) => /console/.test(t)) && pool.chips.some((t) => /consist/.test(t)), JSON.stringify(pool.chips));

  // 2) 进选词页：两组分组、自动选 10 个、确认后回到作文页
  await cdp.eval(`document.getElementById('btnOpenWeakPicker').click()`);
  await sleep(500);
  check('进到选词页', await cdp.eval(`document.getElementById('view-weak-words').classList.contains('is-active')`));
  const groups = await cdp.eval(`(() => ({
    forgot: (document.getElementById('weakGroupForgotCount') || {}).textContent || '',
    fuzzy: (document.getElementById('weakGroupFuzzyCount') || {}).textContent || ''
  }))()`);
  check('忘了组有 1 个词', groups.forgot === '1 个词', groups.forgot);
  check('模糊组有 1 个词', groups.fuzzy === '1 个词', groups.fuzzy);

  await cdp.eval(`document.getElementById('btnWeakAutoPick').click()`);
  await sleep(300);
  check('自动选完后计数 = 2', (await cdp.eval(`document.getElementById('weakPickerCount').textContent`)) === '已选 2 个',
    await cdp.eval(`document.getElementById('weakPickerCount').textContent`));

  await cdp.eval(`document.getElementById('btnWeakConfirm').click()`);
  await sleep(500);
  check('确认后回到作文页', await cdp.eval(`document.getElementById('view-writing').classList.contains('is-active')`));
  check('选择已落库', await cdp.eval(`(() => {
    const m = JSON.parse(localStorage.getItem('reviewwords.weakSelection.v1') || '{}');
    const book = Object.keys(m)[0];
    return Array.isArray(m[book]) && m[book].length === 2;
  })()`));

  // 3) 文章历史：空状态能打开、能返回
  await cdp.eval(`document.getElementById('btnShowHistory').click()`);
  await sleep(500);
  check('打开文章历史页', await cdp.eval(`document.getElementById('view-article-history').classList.contains('is-active')`));
  await cdp.eval(`document.getElementById('btnHistoryBack').click()`);
  await sleep(400);
  check('从历史页返回作文页', await cdp.eval(`document.getElementById('view-writing').classList.contains('is-active')`));

  // 4) 没有配 AI 时手动粘贴文章也能练（只验证开始打字能进）
  await cdp.eval(`(() => {
    document.getElementById('articleSource').value = 'The quick brown fox.';
    document.getElementById('articleTranslation').value = '敏捷的棕色狐狸。';
    return true;
  })()`);
  await cdp.eval(`document.getElementById('btnStartWriting').click()`);
  await waitFor(() => cdp.eval(`document.getElementById('view-typing').classList.contains('is-active')`), 10000);
  check('手动粘贴的文章能开始打字', true);
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
