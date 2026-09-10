// 导出下载鉴权回归测试（v1.5.4）
// 背景：计划导出 / 参考模版导出曾用裸 <a href="/api/..."> 直链下载，浏览器导航不带 X-Auth-Token，
//       而服务端 GET 接口统一鉴权 → 真实版（5181 / 公网）一律 401，表现为「点了没反应/不下载」。
// 本测试从源码层面锁死：所有 /api 二进制下载必须走 downloadAuthFile（fetch + X-Auth-Token + blob）。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const APP = path.resolve(__dirname, '../public/app.js');
const TPL = path.resolve(__dirname, '../kanban-workbench-template.html');
const SRV = path.resolve(__dirname, '../server.js');
const src = fs.readFileSync(APP, 'utf8');
const tpl = fs.existsSync(TPL) ? fs.readFileSync(TPL, 'utf8') : '';
const srv = fs.readFileSync(SRV, 'utf8');

console.log('\n=== 导出下载鉴权回归（源码约束）===');

// 1. 统一的带鉴权下载助手存在
ok('downloadAuthFile 已定义', /async function downloadAuthFile\(/.test(src));
ok('downloadAuthFile 发送 X-Auth-Token 头', /downloadAuthFile[\s\S]{0,400}?X-Auth-Token/.test(src));
ok('downloadAuthFile 用 blob 落地（非直链）', /downloadAuthFile[\s\S]{0,900}?URL\.createObjectURL\(blob\)/.test(src));
ok('downloadAuthFile 401 时自动重登录（非 demo）', /downloadAuthFile[\s\S]{0,700}?status === 401[\s\S]{0,120}?showLogin/.test(src));

// 2. 严禁裸 <a href="/api/..."> 直链下载（历史 bug 根因）
const bare = (src.match(/a\.href = `\/api\//g) || []).length;
ok('前端无裸 /api 直链下载（a.href 模板串）', bare === 0, { count: bare });
const bareTpl = (tpl.match(/a\.href = `\/api\//g) || []).length;
ok('离线模板无裸 /api 直链下载', bareTpl === 0, { count: bareTpl });

// 3. 三个导出入口都改走 downloadAuthFile
const planSeg = (src.match(/async function exportPlan\(type\)[\s\S]*?\n}/) || [''])[0];
ok('exportPlan 改为 async + downloadAuthFile', /downloadAuthFile\(/.test(planSeg) && !/a\.href = /.test(planSeg));
const refSegs = src.match(/\$\('#refTplDownload'\)\.onclick[\s\S]*?\n};|\$\('#tplExportBtn'\)\.onclick[\s\S]*?\n};/g) || [];
ok('参考模版两处导出均走 downloadAuthFile', refSegs.length === 2 && refSegs.every(s => /downloadAuthFile\(/.test(s)), { found: refSegs.length });

// 4. 失败必须 toast（不能静默）
ok('exportPlan 失败有 toast 提示', /exportPlan[\s\S]*?catch \(err\) \{ toast\(/.test(src));

// 5. parseDisposition 行为正确（中文名优先 filename*=UTF-8''，回退 ascii）
const pdSrc = (src.match(/function parseDisposition\(cd\) \{[\s\S]*?\n}/) || [''])[0];
ok('parseDisposition 已定义', /function parseDisposition/.test(pdSrc));
const parseDisposition = new Function('cd', pdSrc.replace(/function parseDisposition\(cd\) \{/, '').replace(/\n}$/, ''));
ok('解析 filename*=UTF-8 中文名', parseDisposition(`attachment; filename="a.xlsx"; filename*=UTF-8''${encodeURIComponent('项目_最新计划_20260910.xlsx')}`) === '项目_最新计划_20260910.xlsx');
ok('回退 ascii 文件名', parseDisposition('attachment; filename="project_latest_20260910.xlsx"') === 'project_latest_20260910.xlsx');
ok('空头返回空串（由调用方用兜底名）', parseDisposition('') === '' && parseDisposition(null) === '');

// 6. 服务端确实要求登录（说明前端必须带 token，否则必然 401）
//    注意：源码里是正则字面量 projects\/([^/]+)\/export，含转义反斜杠，用索引定位避免正则写歪
const exIdx = srv.indexOf('export$/');
const exSeg = exIdx >= 0 ? srv.slice(exIdx, exIdx + 400) : '';
ok('服务端导出路由要求登录（!req.user → 401）', /!req\.user\) return send\(res, 401/.test(exSeg), { found: exIdx >= 0, seg: exSeg.slice(0, 120) });
ok('GET 统一鉴权白名单不含导出接口', /const PUBLIC_GET = \[([^\]]*)\]/.test(srv) && !/export/.test((srv.match(/const PUBLIC_GET = \[([^\]]*)\]/) || ['', ''])[1]));

// 7. 构建产物（离线模板）已同步该修复
ok('离线模板已含 downloadAuthFile（build_template 已重建）', /downloadAuthFile/.test(tpl));

console.log(`\n断言: ${pass + fail} | 通过: ${pass} | 失败: ${fail}`);
if (fail) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
console.log('✓ 导出下载鉴权回归测试全部通过');
