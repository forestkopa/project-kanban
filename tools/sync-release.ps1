# tools/sync-release.ps1
# 用法（powershell）：
#   $env:GH_PAT = "ghp_xxxx"                      # 需 contents:write 权限的 PAT
#   .\tools\sync-release.ps1                       # 仅推送 main（普通 push，不改版本/标签）
#   .\tools\sync-release.ps1 -Version v1.2          # 发版：打不可变版本号 v1.2 + 把 latest 标签滚动到该提交
# 版本约定（2026-08-25 确定，用户要求）：
#   - `latest` 标签 = 移动指针，始终指向「当前最大版本号」对应的提交（如当前 v1.1）。
#     发布更高版本（如 v1.2）后，`latest` 标签移动到新提交，旧版本（v1.1）即不再带 latest。
#   - `vX.Y` 标签 = 不可变里程碑（一次创建、永久保留），对应同名 GitHub Release（含变更说明）。
#   - GitHub 的 "Latest" 徽标：被 GitHub 自动赋予「最新发布的 release」，即当前最大版本号
#     （v1.1 -> 发布 v1.2 后自动切换），无需手动管理。
#   - 不使用单独的「rolling」release；latest 即最大版本号，概念统一、避免与 GitHub 保留词冲突。
# 注意：push 走带 PAT 的远端 URL；git 路径显式解析（先 Get-Command，失败回退常见路径），
#       避免 PowerShell 子进程下 git 不在 PATH 导致静默 no-op。
param(
    [string]$Version = ''   # 形如 v1.2；为空则只推送 main，不动版本号/latest
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

    if ($Version) {
        if ($Version -notmatch '^v\d+\.\d+(\.\d+)?$') { throw "版本号格式应为 vX.Y（如 v1.2），收到: $Version" }

        # 3) 不可变版本标签（已存在则跳过，不覆盖历史里程碑）
        $tagExists = (Invoke-Git tag -l $Version).Trim()
        if (-not $tagExists) {
            Invoke-Git tag $Version $sha
            Log "> git push origin refs/tags/$Version"
            Invoke-Git push -q $remote "refs/tags/$Version"
            Log "✅ 已打不可变标签 $Version ($sha)"
        } else {
            Log "⚠ 标签 $Version 已存在，跳过（不可变里程碑不被覆盖）"
        }

        # 4) 移动 latest 标签到该提交（latest = 当前最大版本号）
        Invoke-Git tag -f latest $sha
        Log '> git push -f origin refs/tags/latest'
        Invoke-Git push -q -f $remote refs/tags/latest
        Log "✅ latest 标签已滚动到 $Version ($sha)；旧版本不再带 latest"

        # 5) 创建/更新该版本 Release（含变更说明模板）
        $verNotes = @"
## 版本 $Version

- 基于提交：$sha
- 提交信息：$msg
- 变更明细：https://github.com/$repo/commits/$sha

### 本版本主要更新
> 请在本发布页补充相对上一版本（如 v1.1）的主要变更说明。

> 本版本为**不可变里程碑**；`latest` 标签已自动滚动到本版本，GitHub 也会将本 release 标为 Latest。
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
    } else {
        Log '（普通 push：未指定 -Version，版本号与 latest 标签保持不变）'
    }

    Log '=== sync-release 完成 ==='
} catch {
    Log "❌ 失败：$($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}
