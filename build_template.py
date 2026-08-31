#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把真实 kanban 前端(index.html+style.css+app.js)内联为单文件 HTML，
前置离线适配器(offline-adapter.js)，产出 kanban-workbench-template.html。"""
import os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(ROOT, 'public')

with open(os.path.join(PUB, 'index.html'), encoding='utf-8') as f:
    html = f.read()
with open(os.path.join(PUB, 'style.css'), encoding='utf-8') as f:
    css = f.read()
with open(os.path.join(PUB, 'app.js'), encoding='utf-8') as f:
    appjs = f.read()
with open(os.path.join(ROOT, 'offline-adapter.js'), encoding='utf-8') as f:
    adapter = f.read()

# 安全转义：防止内联时提前闭合标签
css = css.replace('</style', '<\\/style')
appjs = appjs.replace('</script', '<\\/script')
adapter = adapter.replace('</script', '<\\/script')

# 1) 内联 style.css
def _css_repl(m):
    return '<style>\n' + css + '\n</style>'
html = re.sub(r'<link[^>]*href="/style\.css[^"]*"[^>]*>', _css_repl, html, count=1)

# 2) 用 适配器 + app.js 替换 <script src="/app.js...">
def _js_repl(m):
    return '<script>\n' + adapter + '\n</script>\n<script>\n' + appjs + '\n</script>'
html = re.sub(r'<script\s+src="/app\.js[^"]*"></script>', _js_repl, html, count=1)

# 3) 标题更贴合大赛
html = html.replace('<title>多项目管理看板</title>',
                    '<title>多项目管理看板 · 工作台模板</title>')

out = os.path.join(ROOT, 'kanban-workbench-template.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(html)

print('OK size=%d' % os.path.getsize(out))
# 自检
assert '/style.css?v=' not in html, 'style.css 未内联'
assert '/app.js?v=' not in html, 'app.js 未内联'
assert 'window.fetch = function' in html, '适配器未注入'
print('self-check passed')
