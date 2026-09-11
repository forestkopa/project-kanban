# -*- coding: utf-8 -*-
"""
build_update_zip.py - 生成 project-kanban-update.zip（服务器增量升级包）

为什么用 Python 而不用 tools/package.ps1：
  PowerShell 工具在本机偶发静默失败（不报错但产物为空/缺文件），zipfile 行为可预期、可校验。

与 package.ps1 一致的规则：
  - update 包【不含 data/】—— 服务器线上数据永不被覆盖
  - 排除目录：.git .workbuddy backups deploy data-backup* logs .obsidian coverage
  - 排除文件：*.log *.tmp *.new *.patch *.zip config.yml
  - 额外排除（本机特有、体积巨大）：docs/recovered-modify-backup（169MB 本地抢救备份）
  - 保留 node_modules（服务器依赖就地可用，与历史 42.9MB 的 update 包口径一致）
  - 【zip 内顶层即项目文件】—— 解压后直接是 server.js / public/ / lib/，不套一层 project-kanban/

v1.5.5 变更：**默认不再携带 node_modules**（可用 --with-deps 退回旧口径）。
  为什么改：生产实测（2026-09-10）在线升级「服务假死数分钟」，主因就是要覆盖运行中的依赖目录 ——
  1139 个文件里 1047 个是 node_modules，解压耗时 97 秒（占整个升级的 86%），
  且备份目录恰好排除 node_modules → 依赖一旦被覆盖坏，回滚也救不回来。
  去掉后升级包约 2MB / 92 文件，解压降到秒级；服务端依赖保持原样不再被动。
  代价：未来若新增运行依赖，目标机不会自动获得 → 升级流程内置依赖自检（lib/upgrade.js#missingDeps）
  会明确报错并提示 `npm install --omit=dev`，不会静默把服务搞成 500。
  首次部署/依赖有变动的机器请用： python tools/build_update_zip.py --with-deps

用法：
  python tools/build_update_zip.py [-o 输出目录] [--with-deps]
默认输出： ~/Downloads/kanban/project-kanban-update.zip
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'project-kanban'

WITH_DEPS = '--with-deps' in sys.argv  # v1.5.5：默认不带 node_modules，显式传参才带

EXCLUDE_DIRS = {
    '.git', '.workbuddy', '.obsidian', 'backups', 'deploy', 'data', 'logs',
    'coverage', '__pycache__', '.pytest_cache',
}
EXCLUDE_DIR_PREFIX = ('data-backup',)          # data-backup* 通配
EXCLUDE_DIR_PATHS = {                          # 相对 ROOT 的具体路径（本机特有巨型目录）
    os.path.join('docs', 'recovered-modify-backup'),
}
EXCLUDE_FILE_SUFFIX = ('.log', '.tmp', '.new', '.patch', '.zip')
EXCLUDE_FILE_NAMES = {'config.yml', '.DS_Store', 'Thumbs.db'}


def excluded_dir(name, rel):
    if name in EXCLUDE_DIRS:
        return True
    if not WITH_DEPS and name == 'node_modules':   # v1.5.5：默认不打包依赖（见文件头说明）
        return True
    if name.startswith(EXCLUDE_DIR_PREFIX):
        return True
    return rel in EXCLUDE_DIR_PATHS


def excluded_file(name):
    return name in EXCLUDE_FILE_NAMES or name.endswith(EXCLUDE_FILE_SUFFIX)


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, '%s-update.zip' % NAME)
    n = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            rel_dir = os.path.relpath(dirpath, ROOT)
            rel_dir = '' if rel_dir == '.' else rel_dir
            # 原地裁剪目录树，避免继续下钻被排除的分支
            dirnames[:] = sorted(
                d for d in dirnames
                if not excluded_dir(d, os.path.join(rel_dir, d) if rel_dir else d)
            )
            for fn in sorted(filenames):
                if excluded_file(fn):
                    continue
                abs_p = os.path.join(dirpath, fn)
                arc = os.path.join(rel_dir, fn) if rel_dir else fn
                try:
                    z.write(abs_p, arc.replace('\\', '/'))
                    n += 1
                except (OSError, PermissionError) as e:
                    print('  skip(locked): %s - %s' % (arc, e))
    size_mb = round(os.path.getsize(zip_path) / 1024 / 1024, 1)
    print('OK %s  (%s 个文件, %s MB)' % (zip_path, n, size_mb))

    # 关键文件自检：升级包必须包含这些，否则服务器升完起不来
    must = ['server.js', 'db.js', 'package.json', 'watchdog.js', 'offline-adapter.js',
            'kanban-workbench-template.html', 'lib/ai-agent.js',
            'public/index.html', 'public/app.js', 'public/style.css']
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        missing = [m for m in must if m not in names]
        leaked = [x for x in names if x.startswith('data/') or 'recovered-modify-backup' in x]
        dep_files = [x for x in names if x.startswith('node_modules/')]
    if missing:
        print('SELF-CHECK FAIL 缺失关键文件: %s' % missing)
        return 1
    if leaked:
        print('SELF-CHECK FAIL 泄漏 data/ 或备份目录: %s' % leaked[:5])
        return 1
    if not WITH_DEPS and dep_files:
        print('SELF-CHECK FAIL 不该携带依赖却出现了 %d 个 node_modules 条目' % len(dep_files))
        return 1
    # 依赖清单自检：不带 node_modules 时，把运行依赖列出来提示（目标机需已具备，
    # 否则升级流程的依赖自检会明确报错，见 lib/upgrade.js#missingDeps）
    try:
        import json
        deps = sorted(json.loads(open(os.path.join(ROOT, 'package.json'), encoding='utf8').read())
                      .get('dependencies', {}).keys())
    except Exception:
        deps = []
    print('SELF-CHECK OK  (关键文件齐全, 未含 data/, 未含 169MB 备份目录%s)'
          % ('' if WITH_DEPS else ', 未含 node_modules'))
    print('  包内依赖口径: %s%s' % ('含依赖（--with-deps）' if WITH_DEPS else '不含依赖（默认，升级更快更安全）',
                                  '' if WITH_DEPS else '；目标机需已装: ' + ', '.join(deps)))
    return 0


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('-o') + 1] if '-o' in sys.argv else \
        os.path.join(os.path.expanduser('~'), 'Downloads', 'kanban')
    sys.exit(build(out))
