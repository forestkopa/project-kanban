# tools/sync-release.ps1
# 用法（powershell）：
#   $env:GH_PAT = "ghp_xxxx"                      # 需 contents:write 权限的 PAT
#   .\tools\sync-release.ps1                       # 仅滚动 latest（每次普通 push）
#   .\tools\sync-release.ps1 -Version v1.1          # 发版：在滚动 latest 之外，额外打不可变版本号 v1.1
# 功能：推送 main，并把 latest Release 同步到最新提交；可选 -Version 追加一个固定版本号标签 + Release。
# 版本约定：latest 始终滚动指向 main 最新提交；vX.Y 为不可变里程碑（如 v1.0、v1.1），每次发版显式传 -Version。
# 注意：push 直接走带 PAT 的远端 URL；git 路径显式解析（先 Get-Command，失败回退常见路径），
#       避免 PowerShell 子进程下 git 不在 PATH 导致静默 no-op。
param(
    [string]$Version = ''   # 形如 v1.1；为空则只滚动 latest，不打版本号
)

$ErrorActionPreference = 'Continue'

# 解析 git 可执行文件（不依赖 PATH）
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $gitExe) {
    $candidates = @(
        'C:/Program Files/Git/bin/git.exe',
        'C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
        'C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $gitExe = $c; break } }
}
if (-not $gitExe) { Write-Error '找不到 git 可执行文件，请确认已安装 Git 并在 PATH 中'; exit 1 }

$repo    = 'forestkopa/project-kanban'
$pat     = $env:GH_PAT
if (-not $pat) { Write-Error '缺少环境变量 GH_PAT（需 contents:write 权限的 Personal Access Token）'; exit 1 }

$repoRoot = Split-Path -Parent $PSScriptRoot   # 项目根目录（tools 的父目录）
$remote   = "https://$pat@github.com/$repo.git"
$log      = Join-Path $repoRoot 'data/_sync.log'

function Log($m) {
    $s = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Write-Host $s
    try { Add-Content -Path $log -Value $s -Encoding utf8 } catch {}
}
function Invoke-Git {
    param([string[]]$GitArgs)
    $out = & $gitExe @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') 失败（exit $LASTEXITCODE）" }
    return $out
}

$apiHdr = @{
    Authorization          = "Bearer $pat"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Log "=== sync-release 开始（Version='$Version'）==="
Push-Location $repoRoot
try {
    # 1) 推送代码（带 PAT 的 URL，PowerShell 下也能鉴权）
    Log '> git push origin main'
    Invoke-Git push -q $remote main

    # 2) 取最新提交信息
    $sha = (Invoke-Git rev-parse HEAD).Trim()
    $msg = (Invoke-Git log -1 --pretty='%s').Trim()
    Log "  最新提交 $sha : $msg"

    # 3) 移动 latest 标签到该提交（滚动）
    Invoke-Git tag -f latest $sha
    Log '> git push -f origin refs/tags/latest'
    Invoke-Git push -q -f $remote refs/tags/latest

    # 4) 更新 Latest (main) Release 元数据（GitHub REST API）
    $rel   = Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases/tags/latest" -Method Get
    $verLine = if ($Version) { "当前版本：**$Version**`n`n" } else { '' }
    $latestNotes = @"
🚀 本 Release 由 tools/sync-release.ps1 自动同步自 `main` 最新提交。

$verLine- 提交：$sha
- 信息：$msg
- 变更：https://github.com/$repo/commits/main

> `latest` 始终指向 main 最新提交，便于一键获取最新可用代码；各里程碑另有不可变版本号（v1.0、v1.1…）保留历史版本。
"@
    $latestBody = @{
        tag_name   = 'latest'
        name       = 'Latest (main)'
        body       = $latestNotes
        prerelease = $false
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases/$($rel.id)" -Method Patch -Body $latestBody -ContentType 'application/json'
    Log "✅ latest release 已同步到 $sha"

    # 5) 可选：打不可变版本号（里程碑）
    if ($Version) {
        if ($Version -notmatch '^v\d+\.\d+(\.\d+)?$') { throw "版本号格式应为 vX.Y（如 v1.1），收到: $Version" }

        # 5a) 不可变标签（已存在则跳过，不覆盖历史里程碑）
        $tagExists = (Invoke-Git tag -l $Version).Trim()
        if (-not $tagExists) {
            Invoke-Git tag $Version $sha
            Log "> git push origin refs/tags/$Version"
            Invoke-Git push -q $remote "refs/tags/$Version"
        } else {
            Log "⚠ 标签 $Version 已存在，跳过（不可变里程碑不被覆盖）"
        }

        # 5b) 创建/更新该版本 Release
        $verNotes = @"
## 版本 $Version

- 基于提交：$sha
- 提交信息：$msg
- 变更明细：https://github.com/$repo/commits/$sha

> 本版本为**不可变里程碑**；最新可用代码见 `latest` 标签 / `Latest (main)` Release。
"@
        $verBody = @{
            tag_name   = $Version
            name       = $Version
            body       = $verNotes
            prerelease = $false
        } | ConvertTo-Json -Compress
        try {
            $vrel = Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases/tags/$Version" -Method Get
            Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases/$($vrel.id)" -Method Patch -Body $verBody -ContentType 'application/json'
            Log "✅ 版本 Release $Version 已更新"
        } catch {
            Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases" -Method Post -Body $verBody -ContentType 'application/json'
            Log "✅ 版本 Release $Version 已创建"
        }
    }

    Log '=== sync-release 完成 ==='
} catch {
    Log "❌ 失败：$($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}
