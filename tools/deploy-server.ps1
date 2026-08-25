# =========================================================
# deploy-server.ps1 - kanban project one-click server deploy
# Target: Windows 11 server. Run AFTER copying the whole project
# folder (incl. node_modules / data / config.yml / tools/nssm-2.24).
# Usage : .\tools\deploy-server.ps1  (Admin PowerShell)
# Safety: backs up data/ first; idempotent; prints rollback cmd.
# =========================================================
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- 0. paths ----------
$Root   = Split-Path -Parent $PSScriptRoot
$Nssm   = Join-Path $Root 'tools\nssm-2.24\win64\nssm.exe'
$Data   = Join-Path $Root 'data'
$Svc    = 'kanban-watchdog'
$Config = Join-Path $Root 'config.yml'
$CfgDir = Join-Path $env:USERPROFILE '.cloudflared'
$Log    = Join-Path $Data 'watchdog-service.log'

Write-Host "== kanban project deploy ==" -ForegroundColor Cyan
Write-Host "Root: $Root"

# ---------- 1. environment checks ----------
if (-not (Test-Path (Join-Path $Root 'server.js'))) { throw "server.js missing - run from project root" }
if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Write-Warning "node_modules missing - run 'npm install' first (or copy it with the folder)" }
if (-not (Test-Path $Nssm)) { throw "tools\nssm-2.24 missing" }

$Node = Join-Path $Root 'node.exe'
if (-not (Test-Path $Node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $Node = $cmd.Source } else { throw "Node.js not found - install Node 22+" }
}
Write-Host "Node: $Node"
& $Node -v | Out-Null
if ($LASTEXITCODE -ne 0) { throw "node not usable" }

# ---------- 2. data backup (rollback point) ----------
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $Root ("data-backup-" + $stamp)
if (Test-Path $Data) {
    Write-Host "Backing up data -> $backup" -ForegroundColor Yellow
    Copy-Item -Recurse -Force $Data $backup
}

# ---------- 3. cloudflared credential + binary ----------
$cfExe = ''
if (Test-Path $Config) {
    $credRef = ''
    $m = Select-String -Path $Config -Pattern 'credentials-file:\s*(.+)'
    if ($m) { $credRef = $m.Matches[0].Groups[1].Value.Trim() }
    if ($credRef -and -not (Test-Path $credRef)) {
        $credName = Split-Path -Leaf $credRef
        New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
        $local = Join-Path $Root ("tools\cloudflared\" + $credName)
        if (-not (Test-Path $local)) { $local = Join-Path $CfgDir $credName }
        if (Test-Path $local) {
            Copy-Item -Force $local (Join-Path $CfgDir $credName)
            $newRef = Join-Path $CfgDir $credName
            (Get-Content $Config -Raw) -replace [regex]::Escape($credRef), $newRef | Set-Content $Config -Encoding ASCII
            Write-Host "Tunnel credential ready: $newRef" -ForegroundColor Green
        } else {
            Write-Warning "Tunnel credential $credName NOT found - copy it from source machine to $CfgDir (public access will be down until fixed)"
        }
    }
    $cfExe = $env:CLOUDFLARED_PATH
    if (-not $cfExe -or -not (Test-Path $cfExe)) { $cfExe = Join-Path $Root 'tools\cloudflared\cloudflared.exe' }
    if (-not (Test-Path $cfExe)) {
        $cc = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($cc) { $cfExe = $cc.Source }
    }
    if (Test-Path $cfExe) { Write-Host "cloudflared: $cfExe" }
    else { Write-Warning "cloudflared.exe NOT found - public tunnel disabled; copy it to $Root\tools\cloudflared\ or set CLOUDFLARED_PATH" }
}

# ---------- 4. NSSM service (idempotent) ----------
& $Nssm stop $Svc 2>$null | Out-Null
Start-Sleep -Milliseconds 800
& $Nssm remove $Svc confirm 2>$null | Out-Null
Start-Sleep -Milliseconds 800

Write-Host "Registering service $Svc ..."
& $Nssm install $Svc $Node (Join-Path $Root 'watchdog.js') | Out-Null
if ($LASTEXITCODE -ne 0) { throw "NSSM install failed" }
& $Nssm set $Svc AppDirectory $Root | Out-Null
& $Nssm set $Svc AppStdout $Log | Out-Null
& $Nssm set $Svc AppStderr $Log | Out-Null
& $Nssm set $Svc AppRotateFiles 1 | Out-Null
& $Nssm set $Svc AppRotateBytes 1048576 | Out-Null
& $Nssm set $Svc AppExit Default Restart | Out-Null
if ($cfExe -and (Test-Path $cfExe)) {
    & $Nssm set $Svc AppEnvironmentExtra "CLOUDFLARED_PATH=$cfExe" | Out-Null
}

# ---------- 5. start & verify ----------
& $Nssm start $Svc | Out-Null
Start-Sleep -Seconds 5
$st = (& $Nssm status $Svc | Out-String).Trim()
Write-Host "Service status: $st" -ForegroundColor Cyan

Write-Host ""
Write-Host "== Verify ==" -ForegroundColor Cyan
foreach ($port in 5180, 5181) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/readonly" -TimeoutSec 5
        Write-Host "  local :$port -> HTTP $($r.StatusCode) $($r.Content)" -ForegroundColor Green
    } catch { Write-Warning "  local :$port -> no response yet (may still be starting; retry in a few seconds)" }
}
if ($cfExe -and (Test-Path $cfExe)) {
    Start-Sleep -Seconds 12
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "https://kanban.forestkopa.top/api/readonly" -TimeoutSec 10
        Write-Host "  public kanban.forestkopa.top -> HTTP $($r.StatusCode) $($r.Content)" -ForegroundColor Green
    } catch { Write-Warning "  public not ready yet (tunnel handshake may take a moment; verify in browser later)" }
}

Write-Host ""
Write-Host "== DONE ==" -ForegroundColor Green
Write-Host "Open: https://kanban.forestkopa.top  (or local http://127.0.0.1:5181)"
Write-Host "Log : $Log"
Write-Host "Bak : $backup"
Write-Host ""
Write-Host "Rollback: nssm stop $Svc ; xcopy $backup\* $Data\ /E /Y ; nssm start $Svc" -ForegroundColor Yellow
