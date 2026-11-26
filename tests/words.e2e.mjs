// 端到端冒烟：词库页（modules/pages/words.js）——词典懒加载、首字母条、搜索、加进词书
// 跑法：node tests/words.e2e.mjs   （词典 2.9MB，首次加载要等几秒）
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8128;
const CDP_PORT = 9228;
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-words-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWWords && document.getElementById("view-words"))'));

  // 1) 首屏不该下载词典（2.9MB），进词库页才拉
  check('首屏没有请求 dict.js',
    (await cdp.eval(`performance.getEntriesByType('resource').filter(r => r.name.indexOf('dict.js') >= 0).length`)) === 0);

  await cdp.eval(`document.querySelector('.nav-btn[data-view="words"]').click()`);
  await waitFor(() => cdp.eval(`/共 \\d+ 词/.test((document.getElementById('wordCount') || {}).textContent || '')`), 40000);
  const total = await cdp.eval('document.getElementById("wordCount").textContent');
  check('词典加载完并显示总数', /共 \d+ 词/.test(total), total);
  check('进了词库页才请求 dict.js',
    (await cdp.eval(`performance.getEntriesByType('resource').filter(r => r.name.indexOf('dict.js') >= 0).length`)) === 1);

  // 2) 首字母条：26 个字母，点一个只剩该字母开头的词
  check('首字母条有 26 个字母', (await cdp.eval(`document.querySelectorAll('#letterBar .letter-btn').length`)) === 26);
  await cdp.eval(`Array.from(document.querySelectorAll('#letterBar .letter-btn')).find(b => b.dataset.letter === 'Q').click()`);
  await sleep(600);
  check('搜索框填上了字母', (await cdp.eval('document.getElementById("wordSearch").value')) === 'q');
  const firstWords = await cdp.eval(`Array.from(document.querySelectorAll('#wordTableBody tr')).slice(0, 5).map(tr => (tr.dataset.w || '').toLowerCase())`);
  check('结果都是 q 开头', firstWords.length > 0 && firstWords.every((w) => w.startsWith('q')), JSON.stringify(firstWords));
  check('字母按钮高亮', await cdp.eval(`document.querySelector('#letterBar .letter-btn[data-letter="Q"]').classList.contains('is-active')`));

  // 3) 中文搜索：按释义命中
  await cdp.eval(`(() => {
    const input = document.getElementById('wordSearch');
    input.value = '放弃';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const hitText = await cdp.eval('document.getElementById("wordCount").textContent');
  check('中文能搜到词', /命中 \d+ 词/.test(hitText), hitText);
  const hitMeanings = await cdp.eval(`Array.from(document.querySelectorAll('#wordTableBody tr td.a')).slice(0, 3).map(td => td.textContent)`);
  check('命中结果的释义里有「放弃」', hitMeanings.some((t) => t.indexOf('放弃') >= 0), JSON.stringify(hitMeanings));

  // 4) 「加进词书」：挑一个还不在词书里的词，点完这一行要变成学习状态
  const added = await cdp.eval(`(() => {
    const btn = document.querySelector('#wordTableBody button.row-add');
    if (!btn) return null;
    const w = btn.dataset.w;
    btn.click();
    return w;
  })()`);
  check('找到可加入的词', !!added, String(added));
  await sleep(500);
  const rowState = await cdp.eval(`(() => {
    const row = Array.from(document.querySelectorAll('#wordTableBody tr')).find(tr => tr.dataset.w === ${JSON.stringify(String(added))});
    return row ? row.querySelector('.s').textContent.trim() : '(no-row)';
  })()`);
  check('这一行变成「未学」', rowState === '未学', rowState);

  const inBook = await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return (db.custom || []).some(w => String(w.w) === ${JSON.stringify(String(added))});
  })()`);
  check('写进了当前词书的自定义词条', inBook === true);

  // 5) 清空搜索，表恢复全量
  await cdp.eval(`(() => {
    const input = document.getElementById('wordSearch');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  check('清空搜索后回到全量', /^共 \d+ 词$/.test(await cdp.eval('document.getElementById("wordCount").textContent')),
    await cdp.eval('document.getElementById("wordCount").textContent'));
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
