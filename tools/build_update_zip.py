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

用法：
  python tools/build_update_zip.py [-o 输出目录]
默认输出： ~/Downloads/kanban/project-kanban-update.zip
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'project-kanban'

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
    if missing:
        print('SELF-CHECK FAIL 缺失关键文件: %s' % missing)
        return 1
    if leaked:
        print('SELF-CHECK FAIL 泄漏 data/ 或备份目录: %s' % leaked[:5])
        return 1
    print('SELF-CHECK OK  (关键文件齐全, 未含 data/, 未含 169MB 备份目录)')
    return 0


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('-o') + 1] if '-o' in sys.argv else \
        os.path.join(os.path.expanduser('~'), 'Downloads', 'kanban')
    sys.exit(build(out))
