# 更新日志（CHANGELOG）

> 反向时间顺序。完整历史见 GitHub Releases：https://github.com/forestkopa/project-kanban/releases

## v1.4.7-hotfix3（2026-09-02）
- **启动流程根因重构（彻底修复「未登录永久卡 splash」）**：hotfix2 仅把 modal 抬到 splash 之上、弹框前 `hideSplash()`，属打补丁；真正的脆弱设计仍在——`loadAll()` 用 `Promise.all` 并发 4 个请求，全部 401 时每个都去触发 `showLogin()`，`api()` 在 401 时也会递归弹登录框，启动路径与登录弹窗深度耦合。本次重构：
  - 新增 `probeAuth()`：用需鉴权的 `/api/projects` 试探当前 token（200=已登录，401/无 token=未登录），**不在 loadAll 里并发触发 showLogin**。
  - 新增 `boot()`：先 `probeAuth()`，已登录→直接 `loadAll()`；未登录→只弹**一次** `showLogin()`（modal 已置顶可见），登录成功后再重新 `boot()`，用户放弃则淡出 splash 露出页面（可经用户菜单再次登录）——**绝不卡死在首屏**。
  - 入口由裸 `loadAll()` 改为 `boot()`；`window` 守卫确保 Node 测试环境不自动启动。
- **`updateIOState` 防御性修复**：空项目列表时 `proj()` 为 `undefined`，原 `(p.status || 'active')` 直接抛 `Cannot read properties of undefined`，导致 `render()` 抛错、`loadAll()` 整体 reject。改为 `((p && p.status) || 'active')`。
- **新增前端启动冒烟测试**（`test/frontend-boot.test.cjs`，无需 jsdom，用轻量 DOM/fetch/localStorage stub）：锁死两条回归——①未登录冷启动 splash 必淡出、登录框必可见（不再被遮罩盖住）；②已登录直接进 `loadAll` 不弹框。6 断言全绿。
- **质量说明**：此前「清掉 localStorage token 触发卡死」的事故，根因是启动路径长期缺乏「未登录冷启动」回归测试。本次补测试锁死后，同类问题将在 CI 直接 fail，而非流向生产环境。

## v1.4.7-hotfix2（2026-09-02）
- **修复「未登录/会话失效时浏览器永久卡在『看板加载中…』splash」**：根因是 `#splash` 的 `z-index:9999` 高于登录弹窗 `.modal` 的 `z-index:200`，`loadAll()` 启动时 4 个并行请求（templates/projects/options/readonly）在无有效 token 时全部 401，前端虽弹出 `#loginModal` 但被 splash 遮罩完全盖住，用户既看不到也点不到登录框，死锁在 splash。修复：① 将 `.modal` 的 `z-index` 提到 `10000`（高于 splash，任何弹窗都置顶）；② `showLogin()` 内部在显示登录框前先调用 `hideSplash()` 淡出首屏遮罩。配合 hotfix1 已加的 `showLogin` 单例锁（并发 401 只弹一次），现在 token 失效会自动退 splash 并弹出登录框，用户可正常登录。

## v1.4.7-hotfix1（2026-09-02）
- **`tools/local-upgrade.ps1` 解析报错紧急修复**：生产机升级时脚本第 24 行触发 PowerShell 5.1 `ParseError: 语句缺少终止符 "}"`。根因：旧版本含「同行 `-Verbose` + `}`」与「单行 `if () { ... }`」易触发 PS 5.1 token 解析歧义（且部分生产环境 PS profile 会重写脚本中的 cmdlet 调用）。本次重写：**所有 if 全部换行写、全部 `Write-Host`/`Write-Warning` 改为 `+` 字符串拼接、严禁同行 `-Verbose` / 同行 `{}`**。`[System.Management.Automation.Language.Parser]` 已在本地通过解析验证。请用本版 zip 重新升级。

## v1.4.7（2026-09-02）
- **公网间歇性打不开 / 升级报 `fetch failed` 根因修复**：`watchdog.js` 的隧道守护原逻辑为「每 15s 探测，**单次失败**即 `taskkill /F /IM cloudflared.exe` 再重拉」。问题：①公司宽带偶发丢包即误判，重连那几秒公网完全不可达；②重连慢时下个周期又失败又重启，陷入**每 15s 重启循环**，网站长时间不可用；③用户点「一键升级」撞上重启窗口 → `fetch failed`。修复为**三级保险**：
  - 首次失败后隔 2s **复查一次**（双次确认，抖动不误杀）；
  - 连续确认失败 **3 次**才真正重启（`TUNNEL_FAIL_THRESHOLD`）；
  - 重启后 **90s 冷却期**（`TUNNEL_COOLDOWN`）内不再探测/重启，给隧道握手留足时间，杜绝重启循环。
- **升级错误文案可读化**（v1.4.6 后续补）：`api()` 网络层失败由原始 `TypeError: fetch failed` 改为中文提示「无法连接到看板服务：…请检查：①公网隧道是否在线；②本地 DNS；③浏览器是否禁用第三方请求」；`doUpgrade` 去除「升级失败：升级失败：」重复前缀。
- **回归测试**（`test/watchdog-tunnel.test.cjs`，已并入 `run-all.cjs`）：覆盖偶发抖动不重启 / 持续不可达才重启 / 冷却期内不重复重启 / 开发机模式永不接管隧道 4 个场景，全绿。

