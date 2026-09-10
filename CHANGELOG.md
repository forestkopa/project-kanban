# 更新日志（CHANGELOG）

> 反向时间顺序。完整历史见 GitHub Releases：https://github.com/forestkopa/project-kanban/releases

## v1.5.4（2026-09-10）导出 Excel 居中排版 + 修复「计划导出点了没反应 / 不下载」

### 我的待办导出（今日 / 本周 / 本月 / 下周）排版与计划表统一

- **表头深蓝底白字加粗**：填充 `#1F4E78`，与计划表/差异对比同色（标题行也统一），数据行白底黑字。
- **整张表细黑边框** `#000000`，替换旧的浅蓝边框 `#B4C7E7`；去掉旧的隔行浅蓝斑马 `#F2F7FD`，项目分组改由「合并单元格 + 表格线」区分。
- **6 列全部居中**（含项目列、任务列），与计划表一致。
- **日期为真日期 + 显示格式 `2026/9/13`**（去前导零），同样是 `Date` + numFmt `yyyy/m/d`，排序/筛选/导入闭环全部正确。
- **功能高亮保留**：`⚠ 逾期` / `⚠ 本周未完成·顺延` 仍为红字加粗 `#E0241B`，不会被统一配色冲掉。
- **列宽修正**：日期列改用真日期对象后，`computeTodoCols` 原先会把 `Date` 的默认字符串（40+ 字符）当内容长度，日期列被撑到上限 40；现按显示宽度 `2026/9/13` 估算。
- 实现：抽出 `todoSheet()`（同 `planSheet()` / `diffSheet()`，便于把多张表拼进同一工作簿而不丢样式）、`setDateFmt()` 增加 `startRow` 参数（待办是 0 标题 / 1 表头 / 2 起数据）、`computeTodoCols()` 支持 `Date`。

### 修复「我的待办导出内容 ≠ 待办页看到的清单」

**症状**：待办页明明列着逾期任务（标 `⚠ 逾期` 红字），导出的 Excel 里却没有这些任务。

**根因**：后端 `buildTodoXlsx` 的二次过滤写成 `(!t.startDate || t.startDate <= sunIso) && (!t.dueDate || t.dueDate >= monIso)`——要求**到期日不早于周期首日**，而逾期任务恰恰是 `dueDate < monIso`，于是被整批丢掉；顺带导致状态列的 `⚠ 逾期` 分支**永远不可达**（页面与导出不一致，且是静默的）。另外下周待办缺窗口上界，`dueDate >= monIso` 会把**下下周之后到期**的任务一并导出。

**修复**：过滤语义与前端 `collectTodos()` 完全对齐——
- 已完成 / 无截止日期的任务不进待办；
- 今日 / 本周 / 本月：逾期 + 周期内到期（`dueDate ≤ 区间末`），周期结束后才启动的排期任务（`startDate > 区间末`）排除；
- 下周：本周未完成顺延项无条件纳入 + 到期日落在下周窗口内（含上界）。

**回归**（`test/lib-xlsx-export.test.cjs` 78 → 99 断言）：逾期任务必须出现在导出中且状态列红字、同项目内逾期排最前、下周待办不得混入下下周任务、无截止日期任务不导出、待办表头深蓝/白字/居中/细黑边框、日期列真日期 + `yyyy/m/d`、`startRow` 生效（表头不被套日期格式）、日期列宽按显示宽度估算、序列化 XML 内确有对应样式。

### 导出 Excel 居中排版（计划表 / 差异对比）

