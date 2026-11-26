// 用 node 跑：node tests/scheduler.test.js
// 只测 assets/modules/core/scheduler.js（学习期走 schedule.js、复习期走 ts-fsrs 6.0.1）。
const Sch = require('../assets/modules/core/scheduler.js');
const S = require('../assets/schedule.js');

const DAY = 86400000;
const MIN = 60000;
const NOW = new Date('2026-11-26T22:00:00+08:00').getTime();

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}
function near(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ~' + want + ' ±' + tol + ')'));
}

Sch.reset();

// ---------- 1. 学习期：完全沿用老规则 ----------
let rec = { step: 0, seen: 0 };
let out = Sch.grade(rec, 3, NOW);
eq('学习期 熟悉 → step 1', rec.step, 1);
eq('学习期 熟悉 → 明天见', rec.iv, DAY);
eq('学习期不算很熟', Sch.isMastered(rec), 'false');
eq('学习期走的是老规则', out.kind, 'learn');

rec = { step: 2, seen: 2 };
Sch.grade(rec, 1, NOW);
eq('学习期 忘了 → step 0', rec.step, 0);
eq('学习期 忘了 → 15 分钟', rec.iv, 15 * MIN);

// ---------- 2. 攒满 3 次那天：建 FSRS 卡，S = 1 天 ----------
// 注意顺序：评分时还只是「学习期 step 2」，app.js 在评分之后才补 masteredAt
rec = { step: 2, seen: 2, lastAt: NOW };
Sch.grade(rec, 3, NOW);
if (!rec.masteredAt) rec.masteredAt = NOW;   // app.js 的 applyGrade 会补这一步
eq('刚很熟 → step 3', rec.step, 3);
eq('刚很熟 → 建了 FSRS 卡', !!(rec.fsrs && rec.fsrs.sch === 6), 'true');
eq('刚很熟 → 稳定度 = 阶梯首档 1 天', rec.fsrs.s, 1);
eq('刚很熟 → 1 天后见', rec.iv, DAY);

// ---------- 3. 复习期：一路「熟悉」，间隔按 FSRS-6 放大 ----------
rec = { step: 3, seen: 3, masteredAt: NOW, lastAt: NOW, iv: DAY, dueAt: NOW + DAY };
Sch.migrate(rec, NOW);
const chain = [];
let t = NOW + DAY;
for (let i = 0; i < 6; i++) {
  rec.lastAt = t;
  Sch.grade(rec, 3, t);
  chain.push(Math.round(rec.iv / DAY));
  t = rec.dueAt;
}
// FSRS-6 在 S=1 天、难度 ~2.1 的复习卡上点「熟悉」，给的间隔比老的 1/2/4/7 阶梯激进：\n// 1 天 → 6 天 → 27 天 → 102 天 → 328 天 →（封顶）365 天\n eq('一路熟悉的天数序列', chain.join(','), '6,27,102,328,365,365');
eq('全都封在 365 天以内', Math.max.apply(null, chain) <= 365, 'true');
eq('复习期用的是 FSRS 卡片', rec.fsrs.sch, 6);

// ---------- 4. 复习期「忘了」：15 分钟回来，不取消很熟 ----------
rec = { step: 6, seen: 6, masteredAt: NOW - 30 * DAY, lastAt: NOW, iv: 7 * DAY, dueAt: NOW };
Sch.migrate(rec, NOW);
Sch.grade(rec, 1, NOW);
near('复习期 忘了 → 15 分钟', Math.round(rec.iv / MIN), 15, 1);
eq('复习期 忘了 → step 镜像回 0', rec.step, 0);
eq('复习期 忘了 → 仍然算很熟', Sch.isMastered(rec), 'true');
eq('复习期 忘了 → 不会毕业', rec.done, 0);

rec.lastAt = NOW;
Sch.grade(rec, 3, NOW + 15 * MIN);
eq('忘了之后回来点熟悉 → 重新排期', rec.iv > 15 * MIN, 'true');

// ---------- 5. 不再有毕业 ----------
rec = { step: 10, seen: 20, masteredAt: NOW - 400 * DAY, lastAt: NOW, iv: 180 * DAY, dueAt: NOW };
Sch.migrate(rec, NOW);
for (let i = 0; i < 8; i++) {
  rec.lastAt = NOW;
  rec.dueAt = NOW;
  Sch.grade(rec, 3, NOW);
}
eq('连续熟悉很多次也不毕业', rec.done, 0);
eq('step 镜像封在毕业前一档', rec.step, S.DONE - 1);
near('间隔仍在 365 天内', Math.round(rec.iv / DAY) <= 365, true, 0);

// ---------- 6. 旧进度迁移 ----------
function legacy(step, days) {
  return { step: step, seen: step, lastAt: NOW - days * DAY, iv: days * DAY, dueAt: NOW - days * DAY + days * DAY, masteredAt: NOW - days * DAY };
}
const m3 = legacy(3, 1);
eq('迁移 step 3 有改动', Sch.migrate(m3, NOW), 'true');
eq('迁移 step 3 → 稳定度 1 天', m3.fsrs.s, 1);
near('迁移不改到期时间', m3.dueAt, NOW, 1);
const m5 = legacy(5, 4);
Sch.migrate(m5, NOW);
eq('迁移 step 5 → 稳定度 4 天', m5.fsrs.s, 4);
const m10 = legacy(10, 180);
Sch.migrate(m10, NOW);
eq('迁移 step 10 → 稳定度 180 天', m10.fsrs.s, 180);

// 幂等：再跑一遍，稳定度不能被折算第二次
const before = m5.fsrs.s;
eq('重复迁移没有改动', Sch.migrate(m5, NOW), 'false');
eq('重复迁移稳定度不变', m5.fsrs.s, before);

// 学习期的词不建卡
const learn = { step: 1, seen: 1 };
eq('学习期词不建卡', Sch.migrate(learn, NOW), 'false');
eq('学习期词没有 fsrs 字段', learn.fsrs, 'undefined');

// 老毕业数据：保持不再出现
const grad = { step: 11, seen: 11, done: 1, masteredAt: NOW - 500 * DAY, dueAt: 0 };
eq('老毕业数据不建卡', Sch.migrate(grad, NOW), 'false');
eq('老毕业数据仍是 done', grad.done, 1);

// ---------- 7. 超长到期时间收回 365 天 ----------
const far = { step: 10, seen: 10, masteredAt: NOW - 10 * DAY, lastAt: NOW - 10 * DAY, iv: 900 * DAY, dueAt: NOW + 900 * DAY };
Sch.migrate(far, NOW);
near('迁移把 900 天收回 365 天', Math.round((far.dueAt - NOW) / DAY), 365, 1);

console.log(fails ? '\n有 ' + fails + ' 项没过' : '\n全部通过');
process.exit(fails ? 1 : 0);
