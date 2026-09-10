// Excel 导出函数（计划表/差异对比/周报待办/聚合报告），原 server.js 内联块抽取为纯函数，便于单测
// 2026-08-31：抽到 lib/，server.js 改为 require 调用；新增 safeCell 公式注入转义（防御纵深，P1 加固）
const XLSX = require('xlsx');
const XLSXS = require('xlsx-js-style'); // 支持单元格样式（周报待办/聚合报告导出用）

// 公式注入防御：用户输入若以 = + - @ 开头，前缀 ' 转义为文本。
// 当前 xlsx 路径 SheetJS 默认存文本型 cell（Excel 不执行），但为 CSV 导出 / 二次导入兜底（P1-4）
function safeCell(v) {
  if (typeof v === 'string' && /^[-=+@]/.test(v)) return "'" + v;
  return v;
}

// 待办清单自适应列宽（方案 B）：按单元格字符长度估算（中文/全角 ×1.8，英文/数字 ×1），
// 跳过标题合并行(ri=0)避免撑爆首列；min 8 / max 40 防过窄过宽。返回 6 列 {wch} 数组。
function computeTodoCols(rows) {
  const colW = [0, 0, 0, 0, 0, 0];
  const calcW = s => {
    if (s == null) return 0;
    if (s instanceof Date) return 12; // 真日期按 '2026/9/13' 显示宽度估，别用 Date 默认字符串（会撑到 max 40）
    let w = 0;
    for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2000 ? 1.8 : 1;
    return w + 2; // 内边距
  };
  rows.forEach((row, ri) => { if (ri === 0) return; row.forEach((cell, ci) => { const w = calcW(cell); if (w > colW[ci]) colW[ci] = w; }); });
  return colW.map(w => ({ wch: Math.max(8, Math.min(40, w)) }));
}

// 计划表日期单元格：ISO '2026-09-13' → Excel 真日期（Date 对象），显示格式统一为 2026/9/13（无前导零）。
// 为什么用真日期而不是格式化文本：文本 '2026/9/1' 在 Excel 排序时会排在 '2026/10/1' 之后（字典序错乱），
// 真日期则排序/筛选/日期运算全部正确，且 numFmt 控制显示，导入侧 normDate 也能回解析为 ISO（闭环无损）。
// 用「本地正午」而非零点：xlsx 写序列号时有分钟级浮点残差，正午可确保任何时区偏移下都落在正确的一天。
function dateCell(s) {
  if (!s) return '';
  const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(s); // 非 ISO 原样写文本（异常值不丢，便于人工发现）
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}
// 日期显示格式（Excel numFmt）：2026/9/13
const PLAN_DATE_FMT = 'yyyy/m/d';
// 给指定列的数据行日期单元格套用显示格式。
// 注意 cellDates 开关会影响单元格类型：开了是 t='d'，没开会被 aoa_to_sheet 转成 t='n' 序列号，
// 两种情况都要覆盖（双保险），否则 z 设不上、日期会退回默认 m/d/yy 显示。
// startRow 用于表头不在首行的表（如待办清单：0 标题 / 1 表头 / 2 起数据）
function setDateFmt(ws, nRows, cols, startRow = 1) {
  for (let r = startRow; r < nRows; r++) {
    for (const c of cols) {
      const cell = ws[XLSXS.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const isDate = cell.t === 'd' ||
        (cell.t === 'n' && typeof cell.v === 'number' && cell.v > 20000 && cell.v < 80000); // Excel 日期序列号区间
      if (isDate) cell.z = PLAN_DATE_FMT;
    }
  }
}

// 计划表 / 差异对比的排版样式：表头深蓝底白字加粗、整张表细黑线边框、指定列居中。
// centerCols 为 0 基列号数组；约定传 0..nCols-1 即「全部居中」。
// 颜色：表头 #1F4E78（深蓝·PowerPoint「蓝，个性色 1，深 25%」的近似色）；
//       白字加粗微软雅黑，数据行黑色微软雅黑细边框 #000000。
function stylePlanSheet(ws, nRows, nCols, centerCols) {
  const FONT = { name: '微软雅黑', sz: 11 };
  const THIN = { style: 'thin', color: { rgb: 'FF000000' } };
  const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const HEADER_FILL = { patternType: 'solid', fgColor: { rgb: 'FF1F4E78' } };
  const HEADER_FONT = { ...FONT, bold: true, color: { rgb: 'FFFFFFFF' } };
  const setCell = (r, c, s) => {
    const a = XLSXS.utils.encode_cell({ r, c });
    if (!ws[a]) ws[a] = { t: 's', v: '' };
    ws[a].s = s;
  };
  const center = centerCols.indexOf.bind(centerCols);
  // 表头行（第 1 行）：深蓝底 + 白字加粗 + 居中 + 细边框
  for (let c = 0; c < nCols; c++) {
    setCell(0, c, {
      font: HEADER_FONT,
      fill: HEADER_FILL,
      alignment: { horizontal: 'center', vertical: 'center' },
      border: BORDER
    });
  }
  // 数据行
  for (let r = 1; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const h = center(c) >= 0 ? 'center' : 'left';
      setCell(r, c, { font: FONT, alignment: { horizontal: h, vertical: 'center' }, border: BORDER });
    }
  }
}

