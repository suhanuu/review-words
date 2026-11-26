const fs = require('fs');

const SRC = '_data/红宝书源.csv';
const IPA = '_data/en_US.txt';
const OUT = 'assets/words.js';

/* ---------- CSV 解析 ---------- */
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

/* ---------- 音标库 ---------- */
const ipaMap = new Map();
fs.readFileSync(IPA, 'utf8').split('\n').forEach(line => {
  const t = line.indexOf('\t');
  if (t < 0) return;
  const k = line.slice(0, t).trim().toLowerCase();
  const v = line.slice(t + 1).trim();
  if (!k || !v) return;
  if (!ipaMap.has(k)) ipaMap.set(k, v.split(/,\s*/)[0].trim());
});

/* ---------- 释义规范化 ---------- */
// 英式拼写回退：organise → organize 等，音标库只有美式
function lookupIpa(key) {
  const hit = ipaMap.get(key) || ipaMap.get(key.split(' ')[0]);
  if (hit) return hit;
  const tries = [
    key.replace(/isation$/, 'ization'),
    key.replace(/ise$/, 'ize'),
    key.replace(/ised$/, 'ized'),
    key.replace(/ising$/, 'izing'),
    key.replace(/iser$/, 'izer'),
    key.replace(/yse$/, 'yze'),
    key.replace(/ysed$/, 'yzed'),
    key.replace(/ysing$/, 'yzing'),
    key.replace(/our$/, 'or'),
    key.replace(/ogue$/, 'og'),
    key.replace(/re$/, 'er')
  ];
  for (const t of tries) {
    if (t !== key && ipaMap.has(t)) return ipaMap.get(t);
  }
  return '';
}

const POS_HEAD = /(?:^|[\s；;，,])((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|aux|abbr)\.)\s*/gi;
const POS_NEXT = /(?:^|[\s；;，,])(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|aux|abbr)\.\s*/i;

function cleanDef(raw) {
  return String(raw)
    .replace(/\r/g, '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join('；')
    .replace(/；{2,}/g, '；')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 释义按词性分组，取各组第一个义项，挑最短且不残缺的作为要敲的答案
function pickAnswer(def) {
  const marks = [];
  const re = /(?:^|[\s；;，,])((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|aux|abbr)\.)\s*/gi;
  let m;
  while ((m = re.exec(def)) !== null) marks.push({ at: m.index, end: re.lastIndex });

  const groups = [];
  if (!marks.length) {
    groups.push(def);
  } else {
    for (let i = 0; i < marks.length; i++) {
      const from = marks[i].end;
      const to = i + 1 < marks.length ? marks[i + 1].at : def.length;
      const g = def.slice(from, to).trim();
      if (g) groups.push(g);
    }
  }
  if (!groups.length) groups.push(def);

  const clean = s => s
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^\u4e00-\u9fa5]/g, '')
    .trim();

  // 每个词性组的第一义项
  const heads = [];
  groups.slice(0, 4).forEach(g => {
    const first = g.split(/[；;、，,\/]/).map(clean).filter(s => s.length >= 1)[0];
    if (first) heads.push(first);
  });
  if (!heads.length) return '';

  const fit = heads.filter(s => s.length <= 8);
  if (fit.length) return fit.reduce((a, b) => (b.length < a.length ? b : a));
  return heads[0].slice(0, 8);
}

/* ---------- 主流程 ---------- */
const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const rows = parseCSV(raw);

const seen = new Set();
const list = [];
let dropWord = 0, dropDef = 0, dropAns = 0, noIpa = 0, dup = 0;

for (const r of rows) {
  if (!r || !r.length) continue;
  const w = (r[0] || '').trim();
  const defRaw = r.slice(1).join(',').trim();
  if (!w) continue;

  if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]*$/.test(w) || w.length > 32) { dropWord++; continue; }
  if (!defRaw) { dropDef++; continue; }

  const key = w.toLowerCase();
  if (seen.has(key)) { dup++; continue; }

  const def = cleanDef(defRaw);
  const a = pickAnswer(def);
  if (!a) { dropAns++; continue; }

  seen.add(key);
  const ph = lookupIpa(key);
  if (!ph) noIpa++;
  list.push({ w, ph, def, a });
}

// 保留词书原始顺序（按词根/派生分组，比字母序更有记忆价值）

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const body = list.map(x =>
  '  { w: "' + esc(x.w) + '", ph: "' + esc(x.ph) + '", def: "' + esc(x.def) + '", a: "' + esc(x.a) + '" }'
).join(',\n');

const head = '/* 2024 考研英语词汇 · 红宝书（' + list.length + ' 词）\n' +
  ' * 来源：用户提供的 CSV（两列：单词 / 释义）；音标按美式 IPA 词典对齐\n' +
  ' * w 单词 / ph 美式音标 / def 完整释义 / a 打字需要敲出的中文\n' +
  ' */\nwindow.WORD_BANK = [\n';

fs.writeFileSync(OUT, head + body + '\n];\n', 'utf8');

/* ---------- 报告 ---------- */
console.log('原始记录:', rows.length);
console.log('入库:', list.length, '| 重复跳过:', dup, '| 词形异常:', dropWord,
  '| 空释义:', dropDef, '| 答案提取失败:', dropAns, '| 无音标:', noIpa);
const lens = {};
list.forEach(x => { lens[x.a.length] = (lens[x.a.length] || 0) + 1; });
console.log('答案长度分布:', JSON.stringify(lens));
console.log('平均答案字数:', (list.reduce((s, x) => s + x.a.length, 0) / list.length).toFixed(2));
console.log('音标覆盖率:', ((list.length - noIpa) / list.length * 100).toFixed(1) + '%');
