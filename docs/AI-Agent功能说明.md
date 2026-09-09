# AI 助手 · Agent 功能说明

> 2026-09-08：内置 AI 助手从「一次性生成任务清单」升级为**能真正操作看板的 Agent**。

## 一、它现在能做什么

原来的 AI 助手只是一个生成器：输入描述 → 返回任务清单 → 手动点创建。**看不到你的看板、也不能改数据**。
现在它是对话式 Agent：理解你的意图 → 调用看板工具 → 多步执行 → 用自然语言汇报。

### 可用工具（10 个）

| 类型 | 工具 | 能力 |
|------|------|------|
| 只读 | `list_projects` | 列出项目及进度、逾期数 |
| 只读 | `get_overview` | 全局概览：逾期 / 本周 / 下周到期 |
| 只读 | `get_project` | 项目详情：阶段 + 任务清单 |
| 只读 | `search_tasks` | 按关键词 / 负责人 / 状态 / 逾期搜索 |
| 写入 | `create_project` | 建项目，自动按阶段排期 |
| 写入 | `add_task` | 给项目加任务 |
| 写入 | `update_task` | 改标题 / 负责人 / 工期 / 完成状态 / 日期 |
| 写入 | `update_project` | 改名 / 改状态 / 改开始日期（级联重排） |
| ⚠️危险 | `delete_task` | 删任务（**需二次确认**，进回收站） |
| ⚠️危险 | `delete_project` | 删项目（**需二次确认**，进回收站） |

### 用法示例

直接说人话即可，支持模糊名称（"音箱项目"会自动匹配"智能音箱项目"）：

- 「我有几个项目？整体进度如何」
- 「有哪些逾期的任务？」
- 「本周有什么任务到期？」
- 「张工手上还有哪些没完成的？」
- 「帮我建一个智能门锁降本项目，含结构降本与固件开发」
- 「把音箱项目的结构打样标为完成」
- 「删掉音箱项目的固件联调」→ 会先弹确认卡片

## 二、安全设计（三条红线）

1. **权限继承**：所有工具以「当前登录用户」身份执行（走 `db.*` 的 `owner_id` 隔离）。member 通过 AI 也看不到/改不了别人的项目；admin/manager/viewer 按原有角色分级可见。
2. **只读模式**：开启只读后，全部写入工具一律拒绝，查询不受影响。
3. **危险操作二次确认**：删除类工具不直接执行，返回待确认卡片（含项目名/任务名/负责人/截止日期）；点「确认」才落地，且先存回收站可恢复。确认令牌 10 分钟有效、绑定用户（他人无法代确认）。

## 三、技术实现

### 后端

- **新增 `lib/ai-agent.js`**：工具定义（OpenAI function calling schema）、工具执行器、Agent 主循环。采用**依赖注入**（`db` / 辅助函数 / `chat` 由 server.js 传入），避免循环依赖、便于单测注入 mock。
- **`server.js`**：
  - `chatCompletionsFull()`：新增支持 `tools` 参数并返回完整 message（含 `tool_calls`）；原 `chatCompletions()` 保持签名不变（只取文本）。
  - `POST /api/ai/agent`：Agent 对话入口（需登录，30 次/分钟限流）。
  - `GET /api/ai/agent/tools`：工具清单（供前端展示）。

### 双协议：兼容本地小模型

多数本地小模型（如 LM Studio 的 `minicpm5-2b`）**不支持 function calling**。Agent 会自动探测：

- 模型返回原生 `tool_calls` → 走原生 function calling 路径；
- 模型把工具调用写成文本 `TOOL: {"tool":"...","args":{...}}` → 判定不支持，**自动降级为文本协议**（后端解析执行），界面右上角会标注「文本协议」；
- 探测结果的那次响应会被复用为首轮，不浪费一次请求。

循环上限 8 步，防死循环烧 token。

### 前端

AI 助手模态框改为对话面板：消息流（用户/助手）、**可折叠的工具执行步骤**（"已执行 1 项修改"）、快捷问题 chips、危险操作确认卡片。Enter 发送 / Shift+Enter 换行。数据被改动后自动静默刷新看板，无需手动 F5。

### 本地模型慢的超时配置

`minicpm5-2b` 之类的本地小模型单步推理 10~30s，整轮 Agent（推理→工具调用→再推理）累计可能 90s+。前端 API 默认 15s 超时不够，配置差异：

