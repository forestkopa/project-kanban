---
title: 测试隔离与 KB_DATA_DIR
category: 测试
tags: [测试, 安全, 多用户, SQLite]
summary: 用 KB_DATA_DIR 环境变量让 server.js 指向独立临时数据目录，测试自起隔离实例绕过 P1-8 强制改密闸门，零污染真实部署。
---

# 测试隔离与 KB_DATA_DIR

## 问题
新增 P1-8 强制改密闸门后，旧测试套件（直连 live 5181 + `data/auth.token`）全部写操作被 `403 MUST_CHANGE_PASSWORD` 拦截——因为本地 admin 仍用初始密码 `000000`，而闸门拦截除改密外的所有非 GET 写操作。

## 根因
`server.js` 的写操作鉴权链：登录 → GET 鉴权 → 内容长度 → 自助改密(`/api/password`) → 登录校验 → viewer 只读 → **P1-8 闸门**（用初始密码且非 viewer → 403）。`/api/password` 端点在闸门**之前**处理，故改密本身不被拦截（非死锁）。

## 解法：隔离实例
1. `server.js` 第 18 行 `DATA` 增加环境变量覆盖（向后兼容）：
   `const DATA = process.env.KB_DATA_DIR ? path.resolve(process.env.KB_DATA_DIR) : path.join(ROOT,'data');`
2. `test/_harness.cjs` 自起独立实例：`spawn(node, ['server.js'], {env:{PORT:空闲端口, KB_DATA_DIR:临时目录}})` → 轮询 `/api/readonly` 至 `demo=false` → 登录 `admin/000000` → 调 `/api/password` 改密（`KbTest@2026`）→ 返回 `{base, token, stop()}`。
3. `api.integration.test.cjs` 的 B 段、`api-roles.test.cjs` 改用 harness 实例（不再读 `data/auth.token` 直连 live 5181）。

## 关键事实
- 改密只 `UPDATE users SET pass_hash`，**不触碰 tokens 表** → 测试改密不影响运行中的会话（含 auth.token 文件令牌）。
- 首次运行真实模式（空库）会按 `server.js:362` 自动播种 1 个模板示例项目，故断言应写「为数组」而非「为空」。
- 隔离实例用临时目录，测试结束 `stop()` 杀进程并 `rm` 临时目录，无残留。

## 验证
`node test/run-all.cjs` → 数据层 16/0、API 集成 21/0、角色 8/0、前端 jsdom 冒烟 SMOKE_OK，聚合「全部测试通过」(exit=0)。