// 计划表 worksheet（含居中样式）。拆出 sheet 构建是为了可复用：
// 需要把多个表拼进同一个工作簿时，直接取 ws 即可（重新 read 会丢失 cell.s 样式，见 xlsx-js-style 限制）。
function planSheet(proj, tasks) {
  const phaseName = {}; (proj.phases || []).forEach(p => phaseName[p.id] = p.name || p.id);
  const rows = [['序号', '阶段', '任务', '负责人', '开始日期', '截止日期', '工期(天)', '状态', '备注']];
  tasks.forEach((t, i) => {
    rows.push([i + 1, phaseName[t.phaseId] || t.phaseId || '', safeCell(t.title || ''), safeCell(t.assignee || ''), dateCell(t.startDate), dateCell(t.dueDate), t.estimateDays || 0, t.done ? '已完成' : '未完成', safeCell(t.note || '')]);
  });
  const ws = XLSXS.utils.aoa_to_sheet(rows, { cellDates: true });
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 38 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 32 }];
  // 全部列居中（含任务）—— 0 序号 / 1 阶段 / 2 任务 / 3 负责人 / 4 开始日期 / 5 截止日期 / 6 工期(天) / 7 状态 / 8 备注
  stylePlanSheet(ws, rows.length, 9, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  setDateFmt(ws, rows.length, [4, 5]);
  return { ws, name: '计划表' };
}
function buildPlanXlsx(proj, tasks) {
  const { ws } = planSheet(proj, tasks);
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, '计划表');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
// 差异对比 worksheet（含居中样式），同 planSheet 拆出以便复用
function diffSheet(proj) {
  const phaseName = {}; (proj.phases || []).forEach(p => phaseName[p.id] = p.name || p.id);
  const baseMap = {}; (proj.baseline || []).forEach(t => baseMap[t.id] = t);
  const nowMap = {}; (proj.tasks || []).forEach(t => nowMap[t.id] = t);
  const allIds = [...new Set([...Object.keys(baseMap), ...Object.keys(nowMap)])];
  const rows = [['序号', '阶段', '任务', '负责人', '初版开始', '初版截止', '最新开始', '最新截止', '工期(天)', '状态', '变动说明']];
  let i = 0;
  allIds.forEach(id => {
    const b = baseMap[id], n = nowMap[id];
    const ph = (n || b).phaseId;
    const title = (n && n.title) || (b && b.title) || '';
    const who = (n && n.assignee) || (b && b.assignee) || '';
    const bStart = b ? b.startDate || '' : '', bDue = b ? b.dueDate || '' : '';
    const nStart = n ? n.startDate || '' : '', nDue = n ? n.dueDate || '' : '';
    const days = n ? n.estimateDays : (b ? b.estimateDays : 0);
    const nDone = n ? !!n.done : false, bDone = b ? !!b.done : false;
    const status = nDone ? '已完成' : '未完成';
    const parts = [];
    if (!n && b) parts.push('已删除');
    else if (n && !b) parts.push('新增');
    else {
      if (bStart !== nStart || bDue !== nDue) parts.push('日期调整');
      if (days !== (b ? b.estimateDays : days)) parts.push('工期变更');
      if (nDone && !bDone) parts.push('已完成');
      else if (!nDone && bDone) parts.push('退回未完成');
    }
    const change = parts.length ? parts.join('、') : '—';
    rows.push([++i, phaseName[ph] || ph || '', safeCell(title), safeCell(who), dateCell(bStart), dateCell(bDue), dateCell(nStart), dateCell(nDue), days, status, change]);
  });
  const ws = XLSXS.utils.aoa_to_sheet(rows, { cellDates: true });
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 38 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 22 }];
  // 全部列居中（含任务）—— 0 序号 / 1 阶段 / 2 任务 / 3 负责人 / 4-7 四个日期 / 8 工期(天) / 9 状态 / 10 变动说明
  stylePlanSheet(ws, rows.length, 11, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  setDateFmt(ws, rows.length, [4, 5, 6, 7]);
  return { ws, name: '差异对比' };
}
function buildDiffXlsx(proj) {
  const { ws } = diffSheet(proj);
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, '差异对比');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* 周报待办清单 worksheet（含样式：与计划表/差异对比统一）—— 0 标题 / 1 表头 / 2 起数据。
   拆出 sheet 构建同 planSheet：需要把多个表拼进同一工作簿时直接取 ws（重新 read 会丢样式）。 */
