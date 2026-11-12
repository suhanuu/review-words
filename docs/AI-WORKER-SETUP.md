# Review Words · GitHub Pages + AI Worker

## 1. 发布静态网站
1. 解压项目，把 ZIP 内 `index.html`、`assets/`、`_data/`、`docs/`、`worker/` 等内容放到 GitHub 仓库根目录。
2. GitHub 仓库 → Settings → Pages → Deploy from a branch → `main` → `/ (root)`。
3. 等待 Pages 显示部署地址后打开。项目使用相对路径，支持 `https://用户名.github.io/仓库名/` 子路径。

## 2. 配置 AI（可选，手动文章训练不依赖 AI）
GitHub Pages 是静态托管，不能保存 API 密钥。使用 Cloudflare Worker：
1. 在 Cloudflare 创建 Worker，将 `worker/index.js` 内容粘贴为 Worker 代码并部署。
2. 在 Worker → Settings → Variables and Secrets 中新增 Secret：`GEMINI_API_KEY`，值为你的 Gemini API Key。
3. 可选新增环境变量 `ALLOWED_ORIGIN`，填写 Pages 完整来源，例如 `https://username.github.io`（不要加仓库路径）。不设置时 CORS 为 `*`，但 API Key 仍只保存在 Worker Secret。
4. 在作文训练页面填写 Worker 地址（例如 `https://review-words-api.<账户>.workers.dev`），点击“生成约 150 词作文”。
5. 首次测试请只选 1–3 个薄弱词。文章会做目标词覆盖检查，失败会显示缺失词，不会保存不合格结果。

## 3. 本地数据和备份
- 业务数据仍由原有同步 localStorage API 驱动，并由启动桥接同步镜像到 IndexedDB，避免一次性重写旧应用。
- 浏览器不支持 IndexedDB 时自动退回 localStorage。
- 书架 → 本地数据安全 → 导出全部数据 JSON。恢复会覆盖备份中同名数据键，恢复前建议先导出当前备份。
- 数据按浏览器/设备隔离；清理站点数据、换浏览器或无痕模式会丢失本机数据。请定期备份。
- 不要把备份 JSON 提交到公开 GitHub 仓库。

## 4. 当前能力与边界
- 薄弱词池：忘记、模糊、收藏去重；忘记优先；可勾选排除本次生成。
- 每日任务：点击“准备今日任务”只创建本地待办，不会自动消耗 AI 额度。
- AI 作文：请求 Cloudflare Worker，保存文章正文、翻译、目标词快照和难度；按词书/日期保留文章历史。
- 严格模式/自由模式：沿用原页面输入逻辑。严格模式逐字符顺序校验；自由模式允许编辑后提交对照。
- 统计：背词统计沿用原统计口径；作文成绩另存为 `reviewwords.typingRecords.v1`，当前统计页尚未完全合并展示。

## 5. 隐私与额度
- Worker Secret 不进入 Git 仓库和浏览器存储。
- Worker 当前调用 Gemini `gemini-2.5-flash`；模型名可在 `worker/index.js` 的 `MODEL` 修改。
- API 费用、免费额度和可用地区以 Google AI Studio / Gemini 官方账户页面为准。
