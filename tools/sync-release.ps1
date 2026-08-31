# tools/sync-release.ps1
# 用法（powershell）：
#   .\tools\sync-release.ps1                       # 仅推送 main（普通 push，不改版本/标签）
#   .\tools\sync-release.ps1 -Version v1.2          # 发版：打不可变版本号 v1.2 + 把 latest 标签滚动到该提交
#   .\tools\sync-release.ps1 -Force                  # 跳过交互确认（仅当用户已明确批准推送时使用）
# 鉴权：无需手动设 GH_PAT。脚本优先用 $env:GH_PAT，缺省时自动读取
#       ~/.git-credentials（credential.helper=store 已缓存的 PAT）；push 走 git 自带凭据，最稳。
# 版本约定（2026-08-25 确定，用户要求）：
#   - `latest` 标签 = 移动指针，始终指向「当前最大版本号」对应的提交（如当前 v1.1）。
#     发布更高版本（如 v1.2）后，`latest` 标签移动到新提交，旧版本（v1.1）即不再带 latest。
#   - `vX.Y` 标签 = 不可变里程碑（一次创建、永久保留），对应同名 GitHub Release（含变更说明）。
#   - GitHub 的 "Latest" 徽标：被 GitHub 自动赋予「最新发布的 release」，即当前最大版本号
#     （v1.1 -> 发布 v1.2 后自动切换），无需手动管理。
#   - 不使用单独的「rolling」release；latest 即最大版本号，概念统一、避免与 GitHub 保留词冲突。
# 注意：push 默认走 git 自带凭据（credential.helper=store 已缓存的 PAT），不再把 PAT 拼进远端 URL，最稳；
#       git 路径显式解析（先 Get-Command，失败回退常见路径），避免 PowerShell 子进程下 git 不在 PATH 导致静默 no-op。
param(
    [string]$Version = '',  # 形如 v1.2；为空则只推送 main，不动版本号/latest
    [switch]$Force          # 跳过交互确认（仅当用户已明确批准推送后、由脚本/自动化显式传入）
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
$repoRoot = Split-Path -Parent $PSScriptRoot   # 项目根目录（tools 的父目录）
$log      = Join-Path $repoRoot 'data/_sync.log'

# 解析 GitHub token（仅用于 Release API；push 默认走 git 自带凭据 store，最稳）。
# 优先级：$env:GH_PAT → ~/.git-credentials（credential.helper=store 已缓存的 PAT）。
$pat = $env:GH_PAT
if (-not $pat) {
    $storeFile = Join-Path $env:USERPROFILE '.git-credentials'
    if (Test-Path $storeFile) {
        $line = Select-String -Path $storeFile -Pattern 'github\.com' | Select-Object -First 1
        if ($line) {
            $m = [regex]::Match($line.Line, 'https://[^:]+:([^@\r\n]+)@github\.com')
            if ($m.Success) { $pat = $m.Groups[1].Value.Trim() }
        }
    }
}
if (-not $pat) {
    Log '⚠ 未找到 GH_PAT（环境变量或 git store），Release 创建将跳过；push 依赖 git 自带凭据'
}

function Log($m) {
    $s = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Write-Host $s
    try { Add-Content -Path $log -Value $s -Encoding utf8 } catch {}
}
function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$GitArgs)
    # 用 Process 对象分离 stdout/stderr，避免 PowerShell 把 git 的 stderr（如
    # "Everything up-to-date"）当成 NativeCommandError 喷屏，也避免混流污染提取结果。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $gitExe
    $psi.Arguments = ($GitArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
    }) -join ' '
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $repoRoot
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) {
        $err = $stderr.Trim()
        throw "git $($GitArgs -join ' ') 失败（exit $($p.ExitCode)）: $err"
    }
    return $stdout
}

# git push：优先走 git 自带凭据（store / credential helper），失败再用 PAT 拼 URL 兜底
function Invoke-GitPush {
    param([string]$Ref, [switch]$Force)
    $base = @('push')
    if ($Force) { $base += '-f' }
    $base += 'origin'
    $base += $Ref
    try {
        Invoke-Git @base
    } catch {
        if (-not $pat) { throw "git push origin $Ref 失败且无可用的 PAT 兜底：$($_.Exception.Message)" }
        $url = "https://$($pat.Trim())@github.com/$repo.git"
        $fb = @('push')
        if ($Force) { $fb += '-f' }
        $fb += $url
        $fb += $Ref
        Log '  push 走 git 自带凭据失败，改用 PAT 兜底 URL'
        Invoke-Git @fb
    }
}

$apiHdr = @{
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Log "=== sync-release 开始（Version='$Version'）==="
Push-Location $repoRoot
try {
    # 0) 推送前确认门禁（2026-08-25 用户要求：每日推送 GitHub 须先获用户同意）
    if (-not $Force) {
        $scope = if ($Version) { "main + 版本标签 $Version + latest 滚动" } else { 'main' }
        Write-Host ''
        Write-Host "⚠️  即将推送至 GitHub：$scope"
        Write-Host "    仓库：$repo"
        $ans = Read-Host '输入 YES 确认推送（输入其他任意内容则取消）'
        if ($ans -ne 'YES') {
            Log '❌ 用户未确认，已取消推送'
            exit 0
        }
        Log '✅ 用户已确认推送'
    }

    # 1) 推送代码（走 git 自带凭据，无需手动设 GH_PAT）
    Log '> git push origin main'
    Invoke-GitPush -Ref main

    # 2) 取最新提交信息
    $sha = (Invoke-Git rev-parse HEAD).Trim()
    $msg = (Invoke-Git log -1 --pretty=%s).Trim()
    Log "  最新提交 $sha : $msg"

    if ($Version) {
        if ($Version -notmatch '^v\d+\.\d+(\.\d+)?$') { throw "版本号格式应为 vX.Y（如 v1.2），收到: $Version" }

        # 3) 不可变版本标签（已存在则跳过，不覆盖历史里程碑）
        $tagExists = (Invoke-Git tag -l $Version).Trim()
        if (-not $tagExists) {
            Invoke-Git tag $Version $sha
            Log "> git push origin refs/tags/$Version"
            Invoke-GitPush -Ref "refs/tags/$Version"
            Log "✅ 已打不可变标签 $Version ($sha)"
        } else {
            Log "⚠ 标签 $Version 已存在，跳过（不可变里程碑不被覆盖）"
        }

        # 4) 移动 latest 标签到该提交（latest = 当前最大版本号）
        Invoke-Git tag -f latest $sha
        Log '> git push -f origin refs/tags/latest'
        Invoke-GitPush -Ref refs/tags/latest -Force
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
        if ($pat) {
            $relHdr = $apiHdr.Clone()
            $relHdr['Authorization'] = "Bearer $($pat.Trim())"
            try {
                $vrel = Invoke-RestMethod -Headers $relHdr -Uri "https://api.github.com/repos/$repo/releases/tags/$Version" -Method Get
                Invoke-RestMethod -Headers $relHdr -Uri "https://api.github.com/repos/$repo/releases/$($vrel.id)" -Method Patch -Body $verBody -ContentType 'application/json'
                Log "✅ 版本 Release $Version 已更新"
            } catch {
                Invoke-RestMethod -Headers $relHdr -Uri "https://api.github.com/repos/$repo/releases" -Method Post -Body $verBody -ContentType 'application/json'
                Log "✅ 版本 Release $Version 已创建"
            }
        } else {
            Log "⚠ 无可用 token，跳过 GitHub Release $Version 创建（请手动在 GitHub 页面补发）"
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
