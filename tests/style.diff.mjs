// 样式回归：对比「某个已提交版本」和「当前工作区」在每个页面、亮暗主题、桌面/手机宽度下的
// 全部计算样式和盒子尺寸，逐个元素比对。拆样式表、挪规则、删“看起来没用”的选择器之后跑一遍，
// 没有任何差异才敢说“视觉零变化”。
//
// 跑法：node tests/style.diff.mjs                        （基线 = HEAD）
//       node tests/style.diff.mjs 9ce310f               （基线 = 指定的提交）
//       node tests/style.diff.mjs HEAD --allow-rule-changes
//           删规则、合并规则时用：规则序列允许不同，只看每个元素算出来的样式是否一致。
// 需要：python（起静态服务）、Edge（无头）、git（把基线检出到临时目录）
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_REF = process.argv[2] || 'HEAD';
const PORT_A = 8131, PORT_B = 8132, CDP_PORT = 9380;
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
    try { const v = await fn(); if (v) return v; } catch (e) { /* 重试 */ }
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
    // 连接断了就让所有等着的调用报错，而不是永远挂着
    this.ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('调试连接已关闭'));
      this.pending.clear();
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// ---------- 场景 ----------
// 每个场景：显示哪个视图（view-drill 另给一个“释义已揭晓”的状态），叠哪个弹层
const SCENES = [
  { view: 'today' }, { view: 'drill' }, { view: 'drill', reveal: true }, { view: 'done' },
  { view: 'writing' }, { view: 'typing' }, { view: 'article-history' }, { view: 'weak-words' },
  { view: 'books' }, { view: 'stats' }, { view: 'typing-history' }, { view: 'words' }, { view: 'favs' },
  { view: 'today', overlay: 'goal' }, { view: 'today', overlay: 'drawer' }, { view: 'words', overlay: 'detail' },
  { view: 'books', overlay: 'newbook' },
];
const SIZES = [[1280, 800], [390, 844]];
const THEMES = ['light', 'dark'];

const applyScene = (scene, theme) => `(() => {
  const s = ${JSON.stringify(scene)};
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + s.view));
  document.body.classList.toggle('is-typing-screen', s.view === 'typing');
  document.documentElement.classList.toggle('is-drill-locked', s.view === 'drill');
  document.body.classList.toggle('is-drill-locked', s.view === 'drill');
  const drill = document.querySelector('.drill');
  if (drill) {
    drill.classList.toggle('is-recall', s.view === 'drill' && !s.reveal);
    drill.classList.toggle('is-reveal', s.view === 'drill' && !!s.reveal);
  }
  const rateRow = document.getElementById('rateRow');
  if (rateRow) { rateRow.classList.toggle('show', !s.reveal); rateRow.classList.toggle('is-finished', !!s.reveal); }
  const on = k => s.overlay === k;
  document.getElementById('drawer').classList.toggle('open', on('drawer'));
  document.getElementById('drawerMask').classList.toggle('open', on('drawer'));
  document.getElementById('detailMask').classList.toggle('show', on('detail'));
  document.getElementById('detailSheet').classList.toggle('show', on('detail'));
  document.getElementById('goalPop').hidden = !on('goal');
  document.getElementById('newBookMask').classList.toggle('open', on('newbook'));
  const modal = document.getElementById('newBookModal');
  if (modal) modal.classList.toggle('open', on('newbook'));
  document.documentElement.dataset.theme = ${JSON.stringify(theme)};
})()`;

// 每个元素的记录：[标签, id, class, 盒子, 全部计算样式的值(按固定顺序拼成串), 伪元素 before, 伪元素 after]
// 一次只取一段元素（分块回传），整页一次回传的话消息太大会把调试连接撑断。
const U1 = '\u0001', U2 = '\u0002';
const snapshotPart = (start, size) => `(() => {
  const els = document.body.querySelectorAll('*');
  const box = el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(n => Math.round(n * 10)).join('${U1}'); };
  const pick = ['content', 'display', 'position', 'width', 'height', 'margin', 'padding', 'background-color', 'color', 'opacity', 'transform', 'border-color'];
  const pseudo = (el, which) => { const cs = getComputedStyle(el, which); if (cs.getPropertyValue('content') === 'none') return ''; return pick.map(p => cs.getPropertyValue(p)).join('${U1}'); };
  const out = [];
  const end = Math.min(els.length, ${start} + ${size});
  for (let i = ${start}; i < end; i++) {
    const el = els[i];
    const cs = getComputedStyle(el);
    const vals = [];
    for (let i2 = 0; i2 < cs.length; i2++) vals.push(cs.getPropertyValue(cs[i2]));
    out.push([el.tagName, el.id, typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '',
      box(el), vals.join('${U2}'), pseudo(el, '::before'), pseudo(el, '::after')]);
  }
  // 属性名只取一次（第一个元素的），用来把“第几个属性”翻译成人能看懂的名字
  const names = [];
  if (${start} === 0 && els.length) { const c0 = getComputedStyle(els[0]); for (let i3 = 0; i3 < c0.length; i3++) names.push(c0[i3]); }
  return { total: els.length, body: box(document.body), records: out, names };
})()`;

