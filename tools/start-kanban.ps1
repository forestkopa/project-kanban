# start-kanban.ps1
# Kanban Windows service (kanban-watchdog) launcher wrapper.
# On EVERY service start (incl. boot), it first re-points the node\current
# junction to the newest node version under versions\, then launches watchdog.js
# in the foreground. This makes the service self-heal after WorkBuddy upgrades node,
# so no manual pin-node.ps1 run is ever needed.
#
# NSSM config (applied by this deployment):
#   Application      = C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
#   AppParameters    = -NoProfile -ExecutionPolicy Bypass -File "<proj>\tools\start-kanban.ps1"
#   AppEnvironmentExtra = KANBAN_NO_TUNNEL=1
# (Dev machine only serves localhost:5180 + 5181 and never hijacks the public tunnel.)

$ErrorActionPreference = 'Stop'

$nodeBase = 'C:\Users\Administrator\.workbuddy\binaries\node'
$versions = Join-Path $nodeBase 'versions'
$current  = Join-Path $nodeBase 'current'
$project  = 'C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban'

# --- 1. Re-point node\current to the newest node version (only X.Y.Z dirs, skip .locks etc) ---
if (Test-Path $versions) {
  $latest = Get-ChildItem -Path $versions -Directory |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+' } |
            Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending |
            Select-Object -First 1
  if ($latest) {
    $needRebuild = $false
    if (Test-Path $current) {
      $it = Get-Item $current -ErrorAction SilentlyContinue
      if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($it.Target -ne $latest.FullName) { $needRebuild = $true }
      } else {
        Write-Warning ("$current is a real dir and not the latest; skip auto-repoint. Switch manually if needed.")
      }
    } else {
      $needRebuild = $true
    }
    if ($needRebuild) {
      try { [System.IO.Directory]::Delete($current) } catch { }
      New-Item -ItemType Junction -Path $current -Target $latest.FullName | Out-Null
      Write-Host ("[start-kanban] node\current re-pointed -> " + $latest.Name)
    } else {
      Write-Host ("[start-kanban] node\current already latest (" + $latest.Name + "), no repoint needed")
    }
  } else {
    Write-Warning ("No node version dir (X.Y.Z) under $versions; skip repoint")
  }
} else {
  Write-Warning ("node versions dir not found: $versions")
}

$nodeExe = Join-Path $current 'node.exe'
if (-not (Test-Path $nodeExe)) {
  Write-Error ("node exe not found: $nodeExe (node\current junction may be dangling)")
  exit 1
}

# --- 2. Env safety: dev machine never takes over the public tunnel ---
$env:KANBAN_NO_TUNNEL = '1'

# --- 3. Launch watchdog.js in foreground; clean up children on exit ---
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.Arguments              = 'watchdog.js'
$psi.WorkingDirectory       = $project
$psi.UseShellExecute        = $false
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError  = $false

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

$cleanup = {
  try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanup | Out-Null

if (-not $proc.Start()) {
  Write-Error 'watchdog.js failed to start'
  exit 1
}
Write-Host ("[start-kanban] watchdog.js started PID=" + $proc.Id)

$proc.WaitForExit()
Write-Host ("[start-kanban] watchdog.js exited, code=" + $proc.ExitCode)
exit $proc.ExitCode