function todoSheet(projects, monIso, sunIso, kind) {
  const fmt = s => s ? s.slice(5).replace('-', '/') : '';
  // 状态列 / 标题按导出范围动态生成（避免日/月导出时仍显示「本周待办」）
  const statusLabel = kind === 'today' ? '今日待办' : kind === 'month' ? '本月待办' : kind === 'nextweek' ? '下周待办' : '本周待办';
  const titleText = kind === 'today'
    ? `今日待办清单（${fmt(monIso)}）`
    : kind === 'month'
      ? `本月待办清单（${fmt(monIso)} — ${fmt(sunIso)}）`
      : kind === 'nextweek'
        ? `下周待办清单（${fmt(monIso)} — ${fmt(sunIso)}）`
        : `项目周报 · 待办清单（${fmt(monIso)} — ${fmt(sunIso)}）`;
  const groups = [];
  (projects || []).forEach(p => {
    const list = (p.tasks || []).filter(t => {
      if (t.done || !t.dueDate) return false;              // 已完成 / 无截止日期的任务不进待办（与前端 collectTodos 一致）
      if (kind === 'nextweek') {
        if (t.carryover) return true;                      // 本周未完成顺延：无条件纳入（不因 dueDate<下周一日被窗口筛掉）
        return t.dueDate >= monIso && t.dueDate <= sunIso;  // 下周计划：到期日落在下周窗口内（漏上界会把下下周任务也带进来）
      }
      // 逾期 + 周期内到期：语义必须与待办页 collectTodos 完全一致。
      // ⚠ 历史 bug：这里曾写成 `dueDate >= monIso`（要求到期日在周期之后），导致待办页明明显示的逾期任务
      //   在导出时被整批丢掉，且下方 overdue 分支永远不可达 —— 导出内容必须等于用户看到的页面。
      if (t.startDate && t.startDate > sunIso) return false; // 周期结束后才启动的排期任务不算本期待办
      return t.dueDate <= sunIso;
    }).map(t => ({ ...t, overdue: kind === 'nextweek' ? !!t.overdue : (!!t.dueDate && t.dueDate < monIso) }));
    if (list.length) groups.push({ p, list });
  });
  groups.sort((a, b) => (b.list.filter(t => t.overdue).length - a.list.filter(t => t.overdue).length) || a.p.name.localeCompare(b.p.name, 'zh'));
  // 样式与计划表/差异对比统一：表头深蓝 #1F4E78 白字加粗、整表细黑线边框、全部列居中、日期为 yyyy/m/d 真日期
  const HEADER_BG = 'FF1F4E78';
  const THIN = { style: 'thin', color: { rgb: 'FF000000' } };
  const BD = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const FONT = { name: '微软雅黑', sz: 11 };
  const rows = [[titleText], ['项目', '任务', '工期(天)', '开始日期', '截止日期', '状态']];
  groups.forEach(({ p, list }) => list.forEach((t, ti) => {
    const stVal = kind === 'nextweek' ? (t.carryover ? '⚠ 本周未完成·顺延' : '下周计划') : (t.overdue ? '⚠ 逾期' : statusLabel);
    rows.push([ti === 0 ? safeCell(p.name) : '', safeCell(t.title), t.estimateDays || '', dateCell(t.startDate), dateCell(t.dueDate), stVal]);
  }));
  const ws = XLSXS.utils.aoa_to_sheet(rows, { cellDates: true });
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  let rr = 2;
  groups.forEach(({ list }) => { if (list.length > 1) merges.push({ s: { r: rr, c: 0 }, e: { r: rr + list.length - 1, c: 0 } }); rr += list.length; });
  ws['!merges'] = merges;
  // 自适应列宽（方案 B）：computeTodoCols 按内容长度估算每列宽，状态列不再写死 12 导致顺延文案被遮
  ws['!cols'] = computeTodoCols(rows);
  ws['!rows'] = [{ hpt: 34 }, { hpt: 26 }];
  for (let i = 2; i < rows.length; i++) ws['!rows'].push({ hpt: 22 }); // 数据行高，配合状态列换行兜底
  const setCell = (r, c, s) => { const a = XLSXS.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = s; };
  const titleS = { font: { ...FONT, bold: true, sz: 16, color: { rgb: 'FFFFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: HEADER_BG } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 6; c++) setCell(0, c, titleS);
  const headS = { font: { ...FONT, bold: true, color: { rgb: 'FFFFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: HEADER_BG } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 6; c++) setCell(1, c, headS);
  let r = 2;
  groups.forEach(({ p, list }) => {
    list.forEach((t) => {
      const ov = t.overdue;
      for (let c = 0; c < 6; c++) {
        setCell(r, c, {
          font: { ...FONT, color: { rgb: ov && c === 5 ? 'FFE0241B' : 'FF000000' }, bold: !!(ov && c === 5) },
          fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: c === 5 },
          border: BD
        });
      }
      r++;
    });
  });
  setDateFmt(ws, rows.length, [3, 4], 2); // 数据行从第 3 行开始（0 标题 / 1 表头）
  return { ws, name: '待办清单' };
}
function buildTodoXlsx(projects, monIso, sunIso, kind) {
  const { ws } = todoSheet(projects, monIso, sunIso, kind);
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, '待办清单');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* 聚合报告导出：按人汇总（样式同周报：矢车菊蓝表头 + 隔行浅蓝） */
function buildReportXlsx(rows) {
  const ACCENT1_50 = '1F3864', ZEBRA = 'F2F7FD';
  const THIN = { style: 'thin', color: { rgb: 'B4C7E7' } };
  const BD = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const FONT = { name: '微软雅黑' };
  const header = ['成员', '角色', '项目数', '任务数', '已完成', '逾期', '完成率'];
  const aoa = [['项目聚合报告'], header];
  (rows || []).forEach(r => aoa.push([safeCell(r.user.name), r.user.role, r.projects, r.tasks, r.done, r.overdue, r.rate + '%']));
  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }]; // 标题行跨列合并居中
  const setCell = (r, c, s) => { const a = XLSXS.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = s; };
  const titleS = { font: { ...FONT, bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 7; c++) setCell(0, c, titleS);
  const headS = { font: { ...FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 7; c++) setCell(1, c, headS);
  (rows || []).forEach((r, i) => {
    for (let c = 0; c < 7; c++) setCell(i + 2, c, {
      font: { ...FONT, color: { rgb: '000000' } },
      fill: { fgColor: { rgb: i % 2 === 0 ? 'FFFFFF' : ZEBRA } },
      alignment: { horizontal: c === 0 ? 'left' : 'center', vertical: 'center' },
      border: BD
    });
  });
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, '聚合报告');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { safeCell, computeTodoCols, buildPlanXlsx, buildDiffXlsx, buildTodoXlsx, buildReportXlsx, stylePlanSheet, planSheet, diffSheet, todoSheet, dateCell, setDateFmt, PLAN_DATE_FMT };
