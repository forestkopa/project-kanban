# =========================================================
# package.ps1 - build deployment zips for kanban project
# Produces two artifacts in $OutDir:
#   project-kanban-deploy.zip  (WITH data/  - first install only)
#   project-kanban-update.zip  (NO data/    - all subsequent updates)
# Uses built-in robocopy + Compress-Archive (no Python needed).
# Usage: .\tools\package.ps1 [-OutDir C:\path]
# =========================================================
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'Downloads\kanban')
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Name = 'project-kanban'

# dirs/files to exclude from BOTH packages
$ExcludeDirs = @('.git', '.workbuddy', 'backups', 'deploy', 'data-backup*')
$ExcludeFiles = @('*.log', '*.tmp', '*.new')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$tmp = Join-Path $env:TEMP ("kb-pack-" + [guid]::NewGuid().ToString('N'))

function New-Package {
  param([string]$Label, [switch]$IncludeData)
  $stage = Join-Path $tmp $Label
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $xd = $ExcludeDirs
  if (-not $IncludeData) { $xd += 'data' }
  # robocopy: /E copy subdirs incl empty; /XD exclude dirs; /XF exclude files; /NFL /NDL /NJH /NJS quiet
  & robocopy $Root $stage /E /XD $xd /XF $ExcludeFiles /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (code $LASTEXITCODE)" }
  $zip = Join-Path $OutDir "$Name-$Label.zip"
  # Compress-Archive keeps the top folder name = staging dir name; rename to project-kanban
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
  $sz = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "  $zip  ($sz MB, data=$(if ($IncludeData) {'yes'} else {'NO'}))" -ForegroundColor Green
}

Write-Host "== kanban package build ==" -ForegroundColor Cyan
Write-Host "Source: $Root"
Write-Host "OutDir: $OutDir"
try {
  New-Package -Label 'deploy' -IncludeData
  New-Package -Label 'update'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "== done ==" -ForegroundColor Cyan
Write-Host "  deploy.zip -> FIRST install on server (contains data/)"
Write-Host "  update.zip -> ALL updates (server data/ is NEVER overwritten)"
