// 端到端冒烟：hands.js（271KB 手部 SVG）不能跟着首屏下载，进打字页才拉
// 跑法：node tests/lazy-hands.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8126;
const CDP_PORT = 9226;
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-hands-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWStore)'));

  // 1) 首屏不该有 hands.js
  const loaded = await cdp.eval(`performance.getEntriesByType('resource').filter(r => r.name.indexOf('hands.js') >= 0).length`);
  check('首屏没有请求 hands.js', loaded === 0, String(loaded));
  check('首屏没有 HANDS_SVG 全局', await cdp.eval('typeof window.HANDS_SVG') === 'undefined');
  check('首屏没有 hands.js 的 script 标签', await cdp.eval(`document.querySelectorAll('script[src*="hands.js"]').length`) === 0);

  // 2) 走真实入口：作文页 → 粘贴一篇短文 → 开始打字 → 这时才该拉 hands.js
  await cdp.eval(`document.querySelector('.nav-btn[data-view="writing"]').click()`);
  await sleep(300);
  await cdp.eval(`(() => {
    document.getElementById('articleSource').value = 'The quick brown fox jumps over the lazy dog.';
    document.getElementById('articleTranslation').value = '敏捷的棕色狐狸跳过了懒狗。';
    return true;
  })()`);
  await cdp.eval(`document.getElementById('btnStartWriting').click()`);
  await waitFor(() => cdp.eval('document.getElementById("view-typing").classList.contains("is-active")'), 8000);
  check('进到打字页', true);
  await waitFor(() => cdp.eval('typeof window.HANDS_SVG === "string"'), 10000);
  check('进打字页才拿到 HANDS_SVG', await cdp.eval('(window.HANDS_SVG || "").length > 1000'),
    String(await cdp.eval('(window.HANDS_SVG || "").length')));
  check('这时才出现 hands.js 的 script 标签',
    await cdp.eval(`document.querySelectorAll('script[src*="hands.js"]').length`) === 1);

  // 3) 手部 SVG 挂进了打字页的容器
  await waitFor(() => cdp.eval(`document.querySelectorAll('#handsSvg svg').length > 0`), 8000);
  check('手部 SVG 挂上去了', await cdp.eval(`document.querySelectorAll('#handsSvg svg').length > 0`));

  // 4) 打字本身还能用：输入首个字符，原文对应字符应变成「已正确」
  await cdp.eval(`(() => {
    const input = document.getElementById('writingInput');
    input.value = 'T';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  check('打字校验还在跑（首字符标绿）', await cdp.eval(`!!document.querySelector('#typingPrompt .typing-char.is-correct')`));
  check('进度条显示已输入 1', /1 \//.test(await cdp.eval('document.getElementById("kbState").textContent')),
    await cdp.eval('document.getElementById("kbState").textContent'));

  // 5) 重复调用不会重复插脚本
  await cdp.eval(`new Promise((resolve) => { window.__review.ensureHands(resolve); setTimeout(resolve, 2000); })`);
  check('重复调用不重复插脚本', await cdp.eval(`document.querySelectorAll('script[src*="hands.js"]').length`) === 1);
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
