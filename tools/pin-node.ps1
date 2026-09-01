# pin-node.ps1
# Re-point the C:\Users\Administrator\.workbuddy\binaries\node\current junction
# to the newest node version under versions\.
#
# Why: the kanban Windows service (kanban-watchdog) used to hardcode the node
# absolute path in NSSM. When WorkBuddy upgrades node (e.g. 22.22.2 -> 22.22.2-2),
# the old path vanished and the service crashed (%%3). With the stable node\current
# path, just run this once and the service config never needs to change.
#
# NOTE: start-kanban.ps1 now does this repoint automatically on every service start,
# so this standalone script is only a manual fallback.
#
# Usage (admin PowerShell):  .\tools\pin-node.ps1
# This script only touches the junction; it never deletes any node version dir.

$versions = 'C:\Users\Administrator\.workbuddy\binaries\node\versions'
$current  = 'C:\Users\Administrator\.workbuddy\binaries\node\current'

if (-not (Test-Path $versions)) { Write-Error ("node versions dir not found: $versions"); exit 1 }

# Only accept node version dirs shaped like X.Y.Z / X.Y.Z-suffix; skip .locks etc.
$latest = Get-ChildItem -Path $versions -Directory |
          Where-Object { $_.Name -match '^\d+\.\d+\.\d+' } |
          Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending |
          Select-Object -First 1
if (-not $latest) { Write-Error "no node version dir (X.Y.Z) under versions"; exit 1 }

# If current exists: only touch it when it is a junction, to avoid deleting a real dir.
if (Test-Path $current) {
  $item = Get-Item $current -ErrorAction SilentlyContinue
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    [System.IO.Directory]::Delete($current)
    Write-Host ("removed old junction: " + $current)
  } else {
    Write-Error ("$current exists and is not a junction; abort to avoid deleting a real dir")
    exit 1
  }
}

New-Item -ItemType Junction -Path $current -Target $latest.FullName | Out-Null
Write-Host ("OK: node\current -> " + $latest.FullName)
Write-Host ("    node version: " + $latest.Name)
