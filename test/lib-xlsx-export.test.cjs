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

// --- 计划表 / 差异对比 排版样式（v1.5.4）：深蓝表头 / 细边框 / 全部列居中 ---
// ① 直接单测样式对象（fill / font.color / alignment / border）；② 校验序列化后的 xlsx 里有对应 XML。
const { stylePlanSheet, dateCell, setDateFmt, PLAN_DATE_FMT, planSheet, diffSheet, todoSheet } = require('../lib/xlsx-export.js');
const { normDate } = require('../lib/formula-engine.js');
const S = require('xlsx-js-style');
function mkSheet(rows) { return S.utils.aoa_to_sheet(rows); }
const al = (ws, r, c) => {
  const cell = ws[S.utils.encode_cell({ r, c })];
  return (cell && cell.s && cell.s.alignment) || {};
};
const fl = (ws, r, c) => {
  const cell = ws[S.utils.encode_cell({ r, c })];
  return (cell && cell.s && cell.s.fill) || {};
};
const fnt = (ws, r, c) => {
  const cell = ws[S.utils.encode_cell({ r, c })];
  return (cell && cell.s && cell.s.font) || {};
};
const bd = (ws, r, c) => {
  const cell = ws[S.utils.encode_cell({ r, c })];
  return (cell && cell.s && cell.s.border) || {};
};
const PLAN_HEAD = ['序号', '阶段', '任务', '负责人', '开始日期', '截止日期', '工期(天)', '状态', '备注'];
{
  const ws = mkSheet([PLAN_HEAD, [1, '阶段1', '任务A', '张三', '2026/1/1', '2026/1/3', 2, '未完成', '备注x']]);
  stylePlanSheet(ws, 2, 9, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  ok('计划表表头 9 列全部水平居中', Array.from({ length: 9 }, (_, c) => al(ws, 0, c).horizontal).every(h => h === 'center'),
    Array.from({ length: 9 }, (_, c) => al(ws, 0, c).horizontal));
  // 全部 9 列居中（含任务列）
  Array.from({ length: 9 }, (_, c) => ok('计划表数据列「' + PLAN_HEAD[c] + '」居中', al(ws, 1, c).horizontal === 'center', al(ws, 1, c)));
  ok('计划表所有单元格垂直居中', Array.from({ length: 9 }, (_, c) => al(ws, 1, c).vertical).every(v => v === 'center'));
  // 表头：深蓝填充 + 白字加粗
  ok('计划表表头深蓝填充（#1F4E78）', Array.from({ length: 9 }, (_, c) => (fl(ws, 0, c).fgColor || {}).rgb === 'FF1F4E78').every(Boolean));
  ok('计划表表头白色字体加粗', Array.from({ length: 9 }, (_, c) => (fnt(ws, 0, c).color || {}).rgb === 'FFFFFFFF' && fnt(ws, 0, c).bold === true).every(Boolean));
  // 细边框：四边都有 thin
  const hasThinAll = (b) => b && b.top && b.top.style === 'thin' && b.bottom && b.bottom.style === 'thin' && b.left && b.left.style === 'thin' && b.right && b.right.style === 'thin';
  ok('计划表表头四边细边框', Array.from({ length: 9 }, (_, c) => hasThinAll(bd(ws, 0, c))).every(Boolean));
  ok('计划表数据行四边细边框', Array.from({ length: 9 }, (_, c) => hasThinAll(bd(ws, 1, c))).every(Boolean));
}
const DIFF_HEAD = ['序号', '阶段', '任务', '负责人', '初版开始', '初版截止', '最新开始', '最新截止', '工期(天)', '状态', '变动说明'];
{
  const ws = mkSheet([DIFF_HEAD, [1, '阶段1', '任务A', '张三', '2026/1/1', '2026/1/3', '2026/1/2', '2026/1/4', 3, '未完成', '日期调整']]);
  stylePlanSheet(ws, 2, 11, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  ok('差异对比表头 11 列全部水平居中', Array.from({ length: 11 }, (_, c) => al(ws, 0, c).horizontal).every(h => h === 'center'));
  Array.from({ length: 11 }, (_, c) => ok('差异对比数据列「' + DIFF_HEAD[c] + '」居中', al(ws, 1, c).horizontal === 'center', al(ws, 1, c)));
  ok('差异对比表头深蓝填充', Array.from({ length: 11 }, (_, c) => (fl(ws, 0, c).fgColor || {}).rgb === 'FF1F4E78').every(Boolean));
}

// --- 日期：真日期单元格 + 显示格式 yyyy/m/d（v1.5.4）---
// 为什么不是格式化文本：文本 '2026/9/1' 在 Excel 排序时会排到 '2026/10/1' 之后（字典序错乱），
// 真日期 + numFmt 则排序/筛选/日期运算全部正确，且导入侧 normDate 可回解析，闭环无损。
ok('dateCell 返回 Date 且日期正确', dateCell('2026-09-13') instanceof Date && normDate(dateCell('2026-09-13')) === '2026-09-13', dateCell('2026-09-13'));
ok('dateCell 个位月日正确（去前导零）', normDate(dateCell('2026-01-03')) === '2026-01-03');
ok('dateCell 两位数月份正常', normDate(dateCell('2026-12-25')) === '2026-12-25');
ok('dateCell 空值返回空串', dateCell('') === '' && dateCell(null) === '' && dateCell(undefined) === '');
ok('dateCell 非 ISO 原样返回文本（异常值不丢）', dateCell('待定') === '待定');
ok('dateCell 忽略时间后缀只取日期部分', normDate(dateCell('2026-09-13T10:00:00Z')) === '2026-09-13');
ok('PLAN_DATE_FMT 为 yyyy/m/d', PLAN_DATE_FMT === 'yyyy/m/d', PLAN_DATE_FMT);
// 导入闭环：真日期写盘后读回是 Excel 序列号，normDate 必须能还原 ISO；显示文本必须是 2026/9/13
{
  const ws = S.utils.aoa_to_sheet([['日期'], [dateCell('2026-09-13')], [dateCell('2026-10-01')], [dateCell('2026-09-01')]]);
  setDateFmt(ws, 4, [0]);
  const wb = S.utils.book_new(); S.utils.book_append_sheet(wb, ws, 'S');
  const b = S.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const sh = XLSX.read(b, { type: 'buffer' }).Sheets.S;
  ok('导出日期读回为日期序列号（normDate 可还原）', typeof sh.A2.v === 'number' && normDate(sh.A2.v) === '2026-09-13', sh.A2.v);
  ok('导出日期显示为 2026/9/13', sh.A2.w === '2026/9/13', sh.A2.w);
  ok('导出日期排序正确（9/1 < 9/13 < 10/1）',
    [sh.A2.v, sh.A3.v, sh.A4.v].sort((x, y) => x - y).map(normDate).join(',') === '2026-09-01,2026-09-13,2026-10-01',
    [sh.A2.v, sh.A3.v, sh.A4.v].map(normDate));
  ok('序列化 xlsx 内写入了 numFmt yyyy/m/d', /formatCode="yyyy\/m\/d"/.test(b.toString('utf8')));
}
// 真实导出内容校验（planSheet / diffSheet 产出的单元格）
{
  const { ws } = planSheet({ phases: [{ id: 'p1', name: '阶段1' }] }, [{ phaseId: 'p1', title: '任务A', assignee: '张三', note: '', estimateDays: 2, done: false, startDate: '2026-01-01', dueDate: '2026-01-03' }]);
  ok('计划表开始日期为真日期单元格', ws[S.utils.encode_cell({ r: 1, c: 4 })].t === 'd');
  ok('计划表截止日期为真日期单元格', ws[S.utils.encode_cell({ r: 1, c: 5 })].t === 'd');
  ok('计划表日期列套用了 yyyy/m/d', ws[S.utils.encode_cell({ r: 1, c: 4 })].z === 'yyyy/m/d' && ws[S.utils.encode_cell({ r: 1, c: 5 })].z === 'yyyy/m/d');
  ok('计划表日期列已居中', al(ws, 1, 4).horizontal === 'center' && al(ws, 1, 5).horizontal === 'center');
}
{
  const { ws } = diffSheet({ phases: [{ id: 'p1', name: '阶段1' }], baseline: [{ id: 't1', phaseId: 'p1', title: '任务A', assignee: '张三', estimateDays: 2, done: false, startDate: '2026-01-01', dueDate: '2026-01-03' }], tasks: [{ id: 't1', phaseId: 'p1', title: '任务A', assignee: '张三', estimateDays: 3, done: false, startDate: '2026-01-02', dueDate: '2026-01-04' }] });
  const cells = [4, 5, 6, 7].map(c => ws[S.utils.encode_cell({ r: 1, c })]);
  ok('差异对比四个日期列均为真日期', cells.every(c => c.t === 'd'));
  ok('差异对比四个日期列均套用 yyyy/m/d', cells.every(c => c.z === 'yyyy/m/d'));
  ok('差异对比日期值正确（初版/最新各两个）', cells.map(c => normDate(c.v)).join('|') === '2026-01-01|2026-01-03|2026-01-02|2026-01-04', cells.map(c => normDate(c.v)));
}
// 序列化校验：生成的 xlsx（默认不压缩，XML 明文）里必须真的带 fill/border/居中样式
const xml = b => b.toString('utf8');
ok('计划表 xlsx 内写入了居中样式', /<alignment horizontal="center" vertical="center"\/>/.test(xml(buf1)));
ok('计划表 xlsx 内写入了深蓝填充（fgColor=#1F4E78）', /<fill[^>]*>[\s\S]*?fgColor rgb="FF1F4E78"/.test(xml(buf1)));
ok('计划表 xlsx 内写入了细边框', /<left style="thin"><color rgb="FF000000"/.test(xml(buf1)) && /<top style="thin"><color rgb="FF000000"/.test(xml(buf1)));
ok('差异对比 xlsx 内写入了居中样式', /<alignment horizontal="center" vertical="center"\/>/.test(xml(buf2)));
ok('差异对比 xlsx 内写入了深蓝填充', /<fill[^>]*>[\s\S]*?fgColor rgb="FF1F4E78"/.test(xml(buf2)));

// --- 待办清单排版（v1.5.4）：与计划表统一（深蓝表头 / 细黑边框 / 全列居中 / 日期 yyyy/m/d 真日期）---
// 结构差异：待办是 0 标题 / 1 表头 / 2 起数据，所以样式与日期格式的起始行都不是 0/1，需单独锁定。
const hasThinAllT = (b) => b && b.top && b.top.style === 'thin' && b.bottom && b.bottom.style === 'thin' && b.left && b.left.style === 'thin' && b.right && b.right.style === 'thin';
{
  const W = { name: 'P1', tasks: [
    { title: '模具问题点汇总', estimateDays: 3, startDate: '2026-09-08', dueDate: '2026-09-12' }, // 周期内到期
    { title: '可靠性测试排程', estimateDays: 2, startDate: '2026-09-09', dueDate: '2026-09-11' }, // 周期内到期
  ] };
  const { ws } = todoSheet([W], '2026-09-07', '2026-09-13', 'week');
  ok('待办表头行（第 2 行）6 列深蓝填充', Array.from({ length: 6 }, (_, c) => (fl(ws, 1, c).fgColor || {}).rgb === 'FF1F4E78').every(Boolean),
    Array.from({ length: 6 }, (_, c) => (fl(ws, 1, c).fgColor || {}).rgb));
  ok('待办表头行白字加粗', Array.from({ length: 6 }, (_, c) => (fnt(ws, 1, c).color || {}).rgb === 'FFFFFFFF' && fnt(ws, 1, c).bold === true).every(Boolean));
  ok('待办表头行水平居中', Array.from({ length: 6 }, (_, c) => al(ws, 1, c).horizontal).every(h => h === 'center'));
  ok('待办数据行 6 列全部居中（含项目/任务列）', Array.from({ length: 6 }, (_, c) => al(ws, 2, c).horizontal).every(h => h === 'center'),
    Array.from({ length: 6 }, (_, c) => al(ws, 2, c).horizontal));
  ok('待办数据行四边细边框', Array.from({ length: 6 }, (_, c) => hasThinAllT(bd(ws, 2, c))).every(Boolean));
  ok('待办日期列为真日期单元格', ws[S.utils.encode_cell({ r: 2, c: 3 })].t === 'd' && ws[S.utils.encode_cell({ r: 2, c: 4 })].t === 'd');
  ok('待办日期列套用 yyyy/m/d', ws[S.utils.encode_cell({ r: 2, c: 3 })].z === 'yyyy/m/d' && ws[S.utils.encode_cell({ r: 2, c: 4 })].z === 'yyyy/m/d');
  ok('待办日期值正确（真日期非文本）', normDate(ws[S.utils.encode_cell({ r: 2, c: 3 })].v) === '2026-09-08' && normDate(ws[S.utils.encode_cell({ r: 3, c: 4 })].v) === '2026-09-11',
    [normDate(ws[S.utils.encode_cell({ r: 2, c: 3 })].v), normDate(ws[S.utils.encode_cell({ r: 3, c: 4 })].v)]);
  ok('待办表头行未被套日期格式（startRow 生效）', !ws[S.utils.encode_cell({ r: 1, c: 4 })].z, ws[S.utils.encode_cell({ r: 1, c: 4 })].z);
  // 顺延（nextweek）行的状态列红字加粗必须保留：这是待办唯一的功能性高亮，别被统一配色冲掉
  const { ws: wsNW } = todoSheet([{ name: 'P2', tasks: [{ title: '顺延任务', estimateDays: 1, startDate: '2026-09-01', dueDate: '2026-09-11', carryover: true, overdue: true }] }], '2026-09-14', '2026-09-20', 'nextweek');
  ok('待办顺延行状态列红字加粗保留', (fnt(wsNW, 2, 5).color || {}).rgb === 'FFE0241B' && fnt(wsNW, 2, 5).bold === true, fnt(wsNW, 2, 5));
  ok('待办顺延行其余列仍为黑字居中', (fnt(wsNW, 2, 1).color || {}).rgb === 'FF000000' && al(wsNW, 2, 1).horizontal === 'center');
  const b = buildTodoXlsx([W], '2026-09-07', '2026-09-13', 'week');
  ok('待办 xlsx 内写入了居中样式', /<alignment horizontal="center" vertical="center"/.test(xml(b)));
  ok('待办 xlsx 内写入了深蓝填充', /<fill[^>]*>[\s\S]*?fgColor rgb="FF1F4E78"/.test(xml(b)));
  ok('待办 xlsx 内写入了细黑边框', /<left style="thin"><color rgb="FF000000"/.test(xml(b)));
  ok('待办 xlsx 内写入了 numFmt yyyy/m/d', /formatCode="yyyy\/m\/d"/.test(xml(b)));
  // 列宽：日期列必须按显示宽度（≈12）估，不能被 Date 默认字符串撑到 max 40
  const cw = computeTodoCols([['标题'], ['项目', '任务', 1, dateCell('2026-09-13'), dateCell('2026-10-15'), '本周待办']]);
  ok('待办日期列宽按显示宽度估算（<20）', cw[3].wch < 20 && cw[4].wch < 20, [cw[3].wch, cw[4].wch]);

  // 内容一致性回归锁：导出的任务集合必须等于待办页看到的集合
  // ① 逾期任务（dueDate < 周期一）必须保留并标红 —— 曾因 filter 写成 dueDate >= monIso 被整批丢掉
  const { ws: wsOv } = todoSheet([{ name: 'P3', tasks: [
    { title: '逾期任务', estimateDays: 3, startDate: '2026-08-31', dueDate: '2026-09-04' },
    { title: '本周任务', estimateDays: 1, startDate: '2026-09-08', dueDate: '2026-09-12' },
  ] }], '2026-09-07', '2026-09-13', 'week');
  ok('待办导出保留逾期任务（与待办页一致）', wsOv[S.utils.encode_cell({ r: 2, c: 1 })].v === '逾期任务' && normDate(wsOv[S.utils.encode_cell({ r: 2, c: 4 })].v) === '2026-09-04',
    [wsOv[S.utils.encode_cell({ r: 2, c: 1 })].v, normDate(wsOv[S.utils.encode_cell({ r: 2, c: 4 })].v)]);
  ok('待办逾期任务状态列显示 ⚠ 逾期且红字加粗', wsOv[S.utils.encode_cell({ r: 2, c: 5 })].v === '⚠ 逾期' && (fnt(wsOv, 2, 5).color || {}).rgb === 'FFE0241B');
  ok('待办逾期任务排在同项目最前（逾期优先）', wsOv[S.utils.encode_cell({ r: 3, c: 1 })].v === '本周任务');
  // ② nextweek 非顺延任务必须有窗口上界，否则下下周任务会混进来
  const { ws: wsNx } = todoSheet([{ name: 'P4', tasks: [
    { title: '下周内任务', estimateDays: 1, startDate: '2026-09-15', dueDate: '2026-09-17' },
    { title: '下下周任务', estimateDays: 1, startDate: '2026-09-22', dueDate: '2026-09-25' },
  ] }], '2026-09-14', '2026-09-20', 'nextweek');
  const nxTitles = [2, 3].map(r => { const c = wsNx[S.utils.encode_cell({ r, c: 1 })]; return c ? c.v : ''; });
  ok('nextweek 只含下周窗口内任务（无上界会混入下下周）', nxTitles[0] === '下周内任务' && nxTitles[1] !== '下下周任务', nxTitles);
  // ③ 无截止日期的任务不进待办（与前端 done||!dueDate 一致）
  const { ws: wsNoDue } = todoSheet([{ name: 'P5', tasks: [
    { title: '无截止日任务', estimateDays: 1, startDate: '', dueDate: '' },
    { title: '有截止日任务', estimateDays: 1, startDate: '2026-09-07', dueDate: '2026-09-09' },
  ] }], '2026-09-07', '2026-09-13', 'week');
  ok('无截止日期任务不进待办', wsNoDue[S.utils.encode_cell({ r: 2, c: 1 })].v === '有截止日任务' && !wsNoDue[S.utils.encode_cell({ r: 3, c: 1 })]);
}

console.log('\n========== lib/xlsx-export 单测 ==========');
console.log(fail === 0 ? ('✅ 通过 ' + pass + '/' + pass) : ('❌ 失败 ' + fail + '/' + (pass + fail) + '  [' + fails.join(', ') + ']'));
process.exit(fail === 0 ? 0 : 1);