- **表头深蓝底白字加粗**：填充色 `#1F4E78`（PowerPoint「蓝，个性色 1，深 25%」的近似色），字体白色加粗微软雅黑，与参考截图一致。
- **整张表细黑边框**：所有单元格四边 thin + 黑色 `#000000`，标准的 Excel 表格线。
- **表头整行居中**：`序号 阶段 任务 负责人 开始日期 截止日期 工期(天) 状态 备注`（差异对比为 11 列）水平+垂直居中。
- **数据列全部居中**（含任务列）：`序号`、`阶段`、`任务`、`负责人`、`开始日期`、`截止日期`、`工期(天)`、`状态`、`备注`——所有 9 列（差异对比 11 列）全部居中，与参考截图一致。
- **日期显示格式 `2026/9/13`**：写成 Excel **真日期**（`Date` + numFmt `yyyy/m/d`）而不是格式化文本——文本日期在 Excel 排序时会把 `2026/9/1` 排到 `2026/10/1` 之后（字典序错乱），真日期则排序/筛选/日期运算全部正确；导入侧 `normDate` 可回解析为 ISO，`导出→编辑→导入` 闭环无损。单元格取「本地正午」构造，规避 xlsx 序列号的分钟级浮点残差。
- **列宽调整**：任务列 wch 30→38，备注列 30→32，差异对比变动说明列 18→22，避免长任务名/变动说明被截。
- 实现：新增 `stylePlanSheet()` 统一 fill/border/alignment/font；`dateCell()` / `setDateFmt()` 处理日期；计划表/差异对比改用带样式的 writer（`xlsx-js-style`）并开启 `cellDates`；顺带把 sheet 构建拆成 `planSheet()` / `diffSheet()` 便于组合复用。
- 回归：`test/lib-xlsx-export.test.cjs` 单测 78/78（全列居中含任务、表头深蓝填充 #1F4E78、表头白字加粗、四边细黑边框、真日期 t='d' + z、读回 w='2026/9/13'、跨月排序正确、normDate 闭环、序列化后 xlsx 内确有对应 XML）。

### 修复「计划导出点了没反应 / 不下载」

**症状**：真实版（5181 / 公网 kanban.forestkopa.top）点「导出 ▾ → 初版计划 / 差异对比 / 最新计划」，浏览器不下载任何文件，也没有报错；演示版 5180 正常。

**根因**：`exportPlan()` 用裸 `<a href="/api/projects/:id/export?type=...">` 触发下载。浏览器导航**不会携带 `X-Auth-Token` 请求头**，而服务端自「GET 接口统一鉴权」起要求所有 GET 带登录态，导出路由还有 `if (!req.user) return 401` → 浏览器拿到的其实是 401 JSON，于是"什么都没发生"。演示版因为 demo 模式恒为 admin 视角，所以看起来正常。

**修复**：
- 新增统一带鉴权下载助手 `downloadAuthFile(url, fallbackName)`：`fetch` + `X-Auth-Token` → `blob` → `URL.createObjectURL` 落地，失败一律 toast 提示；401 时（非 demo）自动弹登录框，登录后重试。
- 三处导出全部改用它：计划导出（初版/差异/最新）、参考模版导出两处入口——**同类裸直链 bug 一并清掉**。
- 新增 `parseDisposition()`：优先解析 `filename*=UTF-8''` 中文文件名，回退 ascii 名，文件名不再是硬编码。
- 导出内容为空时明确提示「离线演示模式不支持生成文件」（离线模板的桩返回空，避免下载 0 字节文件）。

**回归测试**（新增 26 断言，已纳入 run-all）：
- `test/export-auth.test.cjs`（16）：源码层面锁死——`downloadAuthFile` 必带 token、用 blob；禁止任何裸 `/api` 直链（`a.href = \`/api/`）；三个入口均走新助手；`parseDisposition` 中英文解析正确；服务端导出路由确实要求登录。
- `test/export-download.e2e.cjs`（10）：真实隔离实例端到端——无 token 导出必 401、带 token 必 200 且返回合法 xlsx（PK 头）+ `Content-Disposition` 含 UTF-8 中文名；初版/差异/最新三种类型均可用；参考模版导出同样需 token。

## v1.5.3（2026-09-09）修复在线升级「解压失败（两种方式均失败）」

