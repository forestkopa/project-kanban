---
title: GitHub 托管与换机
tags: [看板, git, 运维, 安全]
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

## 延伸

- 双实例部署见 [[01-部署与双实例]]
- 知识库本篇是 [[00-知识地图(MOC)]] 的叶子节点；回家 clone 后用 Obsidian 打开 `docs/knowledge/` 即成本地 wiki。
