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
    let w = 0;
    for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2000 ? 1.8 : 1;
    return w + 2; // 内边距
  };
  rows.forEach((row, ri) => { if (ri === 0) return; row.forEach((cell, ci) => { const w = calcW(cell); if (w > colW[ci]) colW[ci] = w; }); });
  return colW.map(w => ({ wch: Math.max(8, Math.min(40, w)) }));
}

function buildPlanXlsx(proj, tasks) {
  const phaseName = {}; (proj.phases || []).forEach(p => phaseName[p.id] = p.name || p.id);
  const rows = [['序号', '阶段', '任务', '负责人', '开始日期', '截止日期', '工期(天)', '状态', '备注']];
  tasks.forEach((t, i) => {
    rows.push([i + 1, phaseName[t.phaseId] || t.phaseId || '', safeCell(t.title || ''), safeCell(t.assignee || ''), t.startDate || '', t.dueDate || '', t.estimateDays || 0, t.done ? '已完成' : '未完成', safeCell(t.note || '')]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '计划表');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function buildDiffXlsx(proj) {
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
    rows.push([++i, phaseName[ph] || ph || '', safeCell(title), safeCell(who), bStart, bDue, nStart, nDue, days, status, change]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '差异对比');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* 周报待办清单导出：生成带样式的 xlsx（矢车菊蓝·着色1·深度50% 标题/表头 + 标准 Excel 网格） */
function buildTodoXlsx(projects, monIso, sunIso, kind) {
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
      if (t.done) return false;
      if (kind === 'nextweek') {
        if (t.carryover) return true;                                   // 本周未完成顺延：无条件纳入（不因 dueDate<下周一日被窗口筛掉）
        return t.dueDate >= monIso && (!t.startDate || t.startDate <= sunIso); // 下周计划：落在下周内
      }
      return (!t.startDate || t.startDate <= sunIso) && (!t.dueDate || t.dueDate >= monIso);
    }).map(t => ({ ...t, overdue: kind === 'nextweek' ? !!t.overdue : (!!t.dueDate && t.dueDate < monIso) }));
    if (list.length) groups.push({ p, list });
  });
  groups.sort((a, b) => (b.list.filter(t => t.overdue).length - a.list.filter(t => t.overdue).length) || a.p.name.localeCompare(b.p.name, 'zh'));
  // 矢车菊蓝 着色1 深度50%（Excel 主题色 #1F3864）；表头同色，数据隔行浅蓝
  const ACCENT1_50 = '1F3864', ZEBRA = 'F2F7FD';
  const THIN = { style: 'thin', color: { rgb: 'B4C7E7' } };
  const BD = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const FONT = { name: '微软雅黑' };
  const rows = [[titleText], ['项目', '任务', '工期(天)', '开始日期', '截止日期', '状态']];
  groups.forEach(({ p, list }) => list.forEach((t, ti) => {
    const stVal = kind === 'nextweek' ? (t.carryover ? '⚠ 本周未完成·顺延' : '下周计划') : (t.overdue ? '⚠ 逾期' : statusLabel);
    rows.push([ti === 0 ? safeCell(p.name) : '', safeCell(t.title), t.estimateDays || '', fmt(t.startDate), fmt(t.dueDate), stVal]);
  }));
  const ws = XLSXS.utils.aoa_to_sheet(rows);
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  let rr = 2;
  groups.forEach(({ list }) => { if (list.length > 1) merges.push({ s: { r: rr, c: 0 }, e: { r: rr + list.length - 1, c: 0 } }); rr += list.length; });
  ws['!merges'] = merges;
  // 自适应列宽（方案 B）：computeTodoCols 按内容长度估算每列宽，状态列不再写死 12 导致顺延文案被遮
  ws['!cols'] = computeTodoCols(rows);
  ws['!rows'] = [{ hpt: 34 }, { hpt: 26 }];
  for (let i = 2; i < rows.length; i++) ws['!rows'].push({ hpt: 22 }); // 数据行高，配合状态列换行兜底
  const setCell = (r, c, s) => { const a = XLSXS.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = s; };
  const titleS = { font: { ...FONT, bold: true, sz: 16, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 6; c++) setCell(0, c, titleS);
  const headS = { font: { ...FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 6; c++) setCell(1, c, headS);
  let r = 2;
  groups.forEach(({ p, list }, gi) => {
    const zebra = gi % 2 === 0 ? 'FFFFFF' : ZEBRA;
    list.forEach((t, ti) => {
      const ov = t.overdue;
      for (let c = 0; c < 6; c++) {
        setCell(r, c, {
          font: { ...FONT, color: { rgb: ov && c === 5 ? 'E0241B' : '000000' }, bold: !!(ov && c === 5) },
          fill: { fgColor: { rgb: ti === 0 && c === 0 ? ZEBRA : zebra } },
          alignment: { horizontal: c === 0 || c === 1 ? 'left' : 'center', vertical: 'center', wrapText: c === 5 },
          border: BD
        });
      }
      r++;
    });
  });
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

module.exports = { safeCell, computeTodoCols, buildPlanXlsx, buildDiffXlsx, buildTodoXlsx, buildReportXlsx };
