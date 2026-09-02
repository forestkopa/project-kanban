<#
.SYNOPSIS
  本地离线升级看板（v1.4.7-hotfix1：移除所有可能触发 Windows PowerShell 5.1 解析歧义的同行 if / Write-Verbose / 多行 {})
.DESCRIPTION
  用法（在生产服务器上执行）：
    1. 把 project-kanban-update.zip 拷到服务器任意目录（如 D:\upgrade\）
    2. 以管理员身份打开 PowerShell，cd 到看板项目根目录，运行：
       powershell -ExecutionPolicy Bypass -File tools\local-upgrade.ps1 -Zip "D:\upgrade\project-kanban-update.zip"
  脚本会：备份当前 data → 解压覆盖（排除 data/ config.yml）→ 重启 kanban-watchdog 服务。
  所有 if 判断一律换行写，避免 PS 5.1 token 解析歧义；没有任何同行 -Verbose / 同行 { } 的写法。
#>
param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [string]$Root = (Get-Location).Path,
  [string]$Service = 'kanban-watchdog'
)

$ErrorActionPreference = 'Stop'

# 0. 参数校验（拆开成两行，不用同行 if）
$zipOk = Test-Path $Zip
if (-not $zipOk)
{
  Write-Error ("找不到 update.zip: " + $Zip)
  exit 1
}
$rootOk = Test-Path (Join-Path $Root 'server.js')
if (-not $rootOk)
{
  Write-Error ("Root 不是看板项目根目录（找不到 server.js）: " + $Root)
  exit 1
}

# 1. 备份 data（不含 node_modules/.git）
$ts = (Get-Date).ToString('yyyy-MM-dd-HHmmss')
$bak = Join-Path $Root ("data-backup-upgrade-" + $ts)
Write-Host ("==> 备份当前 data 到 " + $bak)
New-Item -ItemType Directory -Force -Path $bak | Out-Null
$argsB = @((Join-Path $Root 'data'), $bak, '/E', '/XD', 'node_modules', '.git', '.workbuddy', 'backups', 'data-backup-*', 'upgrade-tmp-*', '/XF', '*.log', '*.tmp', '*.zip', '*.patch', '/NFL', '/NDL', '/NJH', '/NJS')
& robocopy @argsB | Out-Null
# robocopy 的 $LASTEXITCODE：0-7 都算成功，只有 8+ 才是异常（拆开判断）
$bcExit = $LASTEXITCODE
if ($bcExit -ge 8)
{
  Write-Warning ("robocopy 备份退出码 " + $bcExit + "（0-7 视为成功）")
}

# 2. 解压覆盖（保留 data/ 与 config.yml）
Write-Host ("==> 解压覆盖 " + $Zip + " -> " + $Root + "（保留 data/ 与 config.yml）")
$skip = @('data', 'config.yml')
$tmp = Join-Path $env:TEMP ("kb-ux-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force
# 复制除 data/ 与 config.yml 外的全部内容（拆开判断，不要同行 if）
Get-ChildItem $tmp | Where-Object { $_.Name -notin $skip } | ForEach-Object {
  $dest = Join-Path $Root $_.Name
  $isDir = $_.PSIsContainer
  if ($isDir)
  {
    robocopy $_.FullName $dest /E /NFL /NDL /NJH /NJS | Out-Null
  }
  else
  {
    Copy-Item $_.FullName $dest -Force
  }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

# 3. 重启服务（需管理员权限；失败要明确提示，不能静默吞掉）
Write-Host ("==> 重启服务 " + $Service)
$restarted = $false
$restartError = $null
try
{
  Restart-Service $Service -Force -ErrorAction Stop
  $restarted = $true
}
catch
{
  $restartError = $_.Exception.Message
  Write-Warning ("服务重启失败（多半未以管理员身份运行）：" + $restartError)
  Write-Host ("    请右键 PowerShell →「以管理员身份运行」后重跑本脚本，或手动：Restart-Service " + $Service + " -Force")
}
Start-Sleep -Seconds 3
$svc = Get-Service $Service -ErrorAction SilentlyContinue
$up = if ($svc) { $svc.Status } else { 'NotFound' }
# 版本号动态读取，避免写死后误导
$newVer = 'unknown'
try
{
  $pkgPath = Join-Path $Root 'package.json'
  $pkgRaw = Get-Content $pkgPath -Raw -ErrorAction Stop
  $pkgObj = $pkgRaw | ConvertFrom-Json -ErrorAction Stop
  $newVer = $pkgObj.version
}
catch
{
}
$restartTxt = if ($restarted) { '成功' } else { '未执行/失败' }
Write-Host ("==> 完成。目标版本 v" + $newVer + " ；服务状态: " + $up + " ；重启: " + $restartTxt + "。")
Write-Host ("    浏览器硬刷新（Ctrl+F5）后，侧栏底部版本号应为 v" + $newVer + "。")
Write-Host ("    若需回滚：用 " + $bak + " 目录覆盖回 data/ 即可。")
