---
title: 多用户与 SQLite 数据层
tags:
category: concepts
summary: node:sqlite 五表、单项目粒度事务、三角色权限、登录/游客/记住密码与默认密码 000000、db 运维坑。 [看板, 多用户, SQLite, 权限, 登录]
date: 2026-08-24
status: 已确认
related: ["02-demo正式版机制", "09-GitHub托管与换机"]
---

# 多用户与 SQLite 数据层

> 2026-08-24 完成：数据层从 JSON 单文件迁移到 SQLite（Node 内置 `node:sqlite`，**零外部依赖**），
> 新增多用户（三角色）+ 按人聚合报告。为 NAS 部署（极空间）做准备。

## 数据层：node:sqlite（DatabaseSync）

- 文件：正式版 `data/app.db`，演示版 `data/demo.db`（`.gitignore` 已排除 `data/*.db*`）
- 特点：内置模块开箱即用（Node ≥22.5，实验性警告无害）、同步 API、单文件好备份
- **单项目粒度事务保存**（db.js `saveProject`）：每次保存 = 事务内重写该项目 phases/tasks，
  多用户并发编辑不同项目**互不覆盖**（旧 JSON 整数组保存会互相覆盖）
- **所有权规则**：`saveProject` 只在**创建**时设定 owner（按 id 查库：已有项目保留原 owner_id）——
  修复过 bug：编辑他人项目时曾把 owner 覆盖为编辑者（副管理员测试时把 admin 项目转给了自己）
- 项目对象往返组回原结构 `{phases, tasks, baseline}`，现有 API/前端无感知

### 五张表

| 表 | 关键字段 |
|---|---|
| users | id, name(唯一), role(admin/member/viewer), pass_hash(scrypt 盐:哈希) |
| tokens | token, user_id（每用户单 token，登录即换新） |
| projects | id, owner_id, name, type/level/cert/status..., baseline_json, sort |
| phases | (project_id, id) 复合主键, name, color, seq |
| tasks | id, project_id, title, phase_id, done, start/due_date, start_rule_json... |

- 存量迁移：首次启动 `ensureAdminAndMigrate` 自动把 `data/projects.json` 导入 admin 名下（幂等，重启不重复）
- 写队列/原子写：JSON 时代的 saveJSON 仍用于 options/ai 等小文件；项目数据全走 db

## 多用户鉴权

- 登录：`POST /api/login` → 校验 scrypt → 发 token（`db.issueToken`）
- 前端：token + user 存 localStorage（`kb-token` / `kb-user`），401 自动弹登录框重试
- 兼容：旧 `data/auth.token` 单 token 视为 admin（老前端无缝升级）
- 改密：`POST /api/password`（校验旧密码，含 viewer）；admin 可 `resetPassword` 重置任意用户

### 四角色权限（2026-08-24 起）

| 角色 | 项目可见 | 写操作 | 用户管理 | 聚合报告 |
|---|---|---|---|---|
| admin 管理员 | 全量 | ✅ | ✅ | 全量 |
| manager 副管理员 | 全量 | ✅（含他人项目） | ❌ 403 | 全量 |
| member 成员 | 仅自己 | 自己的 | — | 仅自己的 |
| viewer 访客（游客） | 全量只读 | ❌ 403 | — | 全量 |

- 副管理员 = admin 全部权限 − 用户管理（/api/users 仅 admin；建用户下拉可选 manager）
- 角色可改：`PUT /api/users/:id` {role}（admin；白名单 admin/manager/member/viewer；**不能改自己的角色**防锁死）；用户管理表格角色下拉即时生效
- 删除用户：`DELETE /api/users/:id`（admin；**有项目则拒绝**（避免级联误删数据）；guest 系统账号禁删；不能删自己；至少保留一名管理员）；删除后 token 级联失效即时踢下线
- viewer 前端：`body.viewer` CSS 隐藏全部编辑入口 + 后端 403 双保险
- 报告：`GET /api/report`（按人聚合：项目数/任务/完成/逾期/完成率/阶段分布）+ `/api/report/export` xlsx；**系统游客账号 guest 已从报告排除**（无项目不参与聚合）

## 账号与登录 UX

- **默认密码统一 `000000`**：admin 初始 / 新建用户留空 / guest 游客
- 游客：启动引导自动建 `guest`（viewer），登录页「以游客身份登录」按钮一键登录
- 记住密码：登录页 checkbox，localStorage `kb-remember`（仅本机明文保存，本地应用可接受）

## 运维注意

- **删除 db 文件的坑**：实例运行中删 `app.db` 会因句柄锁**静默失败**（WAL）→ 残留旧数据。
  正确顺序：先杀 5180/5181 进程 → **立即**删 `data/*.db*` 与 `admin.password` → watchdog 15s 内干净重建
- 备份 = 拷走 `data/app.db` 单文件即可
- 权限设计参考（docs/权限管理设计.md）：Jira 角色/项目授权分离、禅道分组、飞书访客、GitHub 四级权限
