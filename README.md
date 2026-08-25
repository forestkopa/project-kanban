# 多项目管理个人看板（智能硬件产品模板）

一个本地网页应用，用于管理多个智能硬件产品项目。内置 4 份优秀产品模板，支持多项目切换、看板拖拽、任务增删改与完成跟踪，并已扩展为多用户（账号 + 角色）体系，数据层基于 SQLite。

> 注：前端为零框架 / 零 CDN（全部原生 JS + 内联 SVG 图标，离线可用）；运行时依赖两个 npm 包：`xlsx`（计划表导入导出）与 `xlsx-js-style`（带样式的 Excel 导出，如周报待办清单）。

## 启动

```bash
cd project-kanban
npm install          # 首次需要：安装 xlsx / xlsx-js-style
node server.js       # 正式版：默认 http://localhost:5180（真实数据，写操作需登录）
node server.js --demo  # 演示版：http://localhost:5180（脱敏数据 + 免登录，公网隧道指向它）
```

端口约定（勿改）：
- **5180 = 演示版**（`--demo`，脱敏数据 + 免登录，公网评委访问）
- **5181 = 正式版**（真实数据，写操作需登录，本机日常使用；由 `watchdog.js` 以 `PORT=5181` 启动）

> 纯 `node server.js` 与 `node server.js --demo` 默认都占用 5180，故**生产双实例请用 `watchdog.js` 启动**（它会以 `PORT=5181` 拉起正式版、以 `--demo` 拉起演示版）。

建议通过 `watchdog.js` 运行（崩溃自动拉起双实例 + 自动维护 Cloudflare 隧道）：

```bash
node watchdog.js
```

（使用内置 Node 运行：`.../node/versions/22.22.2/node.exe server.js`）

## 部署架构（双实例 + 公网隧道 + 开机自启）

```
本机 Windows
├─ kanban-watchdog (NSSM 服务) ── 开机自启，每 15s 探测
│   ├─ server.js --demo   → 5180 演示版（脱敏 + 免登录）
│   └─ server.js PORT=5181 → 5181 正式版（真实数据 + 登录鉴权）
└─ cloudflared (Named Tunnel) → https://kanban.forestkopa.top （指向 5180 演示版）
```

- **公网网址（固定，不再变化）**：`https://kanban.forestkopa.top`，由 Cloudflare Named Tunnel（`kanban-demo`，HTTP/2 协议）指向 5180 演示版；域名已固化进 `watchdog.js` 与 `config.yml`，重启/崩溃自动恢复。
- 旧 `trycloudflare` 快速隧道已弃用（地址随机），现统一走 Named Tunnel。
- 隧道机制：`forestkopa.top` 的 NS 已改到 Cloudflare；Zero Trust → Networks → Tunnels → `kanban-demo` 挂 Public Hostname `kanban.forestkopa.top → http://localhost:5180`；本机 `cloudflared tunnel --config config.yml run` 持久化。

## 多用户与鉴权

应用已升级为多用户体系（账号 + 角色 + 登录 token），数据写入需登录。

**四种角色**

| 角色 | 中文 | 权限 |
|------|------|------|
| admin | 管理员 | 全量权限 + 用户管理（新建/改角色/删除用户） |
| manager | 副管理员 | 等于 admin **除用户管理外**的全部权限（由管理员在新建/管理用户时显式配置，非默认） |
| member | 成员 | 仅自己的项目可见可改；聚合报告只看自己 |
| viewer | 访客 | 全量只读，任何写操作返回 403 |

**账号与登录**
- 初始账号：`admin / 000000`（管理员）、`guest / 000000`（游客只读）。
- 新建用户默认密码 `000000`，登录后可在「修改密码」自助改密（密码至少 6 位）。
- 登录页支持「以游客身份登录」一键只读进入，以及「记住密码」。
- 登录成功后服务端下发 token，前端存 `localStorage`（`kb-token` / `kb-user`），后续请求自动携带；API 亦兼容旧 `X-Auth-Token` 头（值等于 `data/auth.token` 时视为 admin，老前端无缝升级）。
- 用户管理：管理员在「用户」面板可新建用户、改角色、删除用户（删除有保护：至少保留一名管理员、不能删除自己）。

**AI 设置（页面「AI 设置」）**
- 支持主流云端大模型（填 API Key，GET 返回掩码 `key_masked`，不清空不回显明文；空值提交 = 保持不变，仅「清除」才删除）。
- 支持本地大模型（Ollama，无需 Key）：勾选「使用本地模型」并填写/base URL（如 `http://localhost:11434`），可一键检测可用模型。

## 数据层（SQLite）

- 数据层使用 Node 内置 `node:sqlite`（零额外依赖）：正式版 `data/app.db`、演示版 `data/demo.db`。
- 存量 `data/projects.json` 在首次启动时**幂等迁移**进 SQLite（归入 admin 名下），迁移后以 SQLite 为准。
- `.gitignore` 已排除 `data/*.db`，**实时数据库不进版本库**（换机后首次启动自动建库 + 迁移）。
- 模板、`options.json`（项目类型/产品类型/等级/工程师类型，gitignore 排除）仍为 JSON 文件，可改。

## 换机 / 回家继续开发

本仓库托管在 GitHub（私有）：https://github.com/forestkopa/project-kanban

```bash
git clone https://github.com/forestkopa/project-kanban.git
cd project-kanban
npm install
node server.js --demo     # 演示模式（脱敏数据 + 免登录），或去掉 --demo 用真实数据
```

