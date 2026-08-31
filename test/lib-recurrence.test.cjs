// 重复任务纯函数单测（回归防护）：抽自 server.js 的 lib/recurrence.js
// 重点锁住最易错的月末收敛 / 周双周位移 / 非法输入
const { shiftByRecurrence, spawnNextRecurrence } = require('../lib/recurrence.js');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// --- shiftByRecurrence：基础位移 ---
ok('daily 顺延 1 天', shiftByRecurrence('2026-01-01', 'daily') === '2026-01-02', shiftByRecurrence('2026-01-01', 'daily'));
ok('weekly 顺延 7 天', shiftByRecurrence('2026-01-01', 'weekly') === '2026-01-08', shiftByRecurrence('2026-01-01', 'weekly'));
ok('biweekly 顺延 14 天', shiftByRecurrence('2026-01-01', 'biweekly') === '2026-01-15', shiftByRecurrence('2026-01-01', 'biweekly'));

// --- monthly：月末收敛（最易错）---
ok('monthly 普通月 +1', shiftByRecurrence('2026-01-15', 'monthly') === '2026-02-15', shiftByRecurrence('2026-01-15', 'monthly'));
ok('monthly 1/31 → 2/28 收敛(非闰年)', shiftByRecurrence('2026-01-31', 'monthly') === '2026-02-28', shiftByRecurrence('2026-01-31', 'monthly'));
ok('monthly 闰年 1/31 → 2/29', shiftByRecurrence('2024-01-31', 'monthly') === '2024-02-29', shiftByRecurrence('2024-01-31', 'monthly'));
ok('monthly 3/31 → 4/30 收敛', shiftByRecurrence('2026-03-31', 'monthly') === '2026-04-30', shiftByRecurrence('2026-03-31', 'monthly'));
ok('monthly 12/31 → 次年 1/31 跨年', shiftByRecurrence('2026-12-31', 'monthly') === '2027-01-31', shiftByRecurrence('2026-12-31', 'monthly'));

// --- 非法输入 ---
ok('空字符串返回 null', shiftByRecurrence('', 'monthly') === null);
ok('格式不匹配(斜杠分隔)返回 null', shiftByRecurrence('2026/13/40', 'monthly') === null);
ok('格式不匹配(非2位)返回 null', shiftByRecurrence('2026-1-1', 'monthly') === null);
// 数值越界走 JS Date 容错（非 strict 校验）：13 月→次年 1 月，40 日→月末收敛；单测锁定此行为防回归
ok('数值越界走 Date 容错(13月→次年1月31日)', shiftByRecurrence('2026-13-40', 'monthly') === '2027-01-31', shiftByRecurrence('2026-13-40', 'monthly'));
ok('未知周期返回 null', shiftByRecurrence('2026-01-01', 'yearly') === null);
ok('null 返回 null', shiftByRecurrence(null, 'weekly') === null);

// --- spawnNextRecurrence：字段继承 + 日期顺延 ---
const base = { recurrence: 'weekly', title: '周报', phaseId: 'p1', note: 'n', estimateDays: 3, assignee: 'a', isMilestone: true, startDate: '2026-01-01', dueDate: '2026-01-07', done: true };
const sp = spawnNextRecurrence(base);
ok('spawn 继承标题', sp && sp.title === '周报');
ok('spawn 继承阶段', sp && sp.phaseId === 'p1');
ok('spawn 继承负责人', sp && sp.assignee === 'a');
ok('spawn 继承工期', sp && sp.estimateDays === 3);
ok('spawn 继承里程碑', sp && sp.isMilestone === true);
ok('spawn dueDate 顺延 7 天', sp && sp.dueDate === '2026-01-14', sp && sp.dueDate);
ok('spawn startDate 顺延 7 天', sp && sp.startDate === '2026-01-08', sp && sp.startDate);
ok('spawn done=false', sp && sp.done === false);
ok('spawn recurrence 保留', sp && sp.recurrence === 'weekly');
ok('spawn 新 id 以 t_ 开头', sp && /^t_/.test(sp.id), sp && sp.id);
// monthly 派生的子任务也走月末收敛
const spm = spawnNextRecurrence({ recurrence: 'monthly', title: '月报', phaseId: 'p1', dueDate: '2026-01-31' });
ok('spawn monthly 子任务月末收敛', spm && spm.dueDate === '2026-02-28', spm && spm.dueDate);
// 无效 recurrence → null
ok('spawn 无效 recurrence 返回 null', spawnNextRecurrence({ recurrence: '', dueDate: '2026-01-01' }) === null);
ok('spawn 无 dueDate/startDate 返回 null', spawnNextRecurrence({ recurrence: 'weekly', title: 'x' }) === null);

console.log('\n========== lib/recurrence 单测 ==========');
console.log(fail === 0 ? ('✅ 通过 ' + pass + '/' + pass) : ('❌ 失败 ' + fail + '/' + (pass + fail) + '  [' + fails.join(', ') + ']'));
process.exit(fail === 0 ? 0 : 1);
