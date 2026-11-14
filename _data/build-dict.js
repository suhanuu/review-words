/* 词库（查词词典）构建脚本
 *
 * 数据来源：ECDICT（https://github.com/skywind3000/ECDICT，MIT 协议）
 *   - 原始文件 ~66MB，不进仓库；本地放在 _data/ecdict.csv，
 *     没有就从临时目录 %TEMP%\ecdict.csv 读（先手动下载一份）。
 *   - 下载地址：
 *     https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
 *
 * 收录范围（"从上学到考研"）：
 *   1) 考试大纲标签命中：中考 zk / 高考 gk / 四级 cet4 / 六级 cet6 / 考研 ky
 *   2) 牛津 3000 核心词（oxford=1）
 *   3) 现代语料高频词（bnc / frq 排名前 2 万）
 *   再去掉带空格、带数字的条目，以及不认识的人名地名和全大写缩写。
 *
 * 输出：assets/dict.js → window.WORD_DICT
 *   w  单词
 *   ph 美式音标（已转成 IPA 写法，带首尾斜杠）
 *   d  中文释义（多义项用「；」连接，去掉 [网络]/[医] 这类专科标签行）
 *   r  常用度排名（越小越常见；0 表示没有排名）——中文搜索排序用
 *   ex 词形变化（过去式/复数等，给「详细」用；没有就不写）
 *
 * 用法：node _data/build-dict.js
 */

const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  path.join(__dirname, 'ecdict.csv'),
  path.join(process.env.TEMP || '', 'ecdict.csv'),
  path.join(process.env.TMP || '', 'ecdict.csv')
];
const OUT = path.join(__dirname, '..', 'assets', 'dict.js');

const EXAM_TAGS = ['zk', 'gk', 'cet4', 'cet6', 'ky'];

/* ---------- CSV 解析（ECDICT 里字段带换行和引号，得按 RFC 4180 走） ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------- 音标：ECDICT 是老式 ASCII 写法，转成 IPA ---------- */
function toIpa(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^[\/\[]+/, '').replace(/[\/\]]+$/, '');
  // 有的条目用逗号并排多个读法，取第一个
  s = s.split(',')[0].trim();
  if (!s) return '';
  s = s
    .replace(/ә/g, 'ə')
    .replace(/:/g, 'ː')
    .replace(/'/g, 'ˈ')
    .replace(/,/g, 'ˌ')
    .replace(/\s+/g, ' ')
    .trim();
  return '/' + s + '/';
}

/* ---------- 释义：丢掉专科标签行，剩下的义项连起来 ---------- */
const TAG_LINE = /^\[[^\]]{1,8}\]/;

function cleanDef(raw) {
  const lines = String(raw || '')
    // ECDICT 的 CSV 里有两种换行：真换行，和字面量 \n / \r\n
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  const general = lines.filter(l => !TAG_LINE.test(l));
  const picked = (general.length ? general : lines).slice(0, 4)
    .map(l => l.replace(/\s+/g, ' '));
  let out = picked.join('；').replace(/；{2,}/g, '；').trim();
  if (out.length > 140) out = out.slice(0, 140) + '…';
  return out;
}

/* ---------- 词形变化：i:doing/d:did/p:done/s:does/3:does/r:doing/t:done ---------- */
const FORM_LABEL = { p: '过去式', d: '过去分词', i: '现在分词', 3: '第三人称单数', s: '复数', r: '比较级', t: '最高级' };

function cleanForms(raw) {
  const parts = String(raw || '').split('/').filter(Boolean);
  const out = [];
  for (const p of parts) {
    const at = p.indexOf(':');
    if (at <= 0) continue;
    const k = p.slice(0, at), v = p.slice(at + 1).trim();
    if (!FORM_LABEL[k] || !v) continue;
    out.push(FORM_LABEL[k] + ' ' + v);
    if (out.length >= 4) break;
  }
  return out.join('；');
}

