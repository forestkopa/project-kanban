# 极空间 NAS 部署（systemd 版）

生产环境 = 极空间 NAS 上的 Ubuntu VM（24h 在线），公网地址 `https://kanban.forestkopa.top`。
本机（Windows）只保留开发调试（watchdog.js 已去掉隧道守护）。

## 0. 目录规划

| 路径 | 内容 |
|---|---|
| `/opt/project-kanban/` | 代码 + 数据（git clone） |
| `/opt/project-kanban/data/app.db` | **SQLite 数据库（从本机拷贝，含用户/项目）** |
| `/opt/project-kanban/config.yml` | 隧道配置（**需改 credentials-file 路径**） |
| `/home/kanban/.cloudflared/2bbff070-ae42-4d5b-b846-744c999a2dfc.json` | 隧道凭据（从本机拷贝） |
| `/etc/systemd/system/kanban*.service`、`cloudflared.service` | 三个服务 |

## 1. 建 Ubuntu VM

极空间应用中心安装「虚拟机」→ Ubuntu 22.04 LTS，建议 2 核 / 4G / 50G 盘。

```bash
sudo apt update && sudo apt install -y curl git
# Node 18+（Ubuntu 自带 12 太旧，用 nodesource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应 >= 18
```

## 2. 建专用用户 + 拉代码（需 GitHub PAT）

```bash
sudo useradd -m -s /bin/bash kanban
sudo mkdir -p /opt/project-kanban && sudo chown kanban:kanban /opt/project-kanban

# 用 PAT 克隆私有仓库（PAT 在 GitHub → Settings → Developer settings → Personal access tokens，
# 选 Fine-grained，只授权本仓库的 Contents: Read/Write）
sudo -u kanban git clone https://<你的用户名>:<PAT>@github.com/forestkopa/project-kanban.git /opt/project-kanban
```

> PAT 会留在 git remote 里。建议用 credential helper 或 SSH key 代替；图省事直接放 URL 也行（本机私有仓库）。

## 3. 安装依赖 + 拷贝数据/隧道凭据

```bash
cd /opt/project-kanban && sudo -u kanban npm install
# xlsx / xlsx-js-style 是运行时依赖（若 package.json 已声明则无需手动装）

# 隧道凭据：从本机拷到 NAS（scp 或 U盘）
# 本机路径: C:/Users/Administrator/.cloudflared/2bbff070-ae42-4d5b-b846-744c999a2dfc.json
sudo mkdir -p /home/kanban/.cloudflared
sudo cp 2bbff070-ae42-4d5b-b846-744c999a2dfc.json /home/kanban/.cloudflared/
sudo chown -R kanban:kanban /home/kanban/.cloudflared
```

## 3.1 数据库（SQLite）—— 关键！带现有数据上 NAS

> 账号（admin/guest）、角色、项目、任务都存在 `data/app.db`（不进 git）。**必须把本机的库拷过去**，
> 否则 NAS 会是全新空库（只剩 projects.json 迁移的 7 个种子项目，且无用户体系）。

```bash
# 从本机拷贝（本机路径 C:/Users/Administrator/WorkBuddy/.../project-kanban/data/app.db，
# 或用完整快照 app-backup-YYYYMMDD.db 改名为 app.db 拷贝）
sudo mkdir -p /opt/project-kanban/data
sudo cp app.db /opt/project-kanban/data/app.db
sudo chown kanban:kanban /opt/project-kanban/data/app.db

# 验证库内数据（应显示 admin/guest 用户 + 7 个项目）
sudo -u kanban node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/opt/project-kanban/data/app.db');console.log(d.prepare('SELECT name,role FROM users').all());console.log('projects:',d.prepare('SELECT COUNT(*) c FROM projects').get().c);"
```

> 启动逻辑自动适配：`app.db` 已存在且含 admin/项目 → `ensureAdminAndMigrate` 检测到已有数据，**不会重复建号/导入**。
> 备份：日常把 `data/app.db` 拷走即可（或定期执行 `VACUUM INTO` 生成干净单文件快照）。

## 4. 修改 config.yml（关键！）

Windows 上的 config.yml 里 `credentials-file` 是 Windows 路径，**必须改成 Linux 路径**：

```yaml
tunnel: 2bbff070-ae42-4d5b-b846-744c999a2dfc
credentials-file: /home/kanban/.cloudflared/2bbff070-ae42-4d5b-b846-744c999a2dfc.json
ingress:
  - service: http://localhost:5181
```

## 5. 安装 cloudflared + 三个服务

```bash
# 安装 cloudflared（官方 deb）
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
which cloudflared   # 确认路径，若不是 /usr/local/bin/cloudflared，改 cloudflared.service 里的 ExecStart

# 拷贝 systemd unit 并启用
sudo cp /opt/project-kanban/deploy/kanban.service /opt/project-kanban/deploy/kanban-demo.service /opt/project-kanban/deploy/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kanban kanban-demo cloudflared
```

## 6. git 自动提交认证（NAS 正式版落盘自动 commit）

server.js 正式版每次落盘会 `git commit`。NAS 上 clone 用的 PAT 已在 remote 里，push 需要额外认证：

```bash
# 方式A（最简单）：每 15 分钟自动 push（配合 data 目录变更）
sudo -u kanban bash -c 'git config --global credential.helper store'
# 第一次手动 push 时输入 PAT，之后记住
```

或加一个定时任务（crontab -e）：

```
*/10 * * * * cd /opt/project-kanban && git push origin master 2>/dev/null
```

> 只 push 不 pull：数据以 NAS 为准；本机开发用拉取即可（`git pull -X theirs`）。

## 7. 验证

```bash
systemctl status kanban kanban-demo cloudflared     # 三个都 active
curl -s http://127.0.0.1:5180 -o /dev/null -w "%{http_code}\n"   # 200
curl -s http://127.0.0.1:5181 -o /dev/null -w "%{http_code}\n"   # 200
```

然后**关掉本机**，用手机流量访问 `https://kanban.forestkopa.top` —— 能开即成功。

## 8. 日常

- 改代码：本机 git clone → 改 → push → NAS 上 `cd /opt/project-kanban && git pull`
- **备份**：NAS 上数据在 `data/app.db`（SQLite，含用户/角色/项目/任务）——定期拷走该文件即可；
  更稳的快照：`sudo -u kanban node -e "const {DatabaseSync,backup}=require('node:sqlite');const d=new DatabaseSync('/opt/project-kanban/data/app.db');backup(d,'/opt/project-kanban/data/backup-$(date +%Y%m%d).db').then(()=>console.log('ok'))"`
- 登录：NAS 首启若用带数据的 app.db → 原账号密码照常；全新库 → admin / 000000
- 唯一不可用时刻：家里停电/断网/极空间关机