let profile, worktree, serverA, serverB, browser, cdp;
let fails = 0;
try {
  // 基线检出到临时目录
  const tmp = await mkdtemp(path.join(tmpdir(), 'rw-style-'));
  profile = path.join(tmp, 'profile');
  worktree = path.join(tmp, 'base');
  execFileSync('git', ['worktree', 'add', '--detach', worktree, BASE_REF], { cwd: ROOT, stdio: 'pipe' });

  serverA = spawn('python', ['-m', 'http.server', String(PORT_A), '--bind', '127.0.0.1'], { cwd: worktree, stdio: 'ignore' });
  serverB = spawn('python', ['-m', 'http.server', String(PORT_B), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor('基线静态服务', async () => (await request(`http://127.0.0.1:${PORT_A}/`)).status === 200, 10000);
  await waitFor('工作区静态服务', async () => (await request(`http://127.0.0.1:${PORT_B}/`)).status === 200, 10000);

  browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  await waitFor('调试口', async () => (await request(`http://127.0.0.1:${CDP_PORT}/json/version`)).status === 200, 20000);
  const list = JSON.parse((await request(`http://127.0.0.1:${CDP_PORT}/json/list`)).body);
  const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const load = async (port) => {
    // 两边必须在同一种设备模拟状态下加载。上一轮抓取结束时留下的是“手机宽度”，不清掉的话
    // 第二个页面会按手机加载：移动端的默认点击高亮色、顶栏排版都和按桌面加载的第一个不一样，
    // 报出来的差异和样式表本身无关。
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor('app 启动', () => cdp.eval('!!(window.__review && document.getElementById("view-today"))'));
    // 关掉过渡和动画，两个版本都停在最终状态；否则比对结果取决于抓取时机
    await cdp.eval(`(() => { const st = document.createElement('style'); st.id = '__noanim';
      st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.appendChild(st); return 1; })()`);
    await sleep(600);
    // 浏览器实际解析出来的顶层规则序列。样式表括号或注释没配平时，浏览器会把整条规则悄悄丢掉，
    // 这种问题在这里一眼就能看出来，比逐个元素比计算样式快得多，也不会漏掉没被场景盖到的规则。
    const rules = JSON.parse(await cdp.eval(`JSON.stringify([...document.styleSheets].flatMap(s => {
      try { return [...s.cssRules].map(r => r.cssText.replace(/\\s+/g, ' ')); } catch (e) { return ['<<读不到规则: ' + (s.href || 'inline') + '>>']; }
    }))`));
    return rules;
  };

  const CHUNK = 150;   // 每次回传多少个元素
  const grab = async (tag) => {
    const out = {};
    for (const [w, h] of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      for (const theme of THEMES) {
        const t0 = Date.now();
        for (const scene of SCENES) {
          await cdp.eval(applyScene(scene, theme));
          await sleep(60);
          const key = `${w}x${h} ${theme} ${scene.view}${scene.reveal ? '(揭晓)' : ''}${scene.overlay ? '+' + scene.overlay : ''}`;
          let start = 0, snap = { count: 0, body: '', all: [], names: [] };
          do {
            const part = await cdp.eval(snapshotPart(start, CHUNK));
            snap.count = part.total; snap.body = part.body; snap.names = part.names || snap.names;
            for (const r of part.records) snap.all.push(r);
            start += CHUNK;
          } while (start < snap.count);
          out[key] = snap;
        }
        console.log(`     [${tag}] ${w}x${h} ${theme}：${SCENES.length} 个场景，${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      }
    }
    return out;
  };

  const rulesA = await load(PORT_A);
  console.log('基线页面已加载，开始抓取…');
  const before = await grab('基线');
  const rulesB = await load(PORT_B);
  console.log('工作区页面已加载，开始抓取…');
  const after = await grab('工作区');

  // 先比规则序列：纯拆分、纯挪动时两边必须一模一样。只有明确加了 --allow-rule-changes（删规则、合并规则）时才放过。
  const ALLOW_RULE_CHANGES = process.argv.includes('--allow-rule-changes');
  {
    let k = 0;
    while (k < rulesA.length && k < rulesB.length && rulesA[k] === rulesB[k]) k++;
    if (k === rulesA.length && k === rulesB.length) {
      console.log(`规则序列：两边都是 ${rulesA.length} 条顶层规则，逐条相同`);
    } else {
      console.log(`规则序列：基线 ${rulesA.length} 条 / 工作区 ${rulesB.length} 条，从第 ${k + 1} 条开始不同`);
      for (let i = Math.max(0, k - 2); i < Math.min(rulesA.length, k + 4); i++) console.log('       基线   ' + (i + 1) + ': ' + String(rulesA[i]).slice(0, 130));
      for (let i = Math.max(0, k - 2); i < Math.min(rulesB.length, k + 4); i++) console.log('       工作区 ' + (i + 1) + ': ' + String(rulesB[i]).slice(0, 130));
      if (ALLOW_RULE_CHANGES) console.log('       （已指定 --allow-rule-changes，规则序列的差异不算失败，以计算样式比对为准）');
      else fails++;
    }
  }

  // 同一套页面的快照按“场景 → 元素序号 → 属性”逐项比
  const label = (el) => `${el[0].toLowerCase()}${el[1] ? '#' + el[1] : ''}${el[2] ? '.' + String(el[2]).trim().split(/\s+/).join('.') : ''}`;
  let scenes = 0, diffScenes = 0, total = 0;
  for (const key of Object.keys(before)) {
    scenes++;
    const a = before[key], b = after[key];
    const diffs = [];
    if (!b) { fails++; console.log(`FAIL ${key}：工作区里没有这个场景`); continue; }
    if (a.count !== b.count) diffs.push(`元素个数 基线 ${a.count} / 工作区 ${b.count}`);
    if (a.body !== b.body) diffs.push(`body 盒子 ${a.body.split(U1).join(',')} → ${b.body.split(U1).join(',')}`);
    const n = Math.min(a.count, b.count);
    for (let i = 0; i < n; i++) {
      const ea = a.all[i], eb = b.all[i];
      if (ea[0] !== eb[0] || ea[1] !== eb[1] || ea[2] !== eb[2]) { diffs.push(`#${i} 元素变了：${label(ea)} → ${label(eb)}`); continue; }
      if (ea[3] !== eb[3]) { diffs.push(`#${i} ${label(ea)} 盒子 ${ea[3].split(U1).join(',')} → ${eb[3].split(U1).join(',')}`); continue; }
      total++;
      if (ea[4] !== eb[4]) {
        const va = ea[4].split(U2), vb = eb[4].split(U2);
        for (let k = 0; k < Math.max(va.length, vb.length); k++) {
          // 属性名取自每个场景的第一个元素，自定义属性数量因元素而异，超出范围就只能报序号
          if (va[k] !== vb[k]) diffs.push(`#${i} ${label(ea)} ${k < a.names.length ? a.names[k] : '第 ' + k + ' 个属性'}: ${va[k]} → ${vb[k]}`);
        }
      }
      for (const k of [5, 6]) if (ea[k] !== eb[k]) diffs.push(`#${i} ${label(ea)} 伪元素${k === 5 ? '前' : '后'}: ${ea[k].split(U1).join('|')} → ${eb[k].split(U1).join('|')}`);
    }
    if (diffs.length) {
      diffScenes++; fails++;
      console.log(`FAIL ${key}：${diffs.length} 处差异（元素 ${a.count}）`);
      diffs.slice(0, 8).forEach((d) => console.log('       ' + d));
      if (diffs.length > 8) console.log('       …');
    } else {
      console.log(`ok   ${key}（${a.count} 个元素）`);
    }
  }
  console.log(`\n共 ${scenes} 个场景、${total} 个元素；有差异的场景 ${diffScenes} 个`);
  console.log(fails ? '存在差异' : '全部一致');
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('运行失败：' + (e.stack || e));
  process.exitCode = 2;
} finally {
  try { cdp && cdp.ws.close(); } catch (e) { /* 忽略 */ }
  try { browser && browser.kill(); } catch (e) { /* 忽略 */ }
  try { serverA && serverA.kill(); } catch (e) { /* 忽略 */ }
  try { serverB && serverB.kill(); } catch (e) { /* 忽略 */ }
  await sleep(300);
  if (worktree) { try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, stdio: 'pipe' }); } catch (e) { /* 忽略 */ } }
  if (profile) { try { await rm(path.dirname(profile), { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
}