/* ---------- 主流程 ---------- */
const src = CANDIDATES.find(p => p && fs.existsSync(p));
if (!src) {
  console.error('找不到 ecdict.csv，请先下载：');
  console.error('  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv');
  console.error('放到 _data/ecdict.csv 再重跑。');
  process.exit(1);
}

const rows = parseCSV(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
const head = rows[0].map(s => s.trim());
const col = {};
head.forEach((name, i) => { col[name] = i; });

const seen = new Set();
const list = [];
let dropWord = 0, dropDef = 0, dup = 0, dropName = 0;

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || r.length < 3) continue;

  const word = (r[col.word] || '').trim();
  if (!word) continue;
  if (!/^[A-Za-z][A-Za-z'’.\-]*$/.test(word) || word.length > 32) { dropWord++; continue; }

  const tags = String(r[col.tag] || '').split(/\s+/).filter(Boolean);
  const isExam = tags.some(t => EXAM_TAGS.indexOf(t) >= 0);
  const isOxford = String(r[col.oxford] || '') === '1';
  const bnc = parseInt(r[col.bnc] || '0', 10) || 0;
  const frq = parseInt(r[col.frq] || '0', 10) || 0;
  const isFreq = (bnc > 0 && bnc <= 20000) || (frq > 0 && frq <= 20000);
  if (!isExam && !isOxford && !isFreq) continue;

  const def = cleanDef(r[col.translation]);
  if (!def) { dropDef++; continue; }

  // 查词词典里不掺专有名词和全大写缩写（Ababa、AA 这类），除非它本身就是考试词
  if (!isExam && !isOxford && /人名|地名|姓氏/.test(def)) { dropName++; continue; }
  if (!isExam && /^[A-Z]{2,}$/.test(word)) { dropName++; continue; }

  const key = word.toLowerCase();
  if (seen.has(key)) { dup++; continue; }
  seen.add(key);

  const ranks = [bnc, frq].filter(n => n > 0);
  list.push({
    w: word,
    ph: toIpa(r[col.phonetic]),
    d: def,
    r: ranks.length ? Math.min.apply(null, ranks) : 0,
    ex: cleanForms(r[col.exchange])
  });
}

// 按字母序排：英文前缀搜索天然就是字母序，中文结果再按匹配位置 + 词频重排
list.sort((a, b) => (a.w.toLowerCase() < b.w.toLowerCase() ? -1 : a.w.toLowerCase() > b.w.toLowerCase() ? 1 : 0));

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const body = list.map(x => {
  let line = '  { w: "' + esc(x.w) + '", ph: "' + esc(x.ph) + '", d: "' + esc(x.d) + '", r: ' + x.r;
  if (x.ex) line += ', ex: "' + esc(x.ex) + '"';
  return line + ' }';
}).join(',\n');

const headText = '/* 词库 · 查词用词典（' + list.length + ' 词）\n' +
  ' * 由 _data/build-dict.js 从 ECDICT 生成，请勿手改。\n' +
  ' * 数据来源：ECDICT（https://github.com/skywind3000/ECDICT，MIT）\n' +
  ' * w 单词 / ph 音标 / d 中文释义 / r 常用度排名 / ex 词形变化\n' +
  ' */\nwindow.WORD_DICT = [\n';

fs.writeFileSync(OUT, headText + body + '\n];\n', 'utf8');

const size = fs.statSync(OUT).size;
const byLetter = {};
list.forEach(x => {
  const c = x.w[0].toUpperCase();
  byLetter[c] = (byLetter[c] || 0) + 1;
});

console.log('源文件:', src);
console.log('原始记录:', rows.length - 1);
console.log('收录:', list.length, '| 重复跳过:', dup, '| 词形不合格:', dropWord,
  '| 无释义:', dropDef, '| 专名/缩写:', dropName);
console.log('输出:', OUT, (size / 1048576).toFixed(2) + ' MB');
console.log('有音标:', list.filter(x => x.ph).length, '| 有词形变化:', list.filter(x => x.ex).length);
console.log('字母分布:', JSON.stringify(byLetter));
