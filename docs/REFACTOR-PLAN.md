# Review Words 改造记录

## 基线审计（2026-11-12）

- 原项目是无构建步骤的静态 HTML/CSS/原生 JavaScript；入口为 `index.html`，主要逻辑集中在 `assets/app.js`（约 2,200 行 IIFE）。
- 词库在 `assets/words.js`，详细词条在 `assets/detail/`，键盘手部图层由 `assets/hands.js` 与 `assets/hand-both.svg` 提供。
- 当前持久化使用 `localStorage` 的 `wordtype.v1`，记录以单词为键；这意味着尚不能安全支持多本词书独立进度。
- 现有复习间隔规则保留：首次忘了 15 分钟、模糊 20 分钟、很熟 1 天；后续忘了重置、模糊 ×1.5、很熟 ×2.2，最长 15 天。
- ZIP 中 Git 工作区有未提交修改（多个源文件同时处于 modified / deleted / untracked 状态）。因此不得以 Git HEAD 覆盖 ZIP 内文件；本次在解压副本上继续，并保留原 ZIP。

## 本次已落地的第一批改动

1. 背词页三档自评后直接记录复习计划并进入下一个词，不再进入中文拼音打字步骤。
2. 修复原工作区 `applyGrade()` 中忘记次数重复累加的问题（一次忘记只加 1）。
3. 键盘与手部动画从背词区移至作文训练区；屏幕键盘仅作提示，输入仍来自实体键盘。
4. 新增书架和作文训练页面的第一版界面。
5. 作文训练支持手动粘贴英文原文、填写中文翻译、严格/自由两种输入模式、基础 WPM/准确率/差异统计。
6. 保留旧数据键和原词库，当前没有执行破坏性迁移。

## 重要边界 / 尚未完成

- 书架目前是界面占位，尚未把所有记录改为 `bookId + wordId` 复合隔离；在迁移与回归测试完成前，不能宣称多词书进度已经独立。
- 作文目前是手动文章输入 MVP；AI 生成、每日任务、文章版本、目标词覆盖校验尚未接入。
- 当前数据仍写入 localStorage；IndexedDB、JSON 备份/恢复、迁移回滚尚未接入。
- WPM 目前按正确字符数 / 5 / 分钟估算；自由模式提交时以位置差异计数，后续需要替换为插入/删除/替换分解算法。
- 统计页仍有旧数据口径兼容问题，需在作文成绩实体落地后统一改造。

## 下一阶段顺序

A. 建立数据层：IndexedDB schema、事务、版本迁移、旧 `wordtype.v1` 只读备份与导入回滚。
B. 将学习状态、收藏、复习计划、统计统一改为 `bookId + wordId` 作用域；默认把现有记录迁入红宝书。
C. 完成书架：创建/导入/编辑/切换/删除词书；删除前导出或确认；每本书独立统计。
D. 建立薄弱词池：忘了 > 模糊 > 收藏，来源去重并允许手动勾选/移除。
E. 建立文章与打字记录模型，完成严格/自由模式、逐字符统计、错误类型分析。
F. 接入 AI 服务端代理；前端不得存放公开部署用 API Key。先确定部署环境和模型提供商，再实现每日待生成任务、手动生成、文章版本与目标词覆盖验证。
G. JSON 全量备份/恢复、跨刷新回归测试、原红宝书数据完整性验收。

## 模块目标结构

- `assets/modules/core/`：数据库、迁移、事件与路由
- `assets/modules/bookshelf/`：词书管理
- `assets/modules/vocabulary/`：词库与复习引擎
- `assets/modules/writing/`：文章、翻译、文章管理
- `assets/modules/typing/`：严格/自由输入与成绩
- `assets/modules/statistics/`：统一学习中心
- `assets/services/`：AI Provider 客户端
- `api/`：部署端 AI 代理（不在浏览器保存密钥）

采用渐进式拆分，现阶段继续保留 `assets/app.js` 作为兼容入口，不引入大型框架。


## 第二阶段（2026-11-12）：词书隔离与 GitHub Pages 部署约束

- 新增词书元数据清单 `reviewwords.books.v1` 与当前词书指针 `reviewwords.activeBook.v1`。
- 原 `wordtype.v1` 首次启动时复制到红宝书专属键 `wordtype.v1:book:redbook-2024`；旧键保留，不删除、不覆盖。
- 每本词书使用独立的 `wordtype.v1:book:<bookId>` 档案，因此复习记录、收藏、每日统计、自定义词条不会跨书串用。
- 红宝书继续使用内置 `WORD_BANK`；自定义词书仅加载自己导入的词条，不会混入红宝书全部词库。
- 书架已支持上传 TXT/CSV 建立自定义词书，并可切换当前词书。建议文件每行使用 `word | phonetic | Chinese meaning`，也兼容逗号或 Tab 分隔。
- 目前此阶段仍使用按书隔离的 localStorage，以保持原同步调用代码稳定；IndexedDB 主存储、迁移事务与 JSON 备份恢复仍列为下一阶段，不把 localStorage 镜像误称为 IndexedDB 已完成。
- 背词页旧中文拼音输入区隐藏，评分后仍保留原复习算法；键盘训练集中在作文模块。

### GitHub Pages 与 AI 接口

GitHub Pages 只能托管静态文件，不能安全保存 Gemini/Groq/OpenRouter 等服务端 API Key，也不能运行项目内的 `/api/generate-article.js` 服务端函数。AI 作文阶段将采用：
1. GitHub Pages 托管前端；
2. 独立 Cloudflare Worker（或其他 HTTPS Serverless 服务）做代理；
3. API Key 只放 Worker Secrets；
4. 前端通过配置的 Worker HTTPS 地址调用，生成结果保存在本机浏览器；
5. 不配置 Worker 时，网站仍可用手动文章训练功能。

### 当前未完成 / 需回归

- IndexedDB 结构化存储、JSON 备份恢复。
- 删除词书前导出/二次确认；目前先不提供删除入口，避免误删。
- 浏览器端导入兼容性测试（CSV 引号/复杂分隔符后续增强）。
- AI 每日待生成任务、文章历史、目标词覆盖校验。


## 第三阶段（2026-11-12）：本地持久化、薄弱词池、作文生成与备份

- 增加 IndexedDB `kv` 持久化桥接：启动时先读取 IndexedDB，再启动原 app.js；后续 localStorage 写入同步镜像到 IndexedDB。原同步 API 保持兼容，并提供不支持 IndexedDB 时的 localStorage 降级。
- 增加忘记/模糊/收藏薄弱词池，按优先级排序、来源去重，支持逐词勾选。
- 增加每日任务（仅建立待生成状态，不自动请求 AI）、AI 作文生成、目标词覆盖校验、文章历史。
- 增加全量 JSON 导出与恢复；恢复前提示覆盖风险。
- 增加 Cloudflare Worker Gemini 代理模板；API Key 通过 Worker Secret 配置，不进入 GitHub Pages 仓库。
- 文章输入成绩另存为 `reviewwords.typingRecords.v1`，保留词书 ID；现有背词统计仍独立显示。

### 已知限制
- 为避免重写原应用，本阶段采用 IndexedDB 镜像桥接，不是把业务代码全面改成异步 IndexedDB Repository；localStorage 仍是同步运行时缓存。
- 文章训练记录已保存，但统计页面的统一可视化汇总仍需下一阶段完善。
- AI 生成需要部署 Worker 并填写 URL；未配置时手动粘贴文章仍可使用。
