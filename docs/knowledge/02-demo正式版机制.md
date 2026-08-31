---
title: demo / 正式版代码区分机制
tags:
category: concepts
summary: DEMO_MODE 开关的识别与 8 处代码分支，前端经 /api/readonly 感知模式，watchdog 双实例分工。 [看板, 架构, demo]
date: 2026-08-21
status: 已确认
related: [[00-知识地图(MOC)], [01-部署与双实例]]
---

# demo / 正式版代码区分机制

同一份代码，靠 `DEMO_MODE` 开关分流（server.js L10 `process.argv.includes('--demo')`）。

## 总开关

```js
const DEMO_MODE = process.argv.includes('--demo');   // server.js L10
```

- `node server.js` → `DEMO_MODE = false`（正式版）
- `node server.js --demo` → `DEMO_MODE = true`（演示版）

## 分支点（8 处）

| 位置 | 代码 | 作用 |
|---|---|---|
| L10 | `DEMO_MODE = process.argv.includes('--demo')` | 总开关 |
| L15 | `PROJECTS_FILE = DEMO_MODE ? 'projects.demo.json' : 'projects.json'` | **数据文件隔离**（两版互不干扰的根本） |
| L38 | `if (!GIT_OK \|\| !file \|\| DEMO_MODE) return;` | demo 不自动 git 提交（评委乱改不污染版本库） |
| L417 | `if (DEMO_MODE) return;` | 空库播种示例项目仅正式版执行 |
| L489 | `authorized() { return DEMO_MODE \|\| 令牌匹配 }` | demo 免令牌；正式版校验 X-Auth-Token |
| L534 | `/api/readonly` 返回 `{ on, demo: DEMO_MODE }` | 前端据此显示「演示模式·免令牌」徽章、跳过令牌弹窗 |
| L917-918 | 启动日志带 `[演示模式]` / 打印令牌 | 运维区分实例 |

## 前端如何感知

前端不自己判断模式：`loadAll()` 请求 `/api/readonly` 拿 `demo` 存 `state.demo`；`true` 时顶栏显示蓝色「演示模式 · 免令牌」徽章、写操作跳过令牌输入框。

## watchdog 双实例分工

```js
const SERVERS = [
  { port: 5180, args: ['--demo'], env: {} },            // 演示版（带 --demo 参数）
  { port: 5181, args: [], env: { PORT: '5181' } }       // 正式版（不带 --demo）
];
```

两个进程各自 `process.argv.includes('--demo')` 得到自己的模式，读各自数据文件、按各自鉴权策略运行。

## 延伸

- 启动/端口约定见 [[01-部署与双实例]]
