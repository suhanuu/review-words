// 用 node 跑：node tests/schedule.test.js
// 只测 assets/schedule.js 里的规则，不碰页面。
const S = require('../assets/schedule.js');

let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + '  => ' + got + (ok ? '' : '  (want ' + want + ')'));
}
const D = S.DAY, M = S.MIN;

// 一路答对：1/2/4/7/15/30/90/180 天，最后一档毕业
const chain = [];
let step = 0;
for (let i = 0; i < 11; i++) {
  const p = S.next(step, 3, false);
  chain.push(p.delay / D);
  step = p.step;
}
eq('答对 11 次的间隔(天)', chain.join(','), '1,1,1,2,4,7,15,30,90,180,0');
eq('毕业后的 step', step, 11);
eq('毕业 delay', S.delayFor(11), 0);

// 学习期：忘了清零、模糊清零
eq('忘了：step 归零', S.next(2, 1).step, 0);
eq('忘了：15 分钟', S.next(2, 1).delay, 15 * M);
eq('模糊：学习期退到 0', S.next(2, 2).step, 0);
eq('模糊：学习期 20 分钟', S.next(2, 2).delay, 20 * M);

// 复习期：模糊退一档
eq('模糊：6→5', S.next(6, 2).step, 5);
eq('模糊：6→5 后 4 天', S.next(6, 2).delay, 4 * D);
eq('模糊：3→2（掉回学习期）', S.next(3, 2).step, 2);
eq('模糊：3→2 后 20 分钟', S.next(3, 2).delay, 20 * M);

// 复习期：忘了回第 0 档
eq('忘了：6→0', S.next(6, 1).step, 0);

// 很熟的判定线
eq('step 2 不算很熟', S.isMastered(2), 'false');
eq('step 3 算很熟', S.isMastered(3), 'true');

// 老数据折算
eq('老数据 15 分钟 → 0', S.stepFromIv(15 * M), 0);
eq('老数据 1 天 → 3', S.stepFromIv(1 * D), 3);
eq('老数据 2.2 天 → 4', S.stepFromIv(2.2 * D), 4);
eq('老数据 15 天 → 7', S.stepFromIv(15 * D), 7);

console.log(fails ? '\n' + fails + ' 条不通过' : '\n全部通过');
process.exit(fails ? 1 : 0);
