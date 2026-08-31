// Excel 导出纯函数单测（回归防护）：抽自 server.js 的 lib/xlsx-export.js
// 重点：4 个 builder 返回有效 xlsx Buffer；safeCell 对前导 = + - @ 做公式注入转义
const XLSX = require('xlsx');
const { safeCell, buildPlanXlsx, buildDiffXlsx, buildTodoXlsx, buildReportXlsx } = require('../lib/xlsx-export.js');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function flat(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }).map(r => r.join('|')).join('\n');
}

// --- safeCell 转义 ---
ok('safeCell = 开头加引号', safeCell('=cmd') === "'=cmd", safeCell('=cmd'));
ok('safeCell + 开头加引号', safeCell('+cmd') === "'+cmd", safeCell('+cmd'));
ok('safeCell - 开头加引号', safeCell('-cmd') === "'-cmd", safeCell('-cmd'));
ok('safeCell @ 开头加引号', safeCell('@cmd') === "'@cmd", safeCell('@cmd'));
ok('safeCell 普通文本不变', safeCell('正常标题') === '正常标题');
ok('safeCell 数字不变', safeCell(123) === 123);
ok('safeCell 空串不变', safeCell('') === '');

// --- 4 个 builder 返回有效 Buffer，且用户输入被转义 ---
const proj = { phases: [{ id: 'p1', name: '阶段1' }], baseline: [] };
const tasks = [{
  phaseId: 'p1', title: '=危险公式', assignee: '@x', note: '+note',
  estimateDays: 2, done: false, startDate: '2026-01-01', dueDate: '2026-01-03'
}];

const buf1 = buildPlanXlsx(proj, tasks);
ok('buildPlanXlsx 返回 Buffer', Buffer.isBuffer(buf1) && buf1.length > 0);
const f1 = flat(buf1);
ok('buildPlanXlsx 转义 title 前导 =', f1.includes("'=危险公式"), f1.slice(0, 120));
ok('buildPlanXlsx 转义 assignee 前导 @', f1.includes("'@x"), f1.slice(0, 120));
ok('buildPlanXlsx 转义 note 前导 +', f1.includes("'+note"), f1.slice(0, 120));

const buf2 = buildDiffXlsx(proj);
ok('buildDiffXlsx 返回 Buffer', Buffer.isBuffer(buf2) && buf2.length > 0);

const buf3 = buildTodoXlsx([{ name: '=项目A', tasks: [{ title: '=x', isMilestone: false, done: false, startDate: '2026-01-01', dueDate: '2026-01-07' }] }], '2026-01-01', '2026-01-07');
ok('buildTodoXlsx 返回 Buffer', Buffer.isBuffer(buf3) && buf3.length > 0);
const f3 = flat(buf3);
ok('buildTodoXlsx 转义 title 前导 =', f3.includes("'=x"), f3.slice(0, 120));
ok('buildTodoXlsx 转义项目名 前导 =', f3.includes("'=项目A"), f3.slice(0, 120));

const buf4 = buildReportXlsx([{ user: { name: '=admin', role: 'admin' }, projects: 1, tasks: 2, done: 1, overdue: 0, rate: '50%' }]);
ok('buildReportXlsx 返回 Buffer', Buffer.isBuffer(buf4) && buf4.length > 0);
const f4 = flat(buf4);
ok('buildReportXlsx 转义成员名 前导 =', f4.includes("'=admin"), f4.slice(0, 120));

console.log('\n========== lib/xlsx-export 单测 ==========');
console.log(fail === 0 ? ('✅ 通过 ' + pass + '/' + pass) : ('❌ 失败 ' + fail + '/' + (pass + fail) + '  [' + fails.join(', ') + ']'));
process.exit(fail === 0 ? 0 : 1);