- 公网访问：域名固定 `https://kanban.forestkopa.top`，无需再读随机隧道地址；本机运行 `node watchdog.js` 即可恢复公网隧道。
- 敏感文件已在 `.gitignore` 排除，不会进版本库，换机后按需重新配置：
  - `data/ai.json`（AI Key）、`data/auth.token`、`data/options.json`、`public/brand-logo.png`、`data/*.db`（实时库）。
  - AI Key 在页面「AI 设置」填写；数据库首次启动自动建库迁移。
- 提交规范：改动后 `git add` + `git commit` + `git push origin main`（建议同步更新 `docs/knowledge/` 知识库与 `llms.txt`，见 `docs/开发备忘.md`）。

## 开机自启（Windows 服务）

通过 NSSM 注册 Windows 服务 `kanban-watchdog`，**开机即自启、无需登录、崩溃自动重启**：

```bat
:: 以管理员身份运行（install-watchdog-service.bat 等效内容）
install-watchdog-service.bat
```

脚本用 NSSM 把 `node watchdog.js` 注册为服务 `kanban-watchdog`，启动类型自动；服务管理可用 `services.msc` 查看/启停。旧「启动文件夹 vbs」方案已弃用（环境拦截间接启动进程），统一改用 NSSM 服务。

## 加固（r51 + 多用户/SQLite 扩展）

- 原子写 + 写入串行化（写队列），崩溃不损坏。
- 多用户登录 token 鉴权（`localStorage` 持有，API 兼容旧 `X-Auth-Token`）+ 请求体 10MB 上限（413）。
- viewer 只读拦截：任何写操作返回 403；用户管理仅 admin。
- 公式依赖 60 轮未收敛告警（疑似成环）。
- xlsx 升级至官方 0.20.2（修复已知漏洞，API 兼容）。
- 请求日志（时间/方法/路径/状态/耗时）；前端输入防抖（甘特图日期/工期/公式、项目开始）。

## 功能

- **多项目**：左侧列表管理多个产品项目，每个项目独立看板与进度条。
- **模板建项目**：点「新建项目（从模板）」，选一份智能硬件模板即生成完整项目（阶段 + 任务）。
- **看板**：六阶段列（需求立项 → 设计开发 → 打样试制 → 测试验证 → 量产导入 → 上市运营），任务卡可拖拽跨阶段。
- **任务**：勾选完成、编辑、删除、指定负责人与工期。
- **统计**：总进度、任务数、已完成/进行中。
- **视图**：看板 / 甘特图（Excel 坐标 + 公式级联）/ 日历 / 全景 / 日报 / 周报 / 月度计划。
- **聚合报告**：📊 报告 tab（按人汇总，`/api/report` + `/api/report/export` 导出 xlsx；导出标题合并居中为「项目聚合报告」，不含柱状图）。
- **多用户**：登录、角色（管理员/副管理员/成员/访客）、新建/改角色/删除用户、自助改密。
- **AI 总结/助手**：支持云端模型与本地 Ollama 模型。

## 内置模板

| 模板 | 类别 | 任务数 | 要点 |
|------|------|--------|------|
| 智能手表 / 可穿戴 | 可穿戴 | 19 | 心率/血氧、低功耗、IP68、BQB 认证 |
| 智能门锁 | 安防 | 21 | 指纹/NFC、防技术开启、10 万次寿命 |
| 智能摄像头 / AI 视觉 | AI 视觉 | 20 | SoC+IMX、夜视、NPU、隐私合规 |
| 智能音箱 / 语音助手 | 语音 | 20 | 双麦阵列、声学腔体、唤醒率、OTA |

## 数据与敏感文件（.gitignore 已排除）

排除：`data/ai.json`（AI Key）、`data/auth.token`、`data/tunnel-url.txt`、`data/tunnel.log`、`data/options.json`、`public/brand-logo.png`、`data/*.db`（实时库）。
换机后需重配：AI Key（页面「AI 设置」）、隧道地址（现为固定域名无需读文件）。

## 扩展方向

- 接真实数据源（邮件/文档/IM）：在 `server.js` 增加 `/api/connectors` 适配层。
- 多人协作：已用 SQLite（`node:sqlite`），可横向扩为 Postgres/远程库（见 `deploy/README-NAS.md` 的 NAS 迁移思路）。

## 版本托管

- GitHub 私有仓库：https://github.com/forestkopa/project-kanban（分支 main）
- 推送用 HTTPS + PAT；敏感文件绝不入库。
- 知识库：`docs/knowledge/`（Obsidian 原子笔记 + MOC），仓库根 `llms.txt` 为 AI 索引；每次功能迭代 push 前同步更新（约定见 `docs/开发备忘.md`）。
- **版本号方案**：`latest` 滚动指向 main 最新提交（GitHub Releases 页挂 `Latest` 徽标，便于一键取最新）；每个版本另打**不可变版本号**作为里程碑——`v1.0`（旧里程碑）→ **当前 `v1.1`** → 后续 `v1.2`…（功能迭代 v1.x / 重大重构 v2.0）。每次 push 用 `tools/sync-release.ps1` 自动同步；发版时 `.\tools\sync-release.ps1 -Version v1.1` 追加不可变版本标签与 Release。
- 最新可用代码：https://github.com/forestkopa/project-kanban/releases/tag/latest ；历史版本（带版本号）：Releases 列表中的 `v1.0` / `v1.1` …。
