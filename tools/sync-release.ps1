# tools/sync-release.ps1
# 用法（powershell）：
#   $env:GH_PAT = "ghp_xxxx"      # 需要 contents:write 权限的 PAT
#   .\tools\sync-release.ps1
# 功能：把当前分支推送到 origin/main，并把名为 latest 的 GitHub Release 同步到最新提交。
# 说明：用本脚本代替裸 `git push`，即可满足“每次 push 同步更新 release”。
$ErrorActionPreference = 'Stop'

$repo = 'forestkopa/project-kanban'
$pat  = $env:GH_PAT
if (-not $pat) { Write-Error '缺少环境变量 GH_PAT（需 contents:write 权限的 Personal Access Token）'; exit 1 }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    # 1) 推送代码
    Write-Host '> git push origin main'
    git push origin main

    # 2) 取最新提交信息
    $sha = (git rev-parse HEAD).Trim()
    $msg = (git log -1 --pretty='%s').Trim()
    Write-Host "  最新提交 $sha : $msg"

    # 3) 移动 latest 标签到该提交
    git tag -f latest $sha
    git push -f origin refs/tags/latest

    # 4) 更新 Release 元数据（GitHub REST API）
    $hdr = @{
        Authorization         = "Bearer $pat"
        Accept                = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $rel  = Invoke-RestMethod -Headers $hdr -Uri "https://api.github.com/repos/$repo/releases/tags/latest" -Method Get
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
    Write-Host "✅ latest release 已同步到 $sha"
} finally {
    Pop-Location
}