- **`aiRun` 调 `/ai/agent`**：timeout = `AI_AGENT_TIMEOUT_MS` = 150000ms（150s），与后端调 LM Studio 的 120s 对齐并留余量。
- **`aiSummarize` 调 `/ai/summarize`**：60s（单步调用，本地单步超 60s 可视为模型配置问题）。
- **错误文案**：超时分支不再笼统说"请重试"，而是直接告诉用户"本地小模型推理较慢属正常，若反复超时请换更小模型或开云端接口"，避免用户以为程序坏了反复点。

回归测试：`test/ai-timeout.test.cjs`（11 断言），已接入 `test/run-all.cjs`。

## 四、测试

| 测试 | 断言数 | 覆盖 |
|------|--------|------|
| `test/ai-agent.test.cjs` | 59 | 权限隔离、越权拒绝、只读拦截、危险操作确认/取消/跨用户拒绝、双协议解析、循环上限 |
| `test/ai-agent.e2e.cjs` | 21 | 真实服务实例 + mock LLM：端点接线、鉴权 401、任务真实落库、删除确认后真删并进回收站、未配置 AI 提示 |

均已接入 `test/run-all.cjs`。

## 五、顺带修复的缺陷

- **离线工作台模板不渲染看板**：`kanban-workbench-template.html` 长期未重建，重建后发现离线适配器自称"免登录"却未预置会话令牌，导致 `boot()` 卡在登录框、看板空白。已在 `offline-adapter.js` 启动时预置演示 token 修复。
- **模板是构建产物**：`kanban-workbench-template.html` 由 `build_template.py` 从 `public/` 三件套 + `offline-adapter.js` 生成。今后改前端后应运行 `python build_template.py` 重建，而非手改模板（手改会在下次构建时丢失）。
- **离线适配器残留旧端点**：`/ai/ollama-models` → `/ai/local-models`（LM Studio 检测修复的一致性问题）。
- **月报/日报/周报「AI 总结」对只读访客报 403**（2026-09-08 实测修复）：AI 总结是纯只读文本生成（读项目数据 → 调 LLM → 返回 Markdown，不落任何库），却被全局 viewer 写闸门一刀切拒绝；而月报页「AI 总结」按钮对访客可见可点，于是点击即红字「生成失败：只读访客，无修改权限」。修复：`server.js` viewer 闸门豁免 `/api/ai/summarize`（注释标明理由）；`lib/ai-agent.js` 工具层补 viewer 纵深防护（写工具与危险操作对 `viewer` 一律拒绝、只读工具放行），为将来向访客开放只读 AI 对话预留闸门。

## 六、输出结构化渲染（AI 入口统一美观展示）

三个 AI 入口（Agent 对话 / 报告视图总结 / 月度计划总结）的输出统一走 **Markdown → 结构化 HTML** 渲染链路：

- **前端自研轻量渲染器 `mdToHtml`**（`public/app.js`，约 80 行，零外部依赖、离线模板可用）：支持代码块、表格（表头+分隔行+数据行，`---` 分隔行不渲染）、1–4 级标题、`-`/数字列表、`>` 引用、`**加粗**`、`*斜体*`、行内代码、`[文本](链接)`。**先整体转义再解析**，模型输出带 HTML/脚本也无法注入。
- **后端提示词引导结构化输出**：Agent 行为准则新增"多条信息用表格 / 要点用 `- ` / 数字加粗"；`/api/ai/summarize` 周报/月报提示词要求 Markdown 排版（首句总览 + 要点 + 加粗关键数字）。
- **本地兜底文本也是 Markdown**：`buildTextFallback` 输出改为 `- ` 列表 + `**加粗**` 标题，模型空回复时兜底同样美观。
- **总结弹窗升级**：只读 textarea 换成可滚动渲染容器（宽 720px，表格可横向滚动），「复制文本」复制原始 Markdown（可直接粘贴进日报/周报/月报）。

样式集中在 `public/style.css` 的 `.md` 块（深浅色主题自适应）。

### 配套测试

`test/md-render.test.cjs`：23 断言，覆盖粗体/斜体/行内码/标题/列表/引用/表格（含"分隔行不渲染"回归点）/代码块/段落合并/XSS 注入转义/链接/边界。已接入 `test/run-all.cjs`。