生产首次在线升级实测（1.5.1 → 1.5.2）在解压环节失败。错误被正确捕获并展示（v1.5.1 的"不再静默失败"生效），但报错只有 `Command failed: tar.exe -xf ...` 半截信息，**真实原因（stderr）全被吞掉**。深挖出四个问题一并修复：

- **① tar.exe 被 PATH 里的 GNU tar 劫持（头号嫌疑）**：`spawnSync('tar.exe')` 按 PATH 查找。机器装了 Git 后，PATH 里 MSYS 的 GNU tar 可能排在 Windows 内置 bsdtar（System32）之前——**GNU tar 根本不支持 zip 格式**，解 zip 必失败。修复：改用 `System32\tar.exe` 绝对路径，杜绝劫持。
- **② execSync 字符串拼命令的转义地狱**：`JSON.stringify` 出来的 `\"`、`\\` 过 cmd.exe 后语义不清。修复：tar 改 `spawnSync` 数组参数（路径原样传递零转义）；PowerShell 改 `-EncodedCommand`（UTF-16LE base64），彻底绕开引号转义。
- **③ 下载完整性校验不足**：此前只查文件 >1KB——**下载截断/CDN 错误页的坏 zip 会直接进解压**，恰好能同时解释 tar 与 Expand-Archive 双双失败。修复：三重校验（收到的字节数 == content-length、== Release 声明的 asset 大小、文件头必须为 `PK` 魔数），任一不符即判失败并重试下载。
- **④ 失败信息与现场**：解压失败时错误信息必带 **stderr 尾部**（最多 400 字符，不再只有 "Command failed"）；失败的 zip 不再删除，改名为 `upgrade-failed-*.zip` 留在项目根目录供人工诊断。
- **⑤ 顺带修**：下载流 `ws.end()` 改为等待落盘完成再 stat（原实现立即返回可能读到未写完的大小）。
- 测试：升级集成测试扩至 13 断言——新增魔数闸拦截损坏 zip、解压失败信息带真实 stderr（断言不含 undefined）、完好 zip 经真实 System32 tar 成功解压三组回归；全套 29 套件通过。

## v1.5.2（2026-09-09）测试基建加固（零业务代码改动）

