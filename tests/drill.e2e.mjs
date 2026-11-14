// 端到端冒烟：起静态服务 + 无头 Edge，用 CDP 真的点按钮，验证背词节奏
// 跑法：node tests/drill.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const CDP_PORT = 9222;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 node:http 而不是 fetch：undici 连本地无头浏览器偶尔会报断言错
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-e2e-'));
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
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("wordText").textContent)'));
  const firstWord = await cdp.eval('document.getElementById("wordText").textContent');

  const recOf = (w) => `(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1') === 0 && k.indexOf(':book:') > 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    return db.records[${JSON.stringify(w)}] || null;
  })()`;

  check('首词有内容', !!firstWord, firstWord);

  // 1) 点「熟悉」：step 1，明天再见
  await cdp.eval('document.querySelector(\'.rate[data-grade="3"]\').click()');
  await sleep(250);
  let rec = await cdp.eval(recOf(firstWord));
  const dayMs = 86400000;
  check('熟悉 1 次 → step 1', rec && rec.step === 1, JSON.stringify(rec && rec.step));
  check('熟悉 1 次 → 隔约 1 天', rec && Math.abs(rec.iv - dayMs) < 1000, JSON.stringify(rec && rec.iv));
  check('熟悉 1 次 → 还没到很熟', rec && !rec.masteredAt);
  const revealHidden = await cdp.eval('document.getElementById("rateFeedback").hidden');
  check('揭晓区不展示底层进度', revealHidden === true);

  // 2) 下一个词，直接点右上角「熟悉」：标成已完成，以后不再出现
  await cdp.eval('document.getElementById("btnMeaningNext").click()');
  await sleep(300);
  const w2 = await cdp.eval('document.getElementById("wordText").textContent');
  check('翻到下一个词', w2 && w2 !== firstWord, w2);
  const btnBefore = await cdp.eval('!!document.getElementById("btnDrillMaster") && !document.getElementById("btnDrillMaster").disabled');
  check('右上角按钮可点', btnBefore === true);
  await cdp.eval('document.getElementById("btnDrillMaster").click()');
  await sleep(250);
  rec = await cdp.eval(recOf(w2));
  check('点熟悉 → 标记完成', rec && rec.done === 1, JSON.stringify(rec && rec.done));
  check('点熟悉 → 不再排队', rec && rec.dueAt === 0, JSON.stringify(rec && rec.dueAt));
  check('点熟悉 → 算很熟', rec && rec.masteredAt > 0);
  const btnDone = await cdp.eval('document.getElementById("btnDrillMaster").classList.contains("is-done")');
  const btnText = await cdp.eval('document.getElementById("btnDrillMaster").textContent.trim()');
  check('点熟悉 → 按钮变已完成', btnDone === true, btnText);
  const stillQueued = await cdp.eval(`window.__review.duePool(Date.now()).some(x => x.w.w === ${JSON.stringify(w2)})`);
  check('标记完成的词不进复习队列', stillQueued === false);

  // 3) 下一个词点「忘了」：清零、15 分钟
  await cdp.eval('document.getElementById("btnMeaningNext").click()');
  await sleep(300);
  const w3 = await cdp.eval('document.getElementById("wordText").textContent');
  await cdp.eval('document.querySelector(\'.rate[data-grade="1"]\').click()');
  await sleep(250);
  rec = await cdp.eval(recOf(w3));
  check('忘了 → step 0', rec && rec.step === 0, JSON.stringify(rec && rec.step));
  check('忘了 → 15 分钟', rec && Math.abs(rec.iv - 15 * 60000) < 1000, JSON.stringify(rec && rec.iv));

  // 4) 老数据迁移：塞一条老格式记录再刷新
  await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1') === 0 && k.indexOf(':book:') > 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    db.records['apple'] = { seen: 5, iv: 1.5 * 86400000, dueAt: Date.now() + 1.5 * 86400000, last: 3, lastAt: Date.now() - 86400000, forgot: 0 };
    localStorage.setItem(key, JSON.stringify(db));
    return 'ok';
  })()`);
  await cdp.eval('location.reload()');
  await sleep(500);
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("wordText").textContent)'));
  const migrated = await cdp.eval(recOf('apple'));
  check('老记录 1.5 天 → step 3', migrated && migrated.step === 3, JSON.stringify(migrated && migrated.step));
  check('老记录 → 补上很熟时刻', migrated && migrated.masteredAt > 0);
  check('老记录 → 到期按新阶梯对齐', migrated && Math.abs(migrated.dueAt - (migrated.lastAt + dayMs)) < 5000);

  // 5) 毕业：step 10 再熟悉一次 = 11，出队
  const grad = await cdp.eval(`(() => {
    const r = { step: 10, seen: 3, forgot: 0 };
    window.__review.applyGrade(r, 3);
    return { step: r.step, done: r.done, dueAt: r.dueAt };
  })()`);
  check('180 天那档过了 → step 11', grad.step === 11, JSON.stringify(grad.step));
  check('毕业标记', grad.done === 1, JSON.stringify(grad.done));
  check('毕业后不再排队', grad.dueAt === 0, JSON.stringify(grad.dueAt));
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