## v1.4.6（hotfix，2026-09-01）
- **一键升级「token 无效或已过期」修复**：生产机点「一键升级」报 `升级失败：token 无效或已过期，请重新点击「一键升级」`。根因：`lib/upgrade.js` 的 `pending` Map（一次性 token 存储）在**内存**中，`kanban-watchdog` 服务重启即清空 → `confirm` 时 `consumeToken` 读不到 → 报该错误。尤其生产机仍在 `v1.4.4`（v1.4.4→v1.4.5 升级未真正生效），旧前端同步 await 链路在 watchdog 重启后 token 丢失。修复：**token 持久化到 `data/upgrade-tokens.json`**（atomic write：tmp + rename），`prepareUpgrade` 生成 token 即落盘，`consumeToken` 在 `pending` 为空时从磁盘重读，进程重启不再丢 token。`TOKEN_TTL` 5 分钟过期仍生效（磁盘清理由 `pruneExpiredTokens` 负责）。

## v1.4.5（2026-09-01）
- **一键升级改为异步 + 实时进度条**：彻底解决「升级成功但前端显示失败」+「黑屏等待无反馈」两个老问题。
  - 服务端 `lib/upgrade.js`：`startUpgrade` 立即返回 `taskId`（<200ms），后台任务分阶段更新状态（`download` 0-70% / `backup` 70-85% / `extract` 85-98% / `restart` 98-100% / `done` 或 `error`）；`downloadFile` 改造为流式 + 进度回调（边下边写盘 + 推送 percent）；新增 `getTaskStatus` 给前端轮询。
  - 服务端 `server.js`：新增 `GET /api/admin/upgrade/status?taskId=xxx` 端点；`/confirm` 改为调 `startUpgrade` 不再 await 完整链路。
  - 前端 `app.js` `doUpgrade`：`confirm` 拿到 taskId → 启动 `setInterval(1000ms)` 轮询 → 实时渲染底部进度条 + 阶段文字；完成/错误时停轮询。
  - HTML/CSS：新增 `#verBar` 固定在 footer 上方（毛玻璃背景 + 8px 圆角进度条 + 阶段文字），升级中显示，结束隐藏。
  - 任务状态保留 10 分钟（完成后），前端断网/关闭重连能拉到最终结果 → 彻底告别"假超时"。

## v1.4.4（hotfix，2026-09-01）
- **一键升级超时修复**：「一键升级」点击后报「请求超时，请重试」并卡住。根因：前端 `api()` 的 `fetchT` 写死 15s 超时，但 `/admin/upgrade/confirm` 服务端链路（40MB 下载 + robocopy 备份 + 解压 + 重启）在公司宽带 + Cloudflare 隧道下常超 30–60s，触发 abort。修复：让 `api(opts)` 支持 `opts.timeout`，升级 prepare 用 60s、confirm 用 300s（5 分钟）。同步改 `kanban-workbench-template.html` 单文件离线版本。

## v1.4.3（2026-09-01）

### 待办页改版
- 待办升级为独立页面（侧栏一级入口），不再嵌在周报里
- 首屏加载优化，避免一次性渲染全部视图
- 待办卡片美观改版，点击任务可跳转对应项目看板

### 待办导出（独立功能键）
- 新增独立「导出」功能键，可选 日 / 周 / 月 范围
- 修复鉴权 401 导致“点了没反应 / 不下载”：导出接口改为免登录（纯前端数据转 xlsx，不读服务端、不写库）
- 导出异常统一弹 toast 提示，不再静默失败

### Excel 导出修正
- 状态列取值动态生成（今日待办 / 本周待办 / 本月待办），与看板实际状态一致

### 里程碑字段彻底清除
- 数据层 `is_milestone`、UI（周报/全景“本周里程碑” KPI、泳道图 ⚑ 图例）、待办页 ⚑ 标记与“仅里程碑”过滤、Excel 导出列、离线模板、单测、文档全部清理
- 根因：任务编辑弹窗从无里程碑勾选框，只能经导入/模板注入，故“没有存在感”

### 仓库精简
- 清理 64MB 陈旧交付物（kanban-5181-full.zip、5181-review.zip、*.patch）
- 新增知识库笔记 14/15/16

> 升级方式：生产环境侧栏「版本」→ 一键升级（自动下载本 Release 的 update.zip → 备份 → 解压覆盖 → 重启看板服务）。config.yml 不在包内，隧道配置不受影响。

## v1.4.2（2026-08-31）
- footer 一键升级（GitHub Release → 备份 → 解压 → 重启）

## v1.4.1（2026-08-31）
- 版本查看功能 + 部署架构修正

## v1.4.0（2026-08-24）
- 回收站 / 到期提醒 / 强制改密 + 账号锁定 + 代码质量改进

---

<details>
<summary>更早版本</summary>

v1.3.x 及之前的历史请见 GitHub Releases。本文件从 v1.4.0 起记录。

</details>

