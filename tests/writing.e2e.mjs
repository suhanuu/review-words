// 端到端冒烟：作文训练 + 薄弱词页（modules/pages/writing.js）
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-writing"))'));

  // 造两个薄弱词：一个「忘了」、一个「模糊」，都记在昨天，方便按日期查看
  await cdp.eval(`(() => {
    const book = window.RWStore.getText(window.RWStore.KEYS.activeBook) || 'redbook-2024';
    const key = Object.keys(localStorage).find(k => k.indexOf('wordtype.v1:book:') === 0);
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    db.records = db.records || {};
    const yesterday = Date.now() - 86400000;
    db.records['console'] = Object.assign({}, db.records['console'], { seen: 2, last: 1, forgot: 1, lastAt: yesterday });
    db.records['consist'] = Object.assign({}, db.records['consist'], { seen: 2, last: 2, forgot: 0, lastAt: yesterday });
    db.whBackfilled = 0;
    localStorage.setItem(key, JSON.stringify(db));
    return true;
  })()`);
  await cdp.eval(`location.reload()`);
  await waitFor(() => cdp.eval('!!(window.__review && document.getElementById("view-today"))'), 15000);
  await sleep(500);

  // 1) 作文页卡片：已选数、词片不带「忘了 / 模糊」小字
  await cdp.eval(`document.querySelector('.nav-btn[data-view="writing"]').click()`);
  await sleep(500);
  const card = await cdp.eval(`(() => {
    const list = document.getElementById('weakWordList');
    const count = document.getElementById('weakPoolCount');
    return {
      count: (count || {}).textContent || '',
      countHidden: !!(count && count.hidden),
      listHidden: !!(list && list.hidden),
      chips: list ? Array.from(list.querySelectorAll('.weak-word-chip')).map(n => n.textContent) : []
    };
  })()`);
  check('没选词时不显示已选数量', card.count === '' && card.countHidden === true, JSON.stringify(card));
  check('没选词时不显示词片', card.chips.length === 0 && card.listHidden === true, JSON.stringify(card));

  // 2) 点「查看」：进薄弱词页，看的是今天（今天没有记录，所以是空状态）
  await cdp.eval(`document.getElementById('btnOpenWeakPicker').click()`);
  await sleep(500);
  check('进到薄弱词页', await cdp.eval(`document.getElementById('view-weak-words').classList.contains('is-active')`));
  check('日历是 7 列（7 个星期标题）',
    (await cdp.eval(`document.querySelectorAll('#weakCal .weak-cal-w').length`)) === 7);
  check('今天空状态', await cdp.eval(`document.getElementById('weakEmpty').hidden === false`));

  // 3.5) 塞满一天的词，验证桌面端这一页能自己上下滚
  const longDay = await cdp.eval(`(() => {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const dayNum = Math.max(1, d.getDate() - 2);
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(dayNum);
    const book = window.RWStore.getText(window.RWStore.KEYS.activeBook) || 'redbook-2024';
    const list = (window.WORD_BANK || []).slice(0, 24);
    list.forEach((w, i) => window.RWWeakHistory.add(book, w.w, i % 2 ? 2 : 1, new Date(key + 'T10:00:00').getTime()));
    const btn = document.querySelector('#weakCal [data-day="' + key + '"]');
    if (btn) btn.click();
    return key;
  })()`);
  await sleep(500);
  const scroll = await cdp.eval(`(() => {
    const page = document.querySelector('#view-weak-words .page');
    const cs = getComputedStyle(page);
    return {
      overflowY: cs.overflowY,
      scrollH: page.scrollHeight,
      clientH: page.clientHeight,
      rows: document.querySelectorAll('#weakList .weak-row').length
    };
  })()`);
  check('词表很长（24 个词）', scroll.rows === 24, JSON.stringify(scroll.rows));
  check('页面自己可以上下滚', scroll.overflowY === 'auto', scroll.overflowY);
  check('内容比视口高，确实需要滚', scroll.scrollH > scroll.clientH + 20, scroll.scrollH + ' / ' + scroll.clientH);

  // 3.6) 日历可以收起
  await cdp.eval(`document.getElementById('btnWeakCalToggle').click()`);
  await sleep(300);
  check('收起后日历隐藏', await cdp.eval(`document.getElementById('weakCal').hidden === true`));
  check('按钮变「展开」', (await cdp.eval(`document.getElementById('btnWeakCalToggle').textContent`)) === '展开');
  check('收起后词表还在', (await cdp.eval(`document.querySelectorAll('#weakList .weak-row').length`)) === 24);
  await cdp.eval(`document.getElementById('btnWeakCalToggle').click()`);
  await sleep(300);
  check('再点一次日历回来', await cdp.eval(`document.getElementById('weakCal').hidden === false`));

  // 3) 点昨天：昨天有两个薄弱词
  const yesterday = await cdp.eval(`(() => {
    const d = new Date(Date.now() - 86400000);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  })()`);
  // 如果昨天在别的月份（比如月初），先把月份切过去
  const months = await cdp.eval(`(() => {
    const label = document.getElementById('weakMonthLabel').textContent;
    const d = new Date(Date.now() - 86400000);
    return JSON.stringify({ shown: label, wantDay:${JSON.stringify(yesterday)}, wantMonth: (d.getMonth() + 1) + ' 月' });
  })()`);
  const mm = JSON.parse(months);
  if (!mm.shown.includes(mm.wantMonth.replace(' 月', ''))) {
    await cdp.eval(`document.getElementById('btnWeakMonthPrev').click()`);
    await sleep(300);
  }
  await cdp.eval(`(() => {
    const btn = document.querySelector('#weakCal [data-day="' + ${JSON.stringify(yesterday)} + '"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);
  const dayView = await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('#weakList .weak-row'));
    return {
      n: rows.length,
      words: rows.map(r => r.querySelector('.weak-row-word').textContent),
      title: document.getElementById('weakDayTitle').textContent,
      hasCountBadge: rows.some(r => /×\d/.test(r.textContent)),
      hasTag: rows.some(r => /忘了|模糊/.test(r.textContent))
    };
  })()`);
  check('昨天的词表有 2 个词', dayView.n === 2, JSON.stringify(dayView.words));
  check('词表里有 console 和 consist', dayView.words.indexOf('console') >= 0 && dayView.words.indexOf('consist') >= 0, JSON.stringify(dayView.words));
  check('标题是昨天', /\d+ 月 \d+ 日 周/.test(dayView.title), dayView.title);
  check('词后面不带 ×N', dayView.hasCountBadge === false);
  check('词后面不带「忘了/模糊」', dayView.hasTag === false);

  // 4) 选词模式：回到作文页点「选词」，勾选这天全部，确认
  await cdp.eval(`document.getElementById('btnWeakBack').click()`);
  await sleep(400);
  check('返回作文页', await cdp.eval(`document.getElementById('view-writing').classList.contains('is-active')`));
  await cdp.eval(`document.getElementById('btnOpenWeakPick').click()`);
  await sleep(500);
  check('进选词模式（底部条出现）', await cdp.eval(`document.getElementById('weakPickerBar').hidden === false`));
  check('行前出现勾选框', (await cdp.eval(`document.querySelectorAll('#weakList .weak-row-box').length`)) === 2);
  await cdp.eval(`document.getElementById('btnWeakPickAll').click()`);
  await sleep(300);
  check('全选这天后计数是 2', (await cdp.eval(`document.getElementById('weakPickerCount').textContent`)) === '已选 2 个',
    await cdp.eval(`document.getElementById('weakPickerCount').textContent`));
  await cdp.eval(`document.getElementById('btnWeakConfirm').click()`);
  await sleep(500);
  check('确认后回到作文页', await cdp.eval(`document.getElementById('view-writing').classList.contains('is-active')`));
  check('选择已落库', await cdp.eval(`(() => {
    const m = JSON.parse(localStorage.getItem('reviewwords.weakSelection.v1') || '{}');
    const book = Object.keys(m)[0];
    return Array.isArray(m[book]) && m[book].length === 2;
  })()`));
  const cardAfter = await cdp.eval(`(() => {
    const list = document.getElementById('weakWordList');
    const count = document.getElementById('weakPoolCount');
    return {
      count: (count || {}).textContent || '',
      listHidden: !!(list && list.hidden),
      chips: list ? Array.from(list.querySelectorAll('.weak-word-chip')).map(n => n.textContent) : []
    };
  })()`);
  check('选完词之后才显示词片', cardAfter.chips.length === 2 && cardAfter.listHidden === false, JSON.stringify(cardAfter));
  check('选完词之后显示已选数量', /^已选 2 \/ \d+ 个$/.test(cardAfter.count), cardAfter.count);
  check('确认后的提示是真实条数', /已选 2 个目标词/.test(await cdp.eval(`document.getElementById('rwToast').textContent`)),
    await cdp.eval(`document.getElementById('rwToast').textContent`));

  // 再进一次选词：上次的词要被标出来，而不是「已选 2 个却看不见」
  await cdp.eval(`document.getElementById('btnOpenWeakPick').click()`);
  await sleep(600);
  const again = await cdp.eval(`(() => ({
    count: document.getElementById('weakPickerCount').textContent,
    rows: document.querySelectorAll('#weakList .weak-row').length,
    marked: document.querySelectorAll('#weakCal .weak-cal-day.has-pick').length,
    checkedBoxes: document.querySelectorAll('#weakList .weak-row-box.is-on').length
  }))()`);
  check('再进选词时已选数还在', again.count === '已选 2 个', JSON.stringify(again));
  check('自动落在有已选词的那天（能看到 2 行）', again.rows === 2, JSON.stringify(again));
  check('日历上给有已选词的日子做了标记', again.marked >= 1, JSON.stringify(again));
  check('那天的词是勾着的', again.checkedBoxes === 2, JSON.stringify(again));

  // 清空重选
  await cdp.eval(`document.getElementById('btnWeakClear').click()`);
  await sleep(400);
  const cleared = await cdp.eval(`(() => ({
    count: document.getElementById('weakPickerCount').textContent,
    checkedBoxes: document.querySelectorAll('#weakList .weak-row-box.is-on').length,
    marked: document.querySelectorAll('#weakCal .weak-cal-day.has-pick').length
  }))()`);
  check('清空后已选 0 个', cleared.count === '已选 0 个', JSON.stringify(cleared));
  check('清空后勾选框全部取消', cleared.checkedBoxes === 0, JSON.stringify(cleared));
  check('清空后日历标记也消失', cleared.marked === 0, JSON.stringify(cleared));
  await cdp.eval(`document.getElementById('btnWeakCancel').click()`);
  await sleep(400);
  check('取消不影响已保存的选择', (await cdp.eval(`document.querySelectorAll('#weakWordList .weak-word-chip').length`)) === 2);

  // 5) 文章历史：空状态能打开、能返回
  await cdp.eval(`document.getElementById('btnShowHistory').click()`);
  await sleep(500);
  check('打开文章历史页', await cdp.eval(`document.getElementById('view-article-history').classList.contains('is-active')`));
  await cdp.eval(`document.getElementById('btnHistoryBack').click()`);
  await sleep(400);
  check('从历史页返回作文页', await cdp.eval(`document.getElementById('view-writing').classList.contains('is-active')`));

  // 6) 没有配 AI 时手动粘贴文章也能练
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
