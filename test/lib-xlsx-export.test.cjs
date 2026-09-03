// Excel 导出纯函数单测（回归防护）：抽自 server.js 的 lib/xlsx-export.js
// 重点：4 个 builder 返回有效 xlsx Buffer；safeCell 对前导 = + - @ 做公式注入转义
const XLSX = require('xlsx');
const { safeCell, computeTodoCols, buildPlanXlsx, buildDiffXlsx, buildTodoXlsx, buildReportXlsx } = require('../lib/xlsx-export.js');

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

const buf3 = buildTodoXlsx([{ name: '=项目A', tasks: [{ title: '=x', done: false, startDate: '2026-01-01', dueDate: '2026-01-07' }] }], '2026-01-01', '2026-01-07');
ok('buildTodoXlsx 返回 Buffer', Buffer.isBuffer(buf3) && buf3.length > 0);
const f3 = flat(buf3);
ok('buildTodoXlsx 转义 title 前导 =', f3.includes("'=x"), f3.slice(0, 120));
ok('buildTodoXlsx 转义项目名 前导 =', f3.includes("'=项目A"), f3.slice(0, 120));

const buf4 = buildReportXlsx([{ user: { name: '=admin', role: 'admin' }, projects: 1, tasks: 2, done: 1, overdue: 0, rate: '50%' }]);
ok('buildReportXlsx 返回 Buffer', Buffer.isBuffer(buf4) && buf4.length > 0);
const f4 = flat(buf4);
ok('buildReportXlsx 转义成员名 前导 =', f4.includes("'=admin"), f4.slice(0, 120));

// --- buildTodoXlsx nextweek（顺延模型）---
const nwProjects = [{ name: '项目A', tasks: [
  { title: '顺延任务', done: false, startDate: '2026-01-05', dueDate: '2026-01-10', carryover: true },
  { title: '下周计划', done: false, startDate: '2026-01-13', dueDate: '2026-01-14', carryover: false },
  { title: '已完成', done: true, startDate: '2026-01-05', dueDate: '2026-01-10', carryover: true },
] }];
const bufNW = buildTodoXlsx(nwProjects, '2026-01-12', '2026-01-18', 'nextweek');
ok('buildTodoXlsx(nextweek) 返回 Buffer', Buffer.isBuffer(bufNW) && bufNW.length > 0, bufNW && bufNW.length);
const fNW = flat(bufNW);
ok('nextweek 顺延任务纳入（⚠ 本周未完成·顺延）', fNW.includes('⚠ 本周未完成·顺延'), fNW.slice(0, 240));
ok('nextweek 下周计划任务纳入（下周计划）', fNW.includes('下周计划'), fNW.slice(0, 240));
ok('nextweek 顺延任务标题出现', fNW.includes('顺延任务'), fNW.slice(0, 240));
ok('nextweek 已完成任务被排除', !fNW.includes('已完成'), fNW.slice(0, 240));
ok('nextweek 标题为「下周待办清单」', fNW.includes('下周待办清单'), fNW.slice(0, 240));

// --- 自适应列宽（方案 B）：状态列不再写死 12 导致「⚠ 本周未完成·顺延」被遮 ---
const colRows = [
  ['项目周报 · 待办清单（01/12 — 01/18）'],
  ['项目', '任务', '工期(天)', '开始日期', '截止日期', '状态'],
  ['项目A长名字测试', '顺延任务很长很长很长很长很长很长很长', 3, '01/05', '01/10', '⚠ 本周未完成·顺延'],
  ['项目B', '普通任务', 2, '01/06', '01/12', '下周计划'],
];
const cols = computeTodoCols(colRows);
ok('computeTodoCols 返回 6 列', cols.length === 6, cols.length);
ok('computeTodoCols 状态列宽≥16（容纳顺延文案）', cols[5].wch >= 16, cols[5].wch);
ok('computeTodoCols 列宽均不低于 min 8', cols.every(c => c.wch >= 8), cols.map(c => c.wch));
ok('computeTodoCols 列宽均不超 max 40', cols.every(c => c.wch <= 40), cols.map(c => c.wch));

console.log('\n========== lib/xlsx-export 单测 ==========');
console.log(fail === 0 ? ('✅ 通过 ' + pass + '/' + pass) : ('❌ 失败 ' + fail + '/' + (pass + fail) + '  [' + fails.join(', ') + ']'));
process.exit(fail === 0 ? 0 : 1);
