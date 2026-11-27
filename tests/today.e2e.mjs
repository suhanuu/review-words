// 每日学习/复习两入口的端到端冒烟：node tests/today.e2e.mjs
// 验证：打开落在「今天」、点开始学习能进背词、轮三遍攒满 3 次进复习池、
//       收尾卡文案、以及跨天批次清零。
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8190;
const CDP_PORT = 9370;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

async function waitFor(label, fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
    await sleep(200);
  }
}

class CDP {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws 连不上')); });
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const profile = await mkdtemp(path.join(tmpdir(), 'rw-today-'));
let server, browser, cdp;
try {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor('静态服务', async () => (await request(`http://127.0.0.1:${PORT}/`)).status === 200, 10000);

  browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  await waitFor('调试口', async () => (await request(`http://127.0.0.1:${CDP_PORT}/json/version`)).status === 200, 20000);

  const list = JSON.parse((await request(`http://127.0.0.1:${CDP_PORT}/json/list`)).body);
  const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor('app 启动', () => cdp.eval('!!(window.__review && document.getElementById("view-today"))'));

  // 1) 打开就落在「今天」
  check('开局是今天页', await cdp.eval('document.getElementById("view-today").classList.contains("is-active")'));
  const learnBig = await cdp.eval('document.getElementById("todayLearnBig").textContent');
  const chip0 = await cdp.eval('document.getElementById("todayLearnChip").textContent');
  check('学习卡显示已学习 0 / 10', /已学习 0 \/ 10/.test(chip0), chip0);
  check('大数字是「10 个到目标」', /10/.test(learnBig), learnBig);

  // 2) 点开始学习
  await cdp.eval('document.getElementById("btnStartLearn").click()');
  await sleep(400);
  check('进到背词页', await cdp.eval('document.getElementById("view-drill").classList.contains("is-active")'));
  check('顶栏是学习进度', /学习 /.test(await cdp.eval('document.getElementById("drillIndex").textContent')),
    await cdp.eval('document.getElementById("drillIndex").textContent'));

  // 3) 一直点熟悉：点过一遍的词当天就不再出现，一轮 10 个走完就进收尾
  const wordOf = () => cdp.eval('document.getElementById("wordText").textContent');
  let seen = [];
  for (let i = 0; i < 80; i++) {
    const done = await cdp.eval('document.getElementById("view-done").classList.contains("is-active")');
    if (done) break;
    const w = await wordOf();
    if (w && seen.indexOf(w) < 0) seen.push(w);
    await cdp.eval('document.querySelector(\'.rate[data-grade="3"]\').click()');
    await sleep(120);
    await cdp.eval('document.getElementById("btnMeaningNext").click()');
    await sleep(140);
  }
  check('轮完进收尾页', await cdp.eval('document.getElementById("view-done").classList.contains("is-active")'));
  const title = await cdp.eval('document.getElementById("doneTitle").textContent');
  check('收尾卡说 10 个都过了一遍', /10 个今天都过了一遍/.test(title), title);
  check('这一轮只出现了 10 个词（没有重复轮）', seen.length === 10, JSON.stringify(seen.length));

  // 4) 数据层：10 个词今天都点过熟悉（但都还没攒满 3 次，所以没进复习池）
  const stats = await cdp.eval(`(() => {
    const s = window.__review.batchStats();
    const pool = window.__review.reviewPool(Date.now()).length;
    const recs = window.__review.records();
    const steps = Object.keys(recs).filter(k => recs[k].learnedOn).map(k => recs[k].step);
    return JSON.stringify({ total: s.total, done: s.done, due: pool, steps: steps });
  })()`);
  const st = JSON.parse(stats);
  check('今天批次 10 个都完成', st.total === 10 && st.done === 10, stats);
  check('这 10 个词都是 step 1（跨天累计，不是当天刷满）', st.steps.length === 10 && st.steps.every((x) => x === 1), JSON.stringify(st.steps));
  check('还没进复习池', st.due === 0, String(st.due));

  // 5) 回今天，学习卡变完成态
  await cdp.eval('document.getElementById("btnDoneToday").click()');
  await sleep(400);
  const todayBig = await cdp.eval('document.getElementById("todayLearnBig").textContent');
  check('今天页显示今日已完成', /已完成/.test(todayBig), todayBig);
  const learnBtn = await cdp.eval('document.getElementById("btnStartLearn").textContent');
  check('学习按钮变「继续学习」', /继续学习/.test(learnBtn), learnBtn);

  // 5.5) 学习设置：把目标改成 30，卡片立刻变 10 / 30
  await cdp.eval('document.getElementById("btnTodaySettings").click()');
  await sleep(250);
  await cdp.eval('(() => { const i = document.getElementById("goalInput"); i.value = "30"; })()');
  await cdp.eval('document.getElementById("btnGoalSave").click()');
  await sleep(300);
  const chip30 = await cdp.eval('document.getElementById("todayLearnChip").textContent');
  check('学习目标改成 30 → 已学习 10 / 30', /已学习 10 \/ 30/.test(chip30), chip30);
  const big30 = await cdp.eval('document.getElementById("todayLearnBig").textContent');
  check('大数字变「20 个到目标」', /20/.test(big30), big30);

  // 6) 跨天：昨天的批次标记清掉、第二天能再过一遍，但进度（step）要保留
  const reset = await cdp.eval(`(() => {
    const recs = window.__review.records();
    const words = Object.keys(recs).slice(0, 3);
    words.forEach(w => {
      recs[w].masteredAt = 0;
      recs[w].step = 2;
      recs[w].batch = '2020-01-01';
      recs[w].learnedOn = '2020-01-01';
    });
    window.__review.resetStaleBatch();
    return JSON.stringify(words.map(w => ({ w, step: recs[w].step, batch: recs[w].batch, learnedOn: recs[w].learnedOn })));
  })()`);
  const rs = JSON.parse(reset);
  check('跨天清掉批次标记', rs.length === 3 && rs.every((x) => x.batch === '' && x.learnedOn === ''), reset);
  check('跨天保留熟悉次数', rs.every((x) => x.step === 2), reset);

  // 7) 复习入口：塞 5 个「以前学过、今天到期」的词（不能是今天批次里的）
  await cdp.eval(`(() => {
    const recs = window.__review.records();
    const inBatch = new Set(window.__review.todayBatch().map(w => w.w));
    const bank = (window.WORD_BANK || []).map(w => w.w).filter(w => !inBatch.has(w) && !recs[w]).slice(0, 5);
    bank.forEach(w => {
      recs[w] = {
        seen: 3, step: 3, iv: 86400000,
        masteredAt: Date.now() - 3 * 86400000,
        dueAt: Date.now() - 3600000,
        last: 1, lastAt: Date.now() - 3 * 86400000,
        forgot: 0, wrong: 0, done: 0, batch: ''
      };
    });
    return bank.length;
  })()`);
  await cdp.eval('document.querySelector(\'.nav-btn[data-view="today"]\').click()');
  await sleep(400);
  const reviewNote0 = await cdp.eval('document.getElementById("todayReviewNote").textContent');
  check('复习卡显示 5 个到期', /5 个到期/.test(reviewNote0), reviewNote0);
  check('复习按钮带上待复习数', /5 个/.test(await cdp.eval('document.getElementById("btnStartReview").textContent')),
    await cdp.eval('document.getElementById("btnStartReview").textContent'));

  await cdp.eval('document.getElementById("btnStartReview").click()');
  await sleep(400);
  check('进到复习', await cdp.eval('document.getElementById("view-drill").classList.contains("is-active")'));
  check('顶栏是复习', /复习/.test(await cdp.eval('document.getElementById("drillIndex").textContent')),
    await cdp.eval('document.getElementById("drillIndex").textContent'));

  const doneBeforeReview = await cdp.eval('window.__review.todayDone()');
  const bookId = await cdp.eval('window.RWStore.getText(window.RWStore.KEYS.activeBook) || "redbook-2024"');
  const logBeforeReview = await cdp.eval('window.RWLog.dayStats(' + JSON.stringify(bookId) + ', window.RWLog.dayOf()).count');
  // 第一个词点「忘了」：会不会掉回学习池？
  const firstReviewWord = await cdp.eval('document.getElementById("wordText").textContent');
  await cdp.eval('document.querySelector(\'.rate[data-grade="1"]\').click()');
  await sleep(200);
  const stillReview = await cdp.eval(`(() => {
    const r = window.__review.records()[${JSON.stringify(firstReviewWord)}];
    const inBatch = window.__review.todayBatch().some(w => w.w === ${JSON.stringify(firstReviewWord)});
    return JSON.stringify({ step: r.step, masteredAt: r.masteredAt > 0, inBatch });
  })()`);
  const sr = JSON.parse(stillReview);
  check('复习里忘了 → 掉档但仍在复习池', sr.step === 0 && sr.masteredAt === true && sr.inBatch === false, stillReview);

  for (let i = 0; i < 30; i++) {
    const done = await cdp.eval('document.getElementById("view-done").classList.contains("is-active")');
    if (done) break;
    await cdp.eval('document.querySelector(\'.rate[data-grade="3"]\').click()');
    await sleep(100);
    await cdp.eval('document.getElementById("btnMeaningNext").click()');
    await sleep(120);
  }
  check('复习清完进收尾页', await cdp.eval('document.getElementById("view-done").classList.contains("is-active")'));
  const rt = await cdp.eval('document.getElementById("doneKicker").textContent');
  check('收尾卡说复习清完了', /复习清完/.test(rt), rt);

  const doneAfterReview = await cdp.eval('window.__review.todayDone()');
  check('复习过的也计入今日单词（+5）', doneAfterReview === doneBeforeReview + 5,
    doneBeforeReview + ' -> ' + doneAfterReview);

  // 今天页复习卡上要能看到「已复习 N 词」
  await cdp.eval('document.getElementById("btnDoneToday").click()');
  await sleep(400);
  const reviewChipAfter = await cdp.eval('document.getElementById("todayReviewChip").textContent');
  check('复习卡显示已复习 5 / 10', /已复习 5 \/ 10/.test(reviewChipAfter), reviewChipAfter);
  const reviewNoteAfter = await cdp.eval('document.getElementById("todayReviewNote").textContent');
  check('复习卡说明里有已复习词数', /已复习 5 词/.test(reviewNoteAfter), reviewNoteAfter);

  // 复习日志：这一轮 5 个词各评价 1 次，日志里就该有 5 条
  const logToday = await cdp.eval('window.RWLog.dayStats(' + JSON.stringify(bookId) + ', window.RWLog.dayOf()).count');
  check('复习日志多出 5 条', logToday === logBeforeReview + 5, logBeforeReview + ' -> ' + logToday);

  // 统计页要显示得出来
  await cdp.eval(`document.querySelector('.nav-btn[data-view="stats"]').click()`);
  await sleep(500);
  const logCards = await cdp.eval(`(() => {
    const g = (id) => (document.getElementById(id) || {}).textContent || '';
    return { today: g('revlogToday'), month: g('revlogMonth'), forgot: g('revlogForgot'), gap: g('revlogGap') };
  })()`);
  check('统计页今日评价 = 日志条数', logCards.today === String(logToday), JSON.stringify(logCards));
  check('统计页本月评价 ≥ 今日', Number(logCards.month) >= logToday, logCards.month);
  check('统计页显示忘了占比', /%$/.test(logCards.forgot), logCards.forgot);
  check('统计页显示平均间隔', /天$/.test(logCards.gap), logCards.gap);
} catch (e) {
  fails++;
  console.error('执行出错：', e.message);
} finally {
  try { cdp && cdp.ws.close(); } catch (e) {}
  try { browser && spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { server && server.kill(); } catch (e) {}
  setTimeout(() => process.exit(fails ? 1 : 0), 700);
}

console.log(fails ? `\n${fails} 项不通过` : '\n全部通过');
