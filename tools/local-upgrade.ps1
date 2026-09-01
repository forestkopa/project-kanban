<#
.SYNOPSIS
  本地离线升级看板（绕过 GitHub CDN 与前端 fetch 超时）
.DESCRIPTION
  用法（在生产服务器上执行）：
    1. 把 project-kanban-update.zip 拷到服务器任意目录（如 D:\upgrade\）
    2. 以管理员身份打开 PowerShell，cd 到看板项目根目录，运行：
       powershell -ExecutionPolicy Bypass -File tools\local-upgrade.ps1 -Zip "D:\upgrade\project-kanban-update.zip"
  脚本会：备份当前 data → 解压覆盖（排除 data/ config.yml）→ 重启 kanban-watchdog 服务。
  不依赖网络、不依赖前端，纯本地文件操作，秒级完成。
#>
param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [string]$Root = (Get-Location).Path,
  [string]$Service = 'kanban-watchdog'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Zip)) { Write-Error "找不到 update.zip: $Zip"; exit 1 }
if (-not (Test-Path (Join-Path $Root 'server.js'))) { Write-Error "Root 不是看板项目根目录（找不到 server.js）: $Root"; exit 1 }

# 1. 备份 data（不含 node_modules/.git）
$ts = (Get-Date).ToString('yyyy-MM-dd-HHmmss')
$bak = Join-Path $Root ("data-backup-upgrade-" + $ts)
Write-Host "==> 备份当前 data 到 $bak"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
$argsB = @((Join-Path $Root 'data'), $bak, '/E', '/XD', 'node_modules', '.git', '.workbuddy', 'backups', 'data-backup-*', 'upgrade-tmp-*', '/XF', '*.log', '*.tmp', '*.zip', '*.patch', '/NFL', '/NDL', '/NJH', '/NJS')
& robocopy @argsB | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Warning "robocopy 备份退出码 $LASTEXITCODE（0-7 视为成功）" }

# 2. 解压覆盖（保留 data/ 与 config.yml）
Write-Host "==> 解压覆盖 $Zip -> $Root（保留 data/ 与 config.yml）"
$skip = @('data', 'config.yml')
$tmp = Join-Path $env:TEMP ("kb-ux-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force
# 复制除 data/ 与 config.yml 外的全部内容
Get-ChildItem $tmp | Where-Object { $_.Name -notin $skip } | ForEach-Object {
  $dest = Join-Path $Root $_.Name
  if ($_.PSIsContainer) { robocopy $_.FullName $dest /E /NFL /NDL /NJH /NJS | Out-Null }
  else { Copy-Item $_.FullName $dest -Force }
}
# 处理 zip 内 data/ 下的非用户文件（如有）：仅覆盖结构，不动用户库。默认不动 data/。
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

# 3. 重启服务
Write-Host "==> 重启服务 $Service"
Restart-Service $Service -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$up = (Get-Service $Service -ErrorAction SilentlyContinue).Status
Write-Host "==> 完成。服务状态: $up 。请在浏览器硬刷新查看新版本（侧栏版本号应为 v1.4.4）。"
Write-Host "    若需回滚：用 $bak 目录覆盖回 data/ 即可。"
