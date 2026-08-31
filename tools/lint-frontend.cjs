#!/usr/bin/env node
/* =========================================================
   前端自检（P1-10 轻量工程化，零外部依赖）
   为什么不用 ESLint：本项目刻意保持零运行时/构建依赖（便于 NAS/离线部署与投递），
   引入 ESLint + 插件会带来上百个 node_modules 包。这里用针对性检查覆盖最容易
   出事的三类问题，比通用 lint 更贴合本项目：
     1) app.js 语法可解析（等价 node --check，但适用于浏览器脚本）
     2) app.js 里 $('#id') / getElementById('id') 引用的元素，在 index.html 中真实存在
        —— 这是单体前端最常见的运行时崩溃来源（改 HTML 忘了改 JS）
     3) index.html 内联 <script> 必须带 nonce 占位符（否则新 CSP 会拦截）
   退出码非 0 时 CI/发布脚本应中止。
   用法：node tools/lint-frontend.cjs
   ========================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'public', 'app.js');
const HTML = path.join(ROOT, 'public', 'index.html');
const SW = path.join(ROOT, 'public', 'sw.js');
const MANIFEST = path.join(ROOT, 'public', 'app.webmanifest');

let errors = 0, warns = 0;
const err = m => { console.error('  ✗ ' + m); errors++; };
const warn = m => { console.warn('  ! ' + m); warns++; };
const ok = m => console.log('  ✓ ' + m);

function readOr(f, label) {
  if (!fs.existsSync(f)) { err(label + ' 缺失：' + f); return null; }
  return fs.readFileSync(f, 'utf8');
}

console.log('前端自检 —— public/');
const app = readOr(APP, 'app.js');
const html = readOr(HTML, 'index.html');

/* 1) 语法可解析 */
[[APP, app], [SW, readOr(SW, 'sw.js')]].forEach(([f, src]) => {
  if (!src) return;
  try { new Function(src); ok(path.basename(f) + ' 语法通过'); }
  catch (e) { err(path.basename(f) + ' 语法错误：' + e.message); }
});

/* app.webmanifest 必须是合法 JSON 且含必需字段 */
const mf = readOr(MANIFEST, 'app.webmanifest');
if (mf) {
  try {
    const j = JSON.parse(mf);
    const miss = ['name', 'start_url', 'display', 'icons'].filter(k => !j[k]);
    if (miss.length) err('app.webmanifest 缺字段：' + miss.join(', '));
    else ok('app.webmanifest 合法（' + (j.icons || []).length + ' 个图标）');
  } catch (e) { err('app.webmanifest 不是合法 JSON：' + e.message); }
}

/* 2) DOM id 引用一致性 */
if (app && html) {
  const htmlIds = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);
  // app.js 自己用模板字符串注入的 id（视图动作区按钮、全景图容器等）同样算"存在"
  const injected = new Set();
  for (const m of app.matchAll(/\bid\s*=\s*(?:\\?["']|\$?\{?)([A-Za-z][\w-]*)(?:\\?["'])/g)) injected.add(m[1]);
  for (const m of app.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) injected.add(m[1]);
  const DYNAMIC = injected;

  const refs = new Map(); // id -> 出现次数
  const push = id => refs.set(id, (refs.get(id) || 0) + 1);
  for (const m of app.matchAll(/\$\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)/g)) push(m[1]);
  for (const m of app.matchAll(/getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) push(m[1]);

  const missing = [...refs.keys()].filter(id => !htmlIds.has(id) && !DYNAMIC.has(id));
  if (missing.length) missing.forEach(id => err(`app.js 引用了不存在的元素 #${id}（${refs.get(id)} 处）`));
  else ok(`DOM id 引用一致（检查 ${refs.size} 个 id / HTML 共 ${htmlIds.size} 个）`);

  // HTML 里定义但 JS 从未引用的 id（仅提示，纯样式锚点是正常的）
  const unused = [...htmlIds].filter(id => !refs.has(id));
  if (unused.length > 24) warn(`HTML 中有 ${unused.length} 个 id 未被 JS 引用（多为样式锚点，仅提示）`);
}

/* 3) 内联脚本必须带 nonce（CSP 已移除 unsafe-inline） */
if (html) {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/gi)];
  const bad = inline.filter(m => !/\bnonce\s*=/.test(m[1]));
  if (bad.length) err(`有 ${bad.length} 处内联 <script> 未带 nonce，将被 CSP 拦截`);
  else ok(`内联脚本 ${inline.length} 处，均带 nonce`);

  // 内联事件处理器同样会被 CSP 拦截
  const onattr = [...html.matchAll(/\s(on[a-z]+)\s*=\s*["'][^"']/gi)].map(m => m[1]);
  if (onattr.length) err('HTML 中存在内联事件属性（CSP 会拦截）：' + [...new Set(onattr)].join(', '));
  else ok('无内联事件属性');

  if (!/<link[^>]+rel=["']manifest["']/.test(html)) warn('index.html 未引用 manifest');
  else ok('已引用 app.webmanifest');
}

console.log(`\n结果：${errors} 个错误，${warns} 个提示`);
process.exit(errors ? 1 : 0);