## 七、对话记录（可新建 / 选择 / 删除 / 自动持久化）

需求「AI 助手新增对话记录，可选择，可删除」。实现要点：

### 数据层（SQLite）

- 两张新表 `ai_sessions`(id,user_id,title,created_at,updated_at)、`ai_messages`(id,session_id,role,content,meta_json,created_at)。
- **owner 隔离**：所有查询过滤 `user_id=req.user.id`，他人读/改/删返回 404；**外键级联删除**会话即清消息（`ON DELETE CASCADE`，PRAGMA foreign_keys=ON）。
- 安全参数：标题截 40 字、单条消息截 20000 字（脏数据防爆库）、空白 user 消息不入库、`ai_messages` 走 `BEGIN/COMMIT` 事务批量写。
- 暴露方法（`db.js`）：`aiListSessions/aiCreateSession/aiRenameSession/aiDeleteSession/aiListMessages/aiAppendMessages`。

### 后端 API（按账号隔离）

| 端点 | 用途 |
|---|---|
| `GET /api/ai/sessions` | 当前用户会话列表（id / title / updatedAt / msgCount），按 updated_at 倒序 |
| `POST /api/ai/sessions` `{title?}` | 新建会话；默认「新对话」 |
| `PUT /api/ai/sessions/:id` `{title}` | 重命名（前端用：首问后自动改为问题前 18 字） |
| `DELETE /api/ai/sessions/:id` | 删除（级联清消息） |
| `GET /api/ai/sessions/:id/messages` | 会话全部消息（meta.steps 还原历史折叠） |
| `POST /api/ai/sessions/:id/messages` `{messages:[{role,content,meta?}]}` | 增量追加；自动刷 updated_at |

鉴权：需登录；写操作受全局 viewer 只读闸门保护（viewer 创建/删除/追加直接 403）。未登录 GET → 401。

### 前端（左 ChatGPT 风格侧栏）

- AI 助手模态框拆成 `.ai-body`：左侧 218px 会话栏 + 右侧对话主区。
- 侧栏元素：「+ 新对话」按钮、会话列表（`title` + 相对时间戳 + hover 出现的删除按钮）、底部「共 N 个对话」。
- 自动命名：首问落库后立即 PUT 标题为前 18 字（去空白），列表顺序按最后活跃时间。
- 切换会话：先 flush 当前未保存增量 → GET messages → 重渲染 `aiHistory + aiChatLog`，恢复工具执行步骤折叠。
- 删除：浏览器原生 `confirm` 二次确认 → DELETE → 当前若被删自动回到新对话空态。
- 增量保存游标 `aiSaved`：对话上下文仅传 `{role, content}` 干净结构给后端做多轮推理；本地 `meta.steps` 留作重放。
- 修复附带小 bug：原先 `openAiModal` 每次打开都重复插欢迎语 → 改为仅当 chatLog 完全为空时插入一次。

### 离线模板

`offline-adapter.js` 补齐同构 `/api/ai/sessions*` 桩，存 localStorage（`kb-ai-sessions` / `kb-ai-msgs`），离线模板点 AI 助手也能正常用对话记录功能。

### 测试

| 测试 | 断言数 | 覆盖 |
|---|---|---|
| `test/ai-sessions.test.cjs` | 23 | db 层 CRUD、owner 隔离、meta.steps、截断、空消息、级联删 |
| `test/ai-sessions-api.test.cjs` | 21 | 真实 HTTP 实例：list/create/append/read/rename/delete、未登录 401、viewer 写 403、他人越权 404、不存在 404 |

均接入 `test/run-all.cjs`，全套 26 套件通过（含 jsdom 冒烟 OK）。

### 精简：两图标取代常驻侧栏（2026-09-08）

用户反馈「常驻 218px 侧栏占空间」。改为：**标题栏右上两个 28×28 图标**——✏️「新对话」与 🕘「历史对话」。点历史图标才在对话右侧浮出 236px 历史面板（带「◀ 收起」按钮 + 列表外任意点击自动收起）；平时对话区占满全宽。模态框宽度从 920px 收到 760px。实现细节见 `public/app.js` 的 `aiSideOpen/aiSideClose/aiSideToggle` + `document.click` 监听。
