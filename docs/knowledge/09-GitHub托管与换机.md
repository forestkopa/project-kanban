---
title: GitHub 托管与换机
tags:
category: skills
summary: 私有仓库托管、敏感文件 gitignore 清单、换机重配项、遗留死文件与常用 git 命令。 [看板, git, 运维, 安全]
date: 2026-08-21
status: 已确认
related: [[00-知识地图(MOC)], [01-部署与双实例]]
---

# GitHub 托管与换机

## 仓库

- GitHub 私有仓库：https://github.com/forestkopa/project-kanban（分支 main）
- 推送用 HTTPS + PAT；敏感文件绝不入库。

## 敏感文件（.gitignore 已排除）

排除：`data/ai.json`（AI Key）、`data/auth.token`、`data/tunnel-url.txt`、`data/tunnel.log`、`data/options.json`、`public/brand-logo.png`。

**换机后需重配**：AI Key（页面「AI 设置」）、token、隧道地址、options.json。

## 待办 / 遗留

- `data/mappings.json`：映射功能已删的死文件，仍在 git 跟踪，建议 `git rm` 清理。
- `data/projects.json`：真实模式数据文件（含真实项目名），被 git 跟踪推送（私有仓库风险可控）；若不想入库需 `git rm --cached` + gitignore。
- 前端未做浏览器级可视回归验证，主要靠接口 + 源码验证。

## 常用命令

```bash
node --check server.js && node --check public/app.js     # 语法检查
curl http://localhost:5180/api/readonly                    # demo:true 即就绪
curl http://localhost:5180/api/projects                    # 项目数据
git add ... && git commit -m "..." && git push origin main # 提交推送
git checkout -- data/projects.demo.json                    # 清理 demo 数据污染（行尾符 M 差异直接还原）
```

## 发版一页流程（v1.5.4 起固化）

> 铁律：**任何 push 前必须用户本人明确点头**（用户原话「每天推送到 github 要我同意才可以推送」）。

0. 改 `package.json` 版本 + `CHANGELOG.md` 写章节（Release body 就取这一节）。
1. **本地全量测试绿**：`node test/run-all.cjs`（含覆盖自检，漏跑文件会 code=1）。
2. 打包升级包：`python tools/build_update_zip.py` → `~/Downloads/kanban/project-kanban-update.zip`（自检「关键文件齐全/不含 data/」）。
3. 提交并推：`git push origin main` → `git push origin vX.Y.Z` → `git push -f origin vX.Y.Z:latest`。
   - 本机代理偶发 `CONNECT tunnel failed, response 502` / schannel 握手失败 → **重试即可**，重试后用 `git ls-remote --tags origin` 确认远端真实状态，别信单次报错。
4. **发 Release 并挂 update.zip**：`node tools/release-gh.cjs vX.Y.Z "<zip 路径>"`。
   - ⚠️ **`tools/sync-release.ps1` 只建 Release（body 还是占位模板）且不挂附件** —— 本项目纪律是「每个 Release 必挂 update.zip」（服务器在线升级要下载它），所以必须再跑 `release-gh.cjs` 补 body + 附件。
   - body 由脚本**直接读 CHANGELOG 该版本章节**，Node 直读直传 UTF-8；历史上经 `json.dumps`（默认 `ensure_ascii`）中转导致 Release 页中文乱码，勿走那条路。
   - 幂等：Release 已存在则 PATCH，同名附件先删再传，可安全重跑。
5. 校验（别只看脚本输出）：Release API 查 `assets[].state === 'uploaded'`、size 对得上；再对 asset 发 `Range: bytes=0-3` 请求，返回 `206` + `504b0304`（PK 魔数）才算真能下载。
6. 服务器升级：在线点「一键升级」（已 ≥ v1.5.3 时可用），或 `tools/local-upgrade.ps1 -Zip "<zip>"` 离线兜底。升级包地址：`https://github.com/forestkopa/project-kanban/releases/download/vX.Y.Z/project-kanban-update.zip`。

## 延伸

- 双实例部署见 [[01-部署与双实例]]
- 知识库本篇是 [[00-知识地图(MOC)]] 的叶子节点；回家 clone 后用 Obsidian 打开 `docs/knowledge/` 即成本地 wiki。