依据第三方评估报告（v1.5.1 快照，综合 8.7/10）指出的两条 P1 建议修复，仅改 `test/`，**不触碰 server.js / db.js / public/**，服务器功能零变化。

- **P1-① 补齐 npm test 漏跑的 26 断言**：`test/run-all.cjs` 此前未纳入 `formula-engine`、`db-report`（node:test）、`todo-nextweek`、`frontend-boot` 四个套件——其中后两个正是 v1.4.7 hotfix3/4 的**修复回归测试**，漏跑等于这两条防线在 `npm test` 下形同虚设。现已全部纳入，聚合覆盖 304 → 330 断言。
- **P1-① 新增「防漏网自检」**：`run-all.cjs` 末尾扫描 `test/` 下所有 `*.test.cjs|js` 与 `*.e2e.cjs`，凡未出现在本次调度列表中的一律**打印清单 + 置退出码 1**。以后新增测试文件忘记加进聚合入口会当场报错，不会再静默漏跑（已用临时探针文件实测验证报警生效）。
- **P1-② API 集成测试摆脱对运行中 5180 的依赖**：`test/_harness.cjs` 新增 `startDemoInstance()`（自起 `--demo` + `KB_DATA_DIR` 临时库实例，免登录 admin 视角）；`api.integration.test.cjs` A 段由硬编码 `http://127.0.0.1:5180` 改为自起隔离实例，结束即销毁。此前 5180 没启动/版本不一致/数据被污染会导致测试误报假绿。
- **顺带加固**：`waitFor()` 增加 `expectDemo` 显式校验（`demo===true/false` 必须匹配才算就绪），避免端口被其他进程占用时"连上就算通过"而测错实例；聚合结果新增「N 通过 / M 失败」套件计数，失败套件名直接列出。
- 验证：`npm test` → 19 套件全绿、19 个测试文件全部纳入聚合、`SMOKE_OK` 0 捕获错误。

## v1.5.1（2026-09-09）
- **修复「一键升级提示完成但版本没变」**（生产服务器升级失效，代码一个文件都没换）。
  - 根因：`watchdog.js` 的代码热重载与升级流程打架——`Expand-Archive` 逐文件覆盖 `server.js` / `public/` / `lib/` 时文件 mtime 变化，watchdog 每 15s 探测到「代码更新」就 `taskkill` 掉**正在执行升级的 server 进程**；而任务状态只存在内存，进程被杀即丢失 → 前端轮询得到「任务不存在/已结束」误以为完成，实际解压半途中断、版本未变。
  - 修复①**升级锁**：升级（及离线脚本）期间创建 `data/upgrade.lock`，watchdog 有锁时跳过热重载（端口挂了仍照常拉起，自愈不失效）；成功/失败后均强制解锁。
  - 修复②**解压后强制校验**：比对 `package.json` 版本号是否等于目标版本，不符直接判 `error` 并提示改用离线升级（不再静默"完成"）。
  - 修复③**任务状态持久化**到 `data/upgrade-task.json`，进程被重启后前端仍能拉到 `done`，不再显示「任务不存在」。
  - 修复④**解压改用系统内置 `tar.exe`**（bsdtar，支持 zip、无 260 字符路径限制），失败回退 `Expand-Archive`；下载超时 180s → 600s 并重试 3 次。
  - 修复⑤**全过程写日志** `logs/upgrade-YYYY-MM-DD.log`（此前 watchdog 以 `stdio:'ignore'` 拉起，无任何日志可查）。
  - 前端：升级重启期间请求失败不再静默，显示「服务重启中…（N s）」并持续等待最多 120s。
  - 新增回归测试：`test/watchdog-upgrade-lock.test.cjs`（3 场景）+ 升级集成测试扩展（版本未变必判 error、持久化跨重启可读、结束必解锁、日志落盘），全套 28 套件通过。

## v1.5.0（2026-09-09）
- **AI 助手升级为对话式 Agent**（新增 `lib/ai-agent.js`）：不再只是「问答」，而是理解意图 → 调工具 → 多步执行。
  - 10 个工具：只读 4（list_projects / get_overview / get_project / search_tasks）、写入 4（create_project / add_task / update_task / update_project）、危险 2（delete_task / delete_project，**先返回确认 token、二次确认才执行，删除进回收站可恢复**）。
  - 以登录用户身份执行，member 越权访问他人数据直接拒；项目名/任务名模糊匹配，多命中时反问澄清。
  - 双协议：原生 function calling 优先；小模型不支持时自动降级文本协议（`TOOL:{...}` 指令块），主循环上限 8 步。
- **对话记录（可新建 / 选择 / 删除，服务端持久化）**：新增 `ai_sessions` + `ai_messages` 两表（user_id/session_id 外键级联、按账号隔离，标题截 40 字、单条消息截 20000 字）。UI 为标题栏双图标（✏️ 新对话 / 🕘 历史对话），历史会话为右侧浮层，零常驻占用，切换/删除后自动收起。
- **AI 输出 Markdown 结构化渲染**：自研 `mdToHtml`（先转义防 XSS，支持表格/列表/标题/引用/代码块），统一三入口（Agent 对话 / 周报总结 / 月报总结）。
- **本地模型检测修复**：新增 `/api/ai/local-models` 并行探测 LM Studio(1234) + Ollama(11434)；原「检测本地模型」只认 Ollama，装了 LM Studio 永远检测不到。
- 修复：本地小模型多步推理被前端 15s 超时 abort（`aiRun` 透传 150s，超时文案改为引导换更小模型或开云端）；月报 AI 总结对只读访客 403（viewer 闸门豁免纯只读 summarize，Agent 工具层补 viewer 纵深防护）；离线模板卡登录框（适配器启动时预置 kb-token）。
- 新增 6 套测试共 179 断言（ai-agent 79 / e2e 21 / ai-sessions 23 / ai-sessions-api 22 / md-render 23 / ai-timeout 11），全套 27 套件通过（含 jsdom 冒烟 SMOKE_OK）。

## v1.4.7-hotfix5（2026-09-03）
- **修复「升级页脚自相矛盾」**：页脚同时显示「当前 v1.4.7-hotfix3」+「已是最新（v1.4.7-hotfix4）✓」，导致管理员无法判断是否需升级、一键升级按钮看似失效。
  - 根因：`public/app.js` 的 `cmpVer(a,b)` 只按 `.` 拆版本号并 `parseInt`，遇到 `1.4.7-hotfix3` 会把 `7-hotfix3` 整段 `parseInt` 得 7，后缀被吞；`cmpVer('1.4.7-hotfix3','1.4.7-hotfix4')` 错误返回 0（相等），`checkUpdate()` 走「已是最新」分支。
  - 修复：按 `.` 拆数字段、首个 `-` 之后当决胜后缀（空后缀最小，`hotfix3` < `hotfix4` 字典序也对）。`cmpVer` 同步加入 `module.exports` 供单测。
  - 影响：所有含 `-` 后缀的版本（hotfix1..4 等）现在能正确比较，生产环境升级检测恢复正常，本地 hotfix3 → hotfix4/5 升级链路打通。
- **新增回归测试**：`test/cmp-ver.test.cjs`（10 断言），含 hotfix3 vs hotfix4 回归点 + 无后缀 vs 有后缀决胜 + 跨大小版本比较；纳入 `test/run-all.cjs`。

## v1.4.7-hotfix4（2026-09-03）
- **待办导出新增「下周待办」（顺延模型）**：导出弹窗范围单选加「下周」选项（与今日/本周/本月并列，默认仍本周）。
  - 下周待办 = **本周未完成（done=false）任务自动顺延** + **下周原本计划的未完成任务**；已完成的排除。
  - 两类合并进同一张「待办清单」sheet：顺延项标「⚠ 本周未完成·顺延」（逾期标红），下周计划项标「下周计划」。
  - 实现：`collectTodos` 加 `nextweek` 分支（算本周日+下周边界、打 `carryover` 标记）；`downloadTodoExcel` 算下周边界并透传 `carryover`；`openExportModal` 加选项；`lib/xlsx-export.js buildTodoXlsx` 顺延任务无条件纳入；`server.js` todo-export 路由放行 `nextweek` kind（此前三元写死会静默回退成 week）。
- **回归测试**：`test/lib-xlsx-export.test.cjs` 加 nextweek 用例（顺延/计划纳入、已完成排除、标题正确）；新增 `test/todo-nextweek.test.cjs` 锁前端 `collectTodos('nextweek')` 选择逻辑。
- **待办导出列宽自适应（方案 B）+ 顺手修状态逾期红字 bug**：原 `buildTodoXlsx` 状态列写死 `wch:12`，nextweek 顺延文案「⚠ 本周未完成·顺延」约 10 中文，Excel 下需 ~17 字符宽，12 装不下 → 状态被截断遮住；任务列 36 又偏宽，整体宽窄失衡。改为 `computeTodoCols(rows)` 按单元格字符长度估算（中文/全角×1.8、英文×1，跳过标题合并行避免撑爆首列，min 8 / max 40），状态列自动撑到 ~18、任务列按实际收紧。另修隐藏 bug：状态列索引是 5，但原逾期红字判定写 `c === 6`（第七列，不存在）永不命中 → 状态逾期红字从未生效；改为 `c === 5` 并给状态列加 `wrapText` 兜底换行。

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

