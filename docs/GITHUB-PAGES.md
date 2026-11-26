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

## 3. AI 作文接口

作文生成由浏览器直接请求你自己配置的 OpenAI 兼容 API，项目不提供服务端代理，也不需要部署任何 Worker：
- 在"作文训练 → AI API 设置"中填写 Base URL、API Key 和模型名称，这些配置只保存在当前浏览器本地；
- 服务商必须允许网页跨域请求（CORS），否则浏览器会阻止请求；
- API Key 不要提交到 GitHub 仓库，私有仓库也不建议。

**不要**把 OpenAI、Gemini、Groq、OpenRouter 或其他模型密钥提交到 GitHub，即使仓库是私有的也不建议这样做。
