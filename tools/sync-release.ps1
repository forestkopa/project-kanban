# tools/sync-release.ps1
# 用法（powershell）：
#   $env:GH_PAT = "ghp_xxxx"                      # 需 contents:write 权限的 PAT
#   .\tools\sync-release.ps1                       # 仅滚动 rolling（每次普通 push）
#   .\tools\sync-release.ps1 -Version v1.1          # 发版：在滚动 rolling 之外，额外打不可变版本号 v1.1
# 功能：推送 main，并把 rolling 标签同步到最新提交 + 刷新 Rolling (main) Release 元数据；可选 -Version 追加一个固定版本号标签 + Release。
# 版本约定：
#   - `rolling` 标签 = 手动滚动指针（始终指向 main 最新提交），对应 `Rolling (main)` Release
#   - `vX.Y` 标签 = 不可变里程碑（一次创建、永久保留），对应同名 GitHub Release
#   - **最新**的 `vX.Y` 会被 GitHub 自动标为 Latest 徽标（无需手动管理）
#   - 之所以用 `rolling` 而非 `latest`：`latest` 是 GitHub 保留词，与内置"Latest release"概念冲突，会导致自定义 release 被 GitHub 自动删除
# 注意：push 直接走带 PAT 的远端 URL；git 路径显式解析（先 Get-Command，失败回退常见路径），
#       避免 PowerShell 子进程下 git 不在 PATH 导致静默 no-op。
param(
    [string]$Version = ''   # 形如 v1.1；为空则只滚动 rolling，不打版本号
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

    # 3) 移动 rolling 标签到该提交（滚动指针；target_commitish=main 始终解析到最新）
    Invoke-Git tag -f rolling $sha
    Log '> git push -f origin refs/tags/rolling'
    Invoke-Git push -q -f $remote refs/tags/rolling

    # 4) 更新 Rolling (main) Release 元数据（GitHub REST API）
    #    GitHub 把 `latest` 视为保留词会删除同名 release，故改用 rolling 标签名
    $rels = Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases?per_page=20" -Method Get
    $rel  = $rels | Where-Object { $_.name -eq 'Rolling (main)' } | Select-Object -First 1
    if (-not $rel) { throw "找不到 'Rolling (main)' Release，请先手动创建或检查权限" }
    $verLine = if ($Version) { "当前版本：**$Version**`n`n" } else { '' }
    $rollingNotes = @"
🚀 本 Release 由 tools/sync-release.ps1 自动同步自 `main` 最新提交。

$verLine- 提交：$sha
- 信息：$msg
- 变更：https://github.com/$repo/commits/main

> `rolling` 标签始终指向 main 最新提交，便于一键获取最新可用代码；各里程碑另有不可变版本号（v1.0、v1.1…）保留历史版本。
> 最新可发布的代码会被 GitHub 自动标为 Latest 徽标（无需手动管理）。
"@
    $rollingBody = @{
        tag_name   = 'rolling'
        name       = 'Rolling (main)'
        body       = $rollingNotes
        target_commitish = 'main'
        prerelease = $false
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Headers $apiHdr -Uri "https://api.github.com/repos/$repo/releases/$($rel.id)" -Method Patch -Body $rollingBody -ContentType 'application/json'
    Log "✅ Rolling (main) release 已同步到 $sha"

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

> 本版本为**不可变里程碑**；最新可用代码见 `rolling` 标签 / `Rolling (main)` Release。
> 注意：**最新发布**的版本会被 GitHub 自动标为 Latest 徽标（无需手动管理）。
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
