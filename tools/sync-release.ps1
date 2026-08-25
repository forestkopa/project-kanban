# tools/sync-release.ps1
# 用法（powershell）：
#   $env:GH_PAT = "ghp_xxxx"      # 需要 contents:write 权限的 PAT
#   .\tools\sync-release.ps1
# 功能：把当前分支推送到 origin/main，并把名为 latest 的 GitHub Release 同步到最新提交。
# 说明：用本脚本代替裸 `git push`，即可满足“每次 push 同步更新 release”。
# 注意：
#   - push 直接走带 PAT 的远端 URL，避免 PowerShell 子进程下 git 凭据助手不可用导致静默失败。
#   - 所有 git 调用统一走 Invoke-Git（重定向 stderr，按退出码判断是否失败），
#     避免 PowerShell 因 git 进度信息（stderr）误判为终止错误而中断后续步骤。
$ErrorActionPreference = 'Continue'

$repo    = 'forestkopa/project-kanban'
$pat     = $env:GH_PAT
if (-not $pat) { Write-Error '缺少环境变量 GH_PAT（需 contents:write 权限的 Personal Access Token）'; exit 1 }

$repoRoot = Split-Path -Parent $PSScriptRoot   # 项目根目录（tools 的父目录）
$remote   = "https://$pat@github.com/$repo.git"
$log      = Join-Path $repoRoot 'data/_sync.log'

function Log($m) { $s = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Host $s; try { Add-Content -Path $log -Value $s -Encoding utf8 } catch {} }
function Invoke-Git {
    param([string[]]$GitArgs)
    $out = & git @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') 失败（exit $LASTEXITCODE）" }
    return $out
}

Log "=== sync-release 开始（repoRoot=$repoRoot）==="
Push-Location $repoRoot
try {
    # 1) 推送代码（带 PAT 的 URL，PowerShell 下也能鉴权）
    Log '> git push origin main'
    Invoke-Git push -q $remote main

    # 2) 取最新提交信息
    $sha = (Invoke-Git rev-parse HEAD).Trim()
    $msg = (Invoke-Git log -1 --pretty='%s').Trim()
    Log "  最新提交 $sha : $msg"

    # 3) 移动 latest 标签到该提交
    Invoke-Git tag -f latest $sha
    Log '> git push -f origin refs/tags/latest'
    Invoke-Git push -q -f $remote refs/tags/latest

    # 4) 更新 Release 元数据（GitHub REST API）
    $hdr = @{
        Authorization          = "Bearer $pat"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $rel   = Invoke-RestMethod -Headers $hdr -Uri "https://api.github.com/repos/$repo/releases/tags/latest" -Method Get
    $notes = @"
🚀 本 Release 由 tools/sync-release.ps1 自动同步自 `main` 最新提交。

- 提交：$sha
- 信息：$msg
- 变更：https://github.com/$repo/commits/main

> 历史语义标签（如 v1.0）作为里程碑保留；`latest` 始终指向 main 最新提交，便于一键获取最新可用代码。
"@
    $body = @{
        tag_name   = 'latest'
        name       = 'Latest (main)'
        body       = $notes
        prerelease = $false
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Headers $hdr -Uri "https://api.github.com/repos/$repo/releases/$($rel.id)" -Method Patch -Body $body -ContentType 'application/json'
    Log "✅ latest release 已同步到 $sha"
} catch {
    Log "❌ 失败：$($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}
