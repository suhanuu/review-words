// 端到端冒烟：统计页（modules/pages/stats.js）——数字卡、月度图、当月浮层、打字区、记录页
// 跑法：node tests/stats.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8127;
const CDP_PORT = 9227;
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-stats-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWStats && document.getElementById("view-stats"))'));

  // 1) 进统计页：四个数字卡都在，数值是数字
  await cdp.eval(`document.querySelector('.nav-btn[data-view="stats"]').click()`);
  await sleep(500);
  check('进到统计页', await cdp.eval('document.getElementById("view-stats").classList.contains("is-active")'));

  const cards = await cdp.eval(`(() => {
    const g = (id) => (document.getElementById(id) || {}).textContent || '';
    return { today: g('statWordsToday'), total: g('statWordsTotal'), timeToday: g('statTimeToday'), timeTotal: g('statTimeTotal') };
  })()`);
  check('今日单词是数字', /^\d+$/.test(cards.today), JSON.stringify(cards));
  check('累计单词是数字', /^\d+$/.test(cards.total));
  check('今日时长有单位', /分钟|小时/.test(cards.timeToday), cards.timeToday);
  check('累计时长有单位', /分钟|小时/.test(cards.timeTotal), cards.timeTotal);

  // 2) 月度图真的画了 svg
  check('背词月度图有 svg', await cdp.eval(`document.querySelectorAll('.chart[data-series="words"] svg').length > 0`));

  // 3) 点数字卡弹出当月浮层，关得掉
  await cdp.eval(`document.querySelector('#view-stats [data-pop="words"]').click()`);
  await sleep(400);
  check('弹出当月浮层', await cdp.eval('document.getElementById("monthPop").hidden === false'));
  check('浮层里也画了图', await cdp.eval(`document.querySelectorAll('#monthPopChart svg').length > 0`));
  check('浮层标题是「单词/个」', (await cdp.eval('document.getElementById("monthPopTitle").textContent')) === '单词/个');
  await cdp.eval('document.getElementById("monthClose").click()');
  await sleep(300);
  check('浮层点关闭后收起来', await cdp.eval('document.getElementById("monthPop").hidden === true'));

  // 4) 打字区：切到中文，单位跟着变
  await cdp.eval(`document.querySelector('#view-stats [data-typing-stat="zh"]').click()`);
  await sleep(300);
  const zhUnit = await cdp.eval('document.getElementById("typingChartUnit").textContent');
  check('切中文后打字区单位变「字/分」', zhUnit === '字/分', zhUnit);
  const zhActive = await cdp.eval(`document.querySelector('#view-stats [data-typing-stat="zh"]').classList.contains('is-active')`);
  check('中文按钮高亮', zhActive === true);
  await cdp.eval(`document.querySelector('#view-stats [data-typing-stat="en"]').click()`);
  await sleep(250);
  check('切回英文单位变回 WPM', (await cdp.eval('document.getElementById("typingChartUnit").textContent')) === 'WPM');

  // 5) 点练习次数进打字记录页，再回来
  await cdp.eval('document.getElementById("typingSessionsCard").click()');
  await sleep(400);
  check('进到打字记录页', await cdp.eval('document.getElementById("view-typing-history").classList.contains("is-active")'));
  await cdp.eval('document.getElementById("btnTypingHistoryBack").click()');
  await sleep(400);
  check('返回统计页', await cdp.eval('document.getElementById("view-stats").classList.contains("is-active")'));

  // 6) 复习日志那一排也在（本轮新增的模块负责渲染）
  const logCards = await cdp.eval(`(() => {
    const g = (id) => (document.getElementById(id) || {}).textContent || '';
    return { today: g('revlogToday'), month: g('revlogMonth'), forgot: g('revlogForgot'), gap: g('revlogGap') };
  })()`);
  check('复习日志卡片渲染', /^\d+$/.test(logCards.today) && /^\d+$/.test(logCards.month), JSON.stringify(logCards));
  check('忘了占比有百分号', /%$/.test(logCards.forgot), logCards.forgot);
  check('平均间隔有单位', /天$/.test(logCards.gap), logCards.gap);
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
