# GitHub Pages 部署说明

## 1. 发布静态网站

1. 在 GitHub 新建一个仓库，例如 `review-words`。
2. 将本 ZIP 解压后的**项目根目录内容**提交到仓库根目录（确保 `index.html` 位于仓库根目录）。
3. 打开仓库 **Settings → Pages**。
4. 在 **Build and deployment** 中选择 **Deploy from a branch**。
5. Branch 选择 `main`，目录选择 `/ (root)`，保存。
6. 等待 GitHub Pages 发布完成，使用页面显示的 HTTPS 地址访问。

本项目使用相对路径引用 `./assets/...`，适用于 `https://用户名.github.io/仓库名/` 这种项目站点地址。首次打开建议先在红宝书完成一条评分，再刷新确认本地记录仍在。

## 2. 数据保存与隐私

- 词书、学习记录和收藏保存在当前浏览器的 localStorage。
- 不同词书使用不同的数据键，切换词书不会共用学习进度。
- 清除浏览器站点数据、换浏览器或换设备前，请先备份（JSON 备份恢复功能仍在后续开发计划中）。
- GitHub Pages 不会自动把浏览器数据同步到 GitHub 仓库。

## 3. AI 作文接口（后续阶段）

GitHub Pages 是纯静态托管，不能把 API Key 放在 `assets/*.js` 中，也不能在 Pages 仓库里运行 Node 服务端 API。正式接 AI 时会把接口部署到 Cloudflare Workers：
- 在 Worker 的 Secrets 中设置模型 API Key；
- Worker 仅开放必要的文章生成 POST 接口，并限制请求大小、来源和频率；
- GitHub Pages 前端只配置 Worker 的公开 HTTPS URL；
- Worker 返回作文和翻译，浏览器本地保存文章。

**不要**把 Gemini、Groq、OpenRouter 或其他模型密钥提交到 GitHub，即使仓库是私有的也不建议这样做。
