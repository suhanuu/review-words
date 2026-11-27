// 端到端冒烟：备份导出与恢复（modules/pages/backup.js）
// 跑法：node tests/backup.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8140;
const CDP_PORT = 9240;
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

const profile = await mkdtemp(path.join(tmpdir(), 'rw-backup-e2e-'));
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

  await waitFor(() => cdp.eval('!!(window.__review && window.RWStore && document.getElementById("backupFile"))'));
  await sleep(400);

  // 1) 先塞一条能识别的数据
  await cdp.eval(`window.RWStore.set('reviewwords.articles.v1', [{ id: 'marker-before', title: '备份前', content: 'hello', translation: '你好', words: [] }])`);

  // 2) 导出：状态栏要提示导出了几项
  await cdp.eval(`document.getElementById('btnExportBackup').click()`);
  await sleep(600);
  const exported = await cdp.eval(`document.getElementById('backupStatus').textContent`);
  check('导出后有提示', /已导出 \d+ 项本地数据/.test(exported), exported);
  check('导出项数 > 0', Number((exported.match(/已导出 (\d+) 项/) || [])[1]) > 0, exported);

  // 3) 坏备份文件：不会触发重载，先测这个
  await cdp.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{"format":"wrong"}'], 'bad.json', { type: 'application/json' }));
    const input = document.getElementById('backupFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const badStatus = await waitFor(async () => {
    const text = await cdp.eval(`document.getElementById('backupStatus').textContent`);
    return /恢复失败/.test(text) ? text : null;
  }, 8000).catch(() => '');
  check('坏备份文件会给失败提示', /恢复失败/.test(badStatus), badStatus);
  check('坏文件不会影响已有数据',
    (await cdp.eval(`(JSON.parse(localStorage.getItem('reviewwords.articles.v1') || '[]')[0] || {}).id`)) === 'marker-before');

  // 4) 正常恢复：确认后覆盖数据，然后整页重载
  await cdp.eval(`window.confirm = function () { return true; }`);
  await cdp.eval(`(() => {
    const backup = {
      format: 'review-words-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: {
        'reviewwords.articles.v1': JSON.stringify([{ id: 'marker-after', title: '备份后', content: 'world', translation: '世界', words: [] }])
      }
    };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));
    const input = document.getElementById('backupFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => cdp.eval(`(() => {
    try {
      const list = JSON.parse(localStorage.getItem('reviewwords.articles.v1') || '[]');
      return list[0] && list[0].id === 'marker-after';
    } catch (e) { return false; }
  })()`), 15000);
  check('恢复后数据被覆盖成备份里的内容', true);
  check('恢复后页面重新起来了',
    (await waitFor(() => cdp.eval(`!!(window.__review && document.getElementById('view-today'))`), 15000)) === true);
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