# vendor

第三方代码原样放在这里，不做修改，升级时整文件替换。

## ts-fsrs 6.0.1（MIT）

- 文件：`ts-fsrs-6.0.1.umd.js`（192KB）、`ts-fsrs-6.0.1.LICENSE`
- 来源：https://registry.npmjs.org/ts-fsrs/-/ts-fsrs-6.0.1.tgz → `dist/index.umd.js`
- 用它的原因：间隔重复研究的开源实现，FSRS-6 权重是社区用几亿条复习记录拟合出来的，
  比手调 SM-2 的 EF 稳。
- 包一层：`assets/modules/core/scheduler.js`（固定 FSRS-6、封顶 365 天、关随机抖动）。

### 只放 UMD，别换入口

`dist/index.umd.js` 是自包含的，浏览器里 `<script>` 一引就有全局 `FSRS`，
Node 里 `require()` 也直接拿到导出对象。

同一个包里的 `dist/index.cjs` **不行**：它运行时会 `require('@open-spaced-repetition/srs-kit')`，
那是另一个 npm 包，直接丢进仓库会在浏览器里当场报错（Node 里则 MODULE_NOT_FOUND）。
`dist/index.mjs` 是 ESM，同样不适合无构建的页面。

### 用了什么、改了什么

- 只用同步接口 `new FSRS(参数)` + `fsrs.repeat(card, now)[Rating.X]`，
  不用 6.x 新增的异步 `DefaultScheduler`——页面是同步 IIFE，异步会把评分链路整条改掉。
- 参数：`request_retention 0.95`（考研要认得牢）、`maximum_interval 365`、`enable_fuzz false`、
  `learning_steps/relearning_steps ['15m']`、`w` 显式取库里的 `default_w`（就是 FSRS-6 那 21 个权重）。
- 库的默认 `maximum_interval` 是 36500 天（100 年），不设就会被排到几十年后。

### 验证方式

`node tests/scheduler.test.js` 里钉了两条曲线：

- 1 天稳定度的复习卡一路点“熟悉”：3 → 7 → 18 → 40 → 84 → 165 天（95% 保持率）；
- 一直点下去也不会出现超过 365 天的间隔。

换版本时这两条会因为权重变化而失败——那是提醒你重新确认行为，不是测试写错了。
