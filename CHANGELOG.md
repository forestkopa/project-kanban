# 更新日志（CHANGELOG）

> 反向时间顺序。完整历史见 GitHub Releases：https://github.com/forestkopa/project-kanban/releases

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

