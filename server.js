const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const XLSX = require('xlsx');
const XLSXS = require('xlsx-js-style'); // 支持单元格样式（周报待办导出用）

const PORT = process.env.PORT || 5180;
const DEMO_MODE = process.argv.includes('--demo');
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
// 演示模式：加载脱敏数据集 projects.demo.json（真实 projects.json 不受影响），且免令牌鉴权
const PROJECTS_FILE = path.join(DATA, DEMO_MODE ? 'projects.demo.json' : 'projects.json');
const TEMPLATES_FILE = path.join(ROOT, 'templates.json');
const OPTIONS_FILE = path.join(DATA, 'options.json');
const RO_FLAG = path.join(DATA, 'readonly.flag');
const AI_FILE = path.join(DATA, 'ai.json');
// SQLite 数据层（node:sqlite 内置模块）：正式版 app.db / 演示版 demo.db；存量 JSON 仅作首次迁移种子
const db = require('./db.js');
const DB_FILE = path.join(DATA, DEMO_MODE ? 'demo.db' : 'app.db');

async function loadJSON(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { return fallback; } }
// 写队列：所有落盘串行化，杜绝并发覆盖；原子写：临时文件→rename，崩溃不损坏原文件
let writeQ = Promise.resolve();
function saveJSON(file, data) {
  const tmp = file + '.tmp';
  const json = JSON.stringify(data, null, 2);
  writeQ = writeQ.then(async () => {
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, file);
    gitAutoCommit(file);
  }).catch(e => { try { fs.unlinkSync(tmp); } catch (_) {} console.error('保存失败:', file, e.message); });
  return writeQ;
}
// data 目录 git 自动提交（静默失败：未初始化 git 或无可提交变更时忽略；2s 防抖合并高频写入，单进程串行执行）
let GIT_OK = false;
try { GIT_OK = cp.execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'pipe' }).toString().trim() === 'true'; } catch (e) { GIT_OK = false; }
let gitPending = new Set();
let gitTimer = null;
function gitAutoCommit(file) {
  if (!GIT_OK || !file || DEMO_MODE) return;
  gitPending.add(path.relative(ROOT, file).replace(/\\/g, '/'));
  if (gitTimer) return;
  gitTimer = setTimeout(() => {
    gitTimer = null;
    const files = [...gitPending]; gitPending = new Set();
    if (!files.length) return;
    const args = files.map(f => '-- ' + JSON.stringify(f)).join(' ');
    cp.exec('git add ' + args + ' && git commit -m "data: ' + files.length + ' file(s) ' + new Date().toISOString() + '" --no-verify', { cwd: ROOT, stdio: 'ignore' }, () => {});
  }, 2000);
}
function uid() { return 'id_' + crypto.randomUUID().replace(/-/g, ''); }
function isoDate(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/* ---------- 可配置选项（项目类型/产品类型/等级/工程师类型），默认值 + 可新增；姓名/认证为手填字段 ---------- */
const DEFAULT_OPTIONS = {
  types: { 'C端': '#0A84FF', 'B端': '#30D158', '预研': '#FF9F0A', '迭代': '#BF5AF2' },
  productTypes: { 'AI': '#10a37f', 'CC线': '#06b6d4', 'DOCK': '#0ea5e9', 'MI': '#a3e635', 'MST': '#eab308', 'PD+HUB': '#f97316', 'SSD HUB': '#64748b', 'TB5': '#6366f1', 'U4': '#a855f7', 'WiFi dongle': '#14b8a6', '基础hub': '#94a3b8' },
  levels: { 'S': '#E0241B', 'A': '#FF9F0A', 'B': '#30D158', 'C': '#0A84FF', 'D': '#BF5AF2', 'E': '#64D2FF', 'F': '#8E8E93' },
  engineerTypes: ['硬件工程师', '结构工程师', '项目工程师', '测试工程师']
};
async function loadOptions() { return Object.assign({}, DEFAULT_OPTIONS, await loadJSON(OPTIONS_FILE, {})); }
function scheduleTasks(phases, tasks, startStr) {
  let cursor = new Date(startStr);
  for (const ph of phases) {
    const phTasks = tasks.filter(t => t.phaseId === ph.id);
    let pCursor = new Date(cursor);
    for (const t of phTasks) {
      const start = new Date(pCursor);
      const days = Math.max(1, t.estimateDays || 1);
      const due = addDays(start, days);
      t.startDate = isoDate(start);
      t.dueDate = isoDate(due);
      pCursor = due;
    }
    if (phTasks.length) cursor = pCursor;
  }
}

const PHASE_COLORS = ['#8b5cf6', '#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#ffd60a'];
function normDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'number' && v > 20000 && v < 80000) return isoDate(new Date(Math.round((v - 25569) * 86400000))); // Excel 序列号
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d)) return isoDate(d);
  return null;
}
function buildPlanXlsx(proj, tasks) {
  const phaseName = {}; (proj.phases || []).forEach(p => phaseName[p.id] = p.name || p.id);
  const rows = [['序号', '阶段', '任务', '负责人', '开始日期', '截止日期', '工期(天)', '状态', '备注']];
  tasks.forEach((t, i) => {
    rows.push([i + 1, phaseName[t.phaseId] || t.phaseId || '', t.title || '', t.assignee || '', t.startDate || '', t.dueDate || '', t.estimateDays || 0, t.done ? '已完成' : '未完成', t.note || '']);
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
    rows.push([++i, phaseName[ph] || ph || '', title, who, bStart, bDue, nStart, nDue, days, status, change]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '差异对比');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* 周报待办清单导出：生成带样式的 xlsx（矢车菊蓝·着色1·深度50% 标题/表头 + 标准 Excel 网格） */
function buildTodoXlsx(projects, monIso, sunIso) {
  const fmt = s => s ? s.slice(5).replace('-', '/') : '';
  const groups = [];
  (projects || []).forEach(p => {
    const list = (p.tasks || []).filter(t => {
      if (t.done) return false;
      return (!t.startDate || t.startDate <= sunIso) && (!t.dueDate || t.dueDate >= monIso);
    }).map(t => ({ ...t, overdue: !!t.dueDate && t.dueDate < monIso }));
    if (list.length) groups.push({ p, list });
  });
  groups.sort((a, b) => (b.list.filter(t => t.overdue).length - a.list.filter(t => t.overdue).length) || a.p.name.localeCompare(b.p.name, 'zh'));
  // 矢车菊蓝 着色1 深度50%（Excel 主题色 #1F3864）；表头同色，数据隔行浅蓝
  const ACCENT1_50 = '1F3864', ZEBRA = 'F2F7FD';
  const THIN = { style: 'thin', color: { rgb: 'B4C7E7' } };
  const BD = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const FONT = { name: '微软雅黑' };
  const rows = [[`项目周报 · 待办清单（${fmt(monIso)} — ${fmt(sunIso)}）`], ['项目', '任务', '里程碑', '工期(天)', '开始日期', '截止日期', '状态']];
  groups.forEach(({ p, list }) => list.forEach((t, ti) => {
    rows.push([ti === 0 ? p.name : '', t.title + (t.isMilestone ? ' ⚑' : ''), t.isMilestone ? '⚑' : '', t.estimateDays || '', fmt(t.startDate), fmt(t.dueDate), t.overdue ? '⚠ 逾期' : '本周待办']);
  }));
  const ws = XLSXS.utils.aoa_to_sheet(rows);
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  let rr = 2;
  groups.forEach(({ list }) => { if (list.length > 1) merges.push({ s: { r: rr, c: 0 }, e: { r: rr + list.length - 1, c: 0 } }); rr += list.length; });
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 20 }, { wch: 36 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  ws['!rows'] = [{ hpt: 34 }, { hpt: 26 }];
  const setCell = (r, c, s) => { const a = XLSXS.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = s; };
  const titleS = { font: { ...FONT, bold: true, sz: 16, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 7; c++) setCell(0, c, titleS);
  const headS = { font: { ...FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: ACCENT1_50 } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BD };
  for (let c = 0; c < 7; c++) setCell(1, c, headS);
  let r = 2;
  groups.forEach(({ p, list }, gi) => {
    const zebra = gi % 2 === 0 ? 'FFFFFF' : ZEBRA;
    list.forEach((t, ti) => {
      const ov = t.overdue;
      for (let c = 0; c < 7; c++) {
        setCell(r, c, {
          font: { ...FONT, color: { rgb: ov && c === 6 ? 'E0241B' : '000000' }, bold: !!(ov && c === 6) },
          fill: { fgColor: { rgb: ti === 0 && c === 0 ? ZEBRA : zebra } },
          alignment: { horizontal: c === 0 || c === 1 ? 'left' : 'center', vertical: 'center' },
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
  (rows || []).forEach(r => aoa.push([r.user.name, r.user.role, r.projects, r.tasks, r.done, r.overdue, r.rate + '%']));
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
/* ---------- 参考模版：由内置模版生成甘特方言 Excel（开始/截止带公式 → 导入后级联） ---------- */
function workdayAdd(baseStr, n) {
  const wk = [0, 6]; // weekend=1：周六日休息
  let dt = new Date(baseStr + 'T00:00:00');
  const step = n >= 0 ? 1 : -1;
  let cnt = Math.abs(n);
  while (cnt > 0) { dt.setDate(dt.getDate() + step); if (!wk.includes(dt.getDay())) cnt--; }
  return isoDate(dt);
}
function buildTemplateXlsx(tpl) {
  const phases = tpl.phases || [];
  const tasks = tpl.tasks || [];
  const phaseName = {}; phases.forEach(p => phaseName[p.id] = p.name || p.id);
  const startDate = isoDate(new Date());
  const rows = [['项目开始', startDate], ['任务', '内容', '负责人', '开始', '截止', '天数', '状态', '备注']];
  let seq = 0;
  phases.forEach(ph => {
    const phTasks = tasks.filter(t => t.phaseId === ph.id);
    rows.push([ph.name || ph.id, '', '', '', '', '', '', '']); // 分组行：任务列=阶段名，内容列空
    phTasks.forEach(t => {
      seq++;
      rows.push([seq, t.title || ('任务' + seq), t.assignee || '', '', '', Math.max(1, Number(t.estimateDays) || 1), '', t.note || '']);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 24 }];
  // 公式链：数据从 excel 第 3 行开始；跳过分组行，记录上一个任务行实现跨阶段级联
  const serial = s => Math.round((new Date(s + 'T00:00:00').getTime() / 86400000) + 25569);
  let prevTaskRow = null, cur = startDate;
  for (let r = 2; r < rows.length; r++) {
    if (!rows[r][1]) continue; // 内容列为空 → 分组行，跳过
    const R = r + 1;
    const days = Math.max(1, Number(rows[r][5]) || 1);
    const s = prevTaskRow === null ? startDate : workdayAdd(cur, 1);
    const due = workdayAdd(s, days - 1);
    cur = due;
    const startF = prevTaskRow === null ? '=WORKDAY.INTL($B$1,0)' : '=WORKDAY.INTL(E' + prevTaskRow + ',1)';
    const dueF = '=WORKDAY.INTL(D' + R + ',F' + R + '-1)';
    ws['D' + R] = { t: 'n', f: startF, v: serial(s), z: 'yyyy-mm-dd' };
    ws['E' + R] = { t: 'n', f: dueF, v: serial(due), z: 'yyyy-mm-dd' };
    prevTaskRow = R;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '参考模版');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* ---------- 公式级联：导入解析 + 依赖重算 ---------- */
function colName(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function parseTerm(s) {
  s = String(s).trim().replace(/\$/g, ''); // 兼容 $D$19 绝对引用
  const m = s.match(/^([A-Z]+\d+)\s*([+-])\s*(\d+)$/i);
  if (m) return { t: 'off', base: { t: 'ref', ref: m[1].toUpperCase() }, days: (m[2] === '-' ? -1 : 1) * parseInt(m[3]) };
  const mm = s.match(/^([A-Z]+\d+)((?:\s*[+-]\s*(?:[A-Z]+\d+|\d+))*)$/i);
  if (mm) {
    const parts = [{ t: 'ref', ref: mm[1].toUpperCase() }];
    const re = /\s*([+-])\s*([A-Z]+\d+|\d+)/gi; let q;
    while ((q = re.exec(mm[2]))) {
      const isNum = /^\d+$/.test(q[2]);
      const neg = q[1] === '-';
      parts.push(isNum ? { t: 'n', v: (neg ? -1 : 1) * parseInt(q[2]) } : { t: 'ref', ref: q[2].toUpperCase(), neg });
    }
    return { t: 'arith', parts };
  }
  const m2 = s.match(/^([A-Z]+\d+)$/i);
  if (m2) return { t: 'ref', ref: m2[1].toUpperCase() };
  const n = Number(s);
  if (s !== '' && !isNaN(n)) return { t: 'lit', v: n };
  return null;
}
function parseFormula(f) {
  if (!f) return null;
  const s = String(f).trim().replace(/^=/, '');
  const mFunc = s.match(/^WORKDAY\.INTL\s*\((.*)\)$/i);
  if (mFunc) {
    const args = mFunc[1].split(',').map(a => a.trim());
    if (args.length >= 2) return { t: 'wd', base: parseTerm(args[0]), days: parseTerm(args[1]), weekend: args.length > 2 ? (parseInt(args[2]) || 1) : 1 };
  }
  return parseTerm(s);
}
function resolveRef(proj, ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const col = m[1].toUpperCase(), row = parseInt(m[2]);
  if (proj.startCell && ref === proj.startCell.toUpperCase()) return proj.startDate || null;
  // 优先用预建的行号索引（recalcProject 拓扑排序时构建），避免线性 find（O(tasks²) → O(1)）
  const t = proj._rowMap ? proj._rowMap.get(row) : (proj.tasks || []).find(x => x.excelRow === row);
  if (!t) return null;
  if (col === 'F') return Number(t.estimateDays) || 0;
  if (col === 'D') return t.startDate;
  if (col === 'E') return t.dueDate;
  return null;
}
// 收集规则树中的所有单元格引用（供依赖图构建）
function collectRuleRefs(rule, out) {
  if (!rule) return;
  if (rule.t === 'ref') { out.push(rule.ref); return; }
  if (rule.t === 'off') { collectRuleRefs(rule.base, out); collectRuleRefs(rule.days, out); }
  else if (rule.t === 'arith') { (rule.parts || []).forEach(p => { if (p.t !== 'n') collectRuleRefs(p, out); }); }
  else if (rule.t === 'wd') { collectRuleRefs(rule.base, out); collectRuleRefs(rule.days, out); }
}
function evalRule(proj, rule, depth) {
  if (!rule || depth > 20) return null;
  if (rule.t === 'lit') return (typeof rule.v === 'number') ? normDate(rule.v) : String(rule.v);
  if (rule.t === 'ref') return resolveRef(proj, rule.ref);
  if (rule.t === 'off') { const b = evalRule(proj, rule.base, depth + 1); if (b == null) return null; if (typeof b === 'number') return b + rule.days; return isoDate(addDays(new Date(b), rule.days)); }
  if (rule.t === 'arith') {
    let date = null, total = 0;
    for (const p of rule.parts) {
      let rv;
      if (p.t === 'n') rv = p.v;
      else { rv = evalRule(proj, p, depth + 1); if (rv == null) return null; if (p.neg) rv = -rv; }
      if (typeof rv === 'number') total += rv;
      else if (!date) date = rv;
      else return null;
    }
    return date ? isoDate(addDays(new Date(date), total)) : total;
  }
  if (rule.t === 'wd') {
    const base = evalRule(proj, rule.base, depth + 1); const d = evalRule(proj, rule.days, depth + 1);
    if (!base || d == null) return null;
    const wdMap = { 1: [0, 6], 7: [0, 6], 11: [0] };
    const wk = wdMap[rule.weekend] || [0, 6];
    let dt = new Date(base + 'T00:00:00'); const step = d >= 0 ? 1 : -1; let n = Math.abs(d);
    while (n > 0) { dt.setDate(dt.getDate() + step); if (!wk.includes(dt.getDay())) n--; }
    return isoDate(dt);
  }
  return null;
}
// 公式级联重算（2026-08-25 优化）：先按依赖图拓扑排序单次线性传递（O(V+E)），
// 仅对成环任务子集保留原 60 轮迭代兜底（大项目从 O(60×N²) 降到近线性）
function recalcProject(proj) {
  const tasks = proj.tasks || [];
  if (!tasks.length) return true;
  const rowMap = new Map();
  tasks.forEach(t => { if (t.excelRow != null) rowMap.set(t.excelRow, t); });
  proj._rowMap = rowMap;
  try {
    const byId = new Map(); tasks.forEach(t => byId.set(t.id, t));
    const deps = new Map(), indeg = new Map();
    tasks.forEach(t => { deps.set(t.id, new Set()); indeg.set(t.id, 0); });
    const refsOf = t => { const out = []; if (t.startRule) collectRuleRefs(t.startRule, out); if (t.dueRule) collectRuleRefs(t.dueRule, out); return out; };
    tasks.forEach(t => {
      const set = deps.get(t.id);
      for (const ref of refsOf(t)) {
        const m = ref.match(/^([A-Z]+)(\d+)$/); if (!m) continue;
        if (proj.startCell && ref.toUpperCase() === proj.startCell.toUpperCase()) continue; // 项目开始格非任务依赖
        const dep = rowMap.get(parseInt(m[2]));
        if (dep && dep.id !== t.id && !set.has(dep.id)) set.add(dep.id);
      }
    });
    deps.forEach(set => set.forEach(d => indeg.set(d, indeg.get(d) + 1)));
    const q = tasks.filter(t => indeg.get(t.id) === 0).map(t => t.id);
    const order = [];
    while (q.length) {
      const id = q.shift(); order.push(id);
      deps.get(id).forEach(d => { indeg.set(d, indeg.get(d) - 1); if (indeg.get(d) === 0) q.push(d); });
    }
    const apply = t => {
      if (t.startRule) { const v = evalRule(proj, t.startRule, 0); if (v) t.startDate = v; }
      if (t.dueRule) { const v = evalRule(proj, t.dueRule, 0); if (v) t.dueDate = v; }
    };
    order.forEach(id => apply(byId.get(id)));
    const cyclic = tasks.filter(t => indeg.get(t.id) > 0); // 成环子集（未入拓扑序）
    if (cyclic.length) {
      for (let pass = 0; pass < 60; pass++) {
        let changed = false;
        cyclic.forEach(t => {
          if (t.startRule) { const v = evalRule(proj, t.startRule, 0); if (v && v !== t.startDate) { t.startDate = v; changed = true; } }
          if (t.dueRule) { const v = evalRule(proj, t.dueRule, 0); if (v && v !== t.dueDate) { t.dueDate = v; changed = true; } }
        });
        if (!changed) return true;
      }
      console.warn('[公式环检测] 依赖超过 60 轮未收敛，疑似公式成环:', proj.name);
      return false;
    }
    return true;
  } finally { delete proj._rowMap; }
}

const DEFAULT_MAPPING = {
  task: ['内容'], taskFallback: ['任务'], phase: ['阶段'], who: ['负责人'],
  start: ['开始'], due: ['结束', '截止'], days: ['天数', '工期'], status: ['进度', '状态'], note: ['备注'],
  skip: '插入新行|提示|说明|汇总|合计'
};
function parseXlsxProject(buf, mapping) {
  const kw = Object.assign({}, DEFAULT_MAPPING, mapping || {});
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let hi = rows.findIndex(r => Array.isArray(r) && r.some(c => c && String(c).includes('任务')));
  if (hi < 0) hi = 0;
  const headers = (rows[hi] || []).map(h => String(h == null ? '' : h).trim());
  const find = keys => { if (!keys || !keys.length) return -1; for (const k of keys) { const i = headers.findIndex(h => h && (h.includes(k) || k.includes(h))); if (i >= 0) return i; } return -1; };
  const iTitle = find(kw.task), iSeq = find(kw.taskFallback), iPhase = find(kw.phase), iWho = find(kw.who),
    iStart = find(kw.start), iDue = find(kw.due), iDays = find(kw.days), iStatus = find(kw.status), iNote = find(kw.note);
  if (iTitle < 0 && iSeq < 0) throw new Error('未找到「任务」列');
  const gantt = iTitle >= 0 && iPhase < 0; // 甘特方言：有「内容」列且无「阶段」列 → 分组行=阶段
  const skipRe = new RegExp(kw.skip || '(?!)');
  const phaseOrder = [], phaseMap = {};
  const ensurePhase = name => {
    if (phaseMap[name]) return phaseMap[name];
    const ph = { id: 'p_' + phaseOrder.length, name, color: PHASE_COLORS[phaseOrder.length % PHASE_COLORS.length] };
    phaseOrder.push(ph); phaseMap[name] = ph; return ph;
  };
  const tasks = [];
  let curPhase = null;
  let startCell = null;
  // 定位「项目开始」单元格（如 B3）
  for (let r = 0; r <= hi; r++) {
    const row = rows[r]; if (!Array.isArray(row)) continue;
    for (let i = 0; i < row.length; i++) {
      if (row[i] && String(row[i]).includes('项目开始')) { const nx = i + 1; while (nx < row.length && (row[nx] == null || row[nx] === '')) nx++; if (nx < row.length) { startCell = colName(nx) + (r + 1); break; } }
    }
    if (startCell) break;
  }
  const S = (i, r) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const sv = S(iSeq, row), tv = S(iTitle, row);
    if (!sv && !tv) continue;
    if (skipRe.test(sv + '|' + tv)) continue; // 跳过提示/汇总行
    if (gantt) {
      const hasDate = (iStart >= 0 && row[iStart] != null && row[iStart] !== '') || (iDue >= 0 && row[iDue] != null && row[iDue] !== '');
      if (!tv && !hasDate) { curPhase = ensurePhase(sv || ('阶段' + (phaseOrder.length + 1))); continue; } // 分组行 → 阶段
      const excelRow = r + 1;
      const startF = iStart >= 0 && ws[colName(iStart) + excelRow] ? ws[colName(iStart) + excelRow].f : null;
      const dueF = iDue >= 0 && ws[colName(iDue) + excelRow] ? ws[colName(iDue) + excelRow].f : null;
      tasks.push({
        title: tv || sv,
        phaseId: curPhase ? curPhase.id : ensurePhase('阶段' + (phaseOrder.length + 1)).id,
        note: iNote >= 0 ? String(row[iNote] == null ? '' : row[iNote]) : '',
        estimateDays: iDays >= 0 ? (Number(row[iDays]) || 0) : 0,
        assignee: iWho >= 0 ? String(row[iWho] == null ? '' : row[iWho]) : '',
        done: iStatus >= 0 ? /完成|done|yes|true|100/i.test(String(row[iStatus] == null ? '' : row[iStatus])) : false,
        startDate: iStart >= 0 ? normDate(row[iStart]) : null,
        dueDate: iDue >= 0 ? normDate(row[iDue]) : null,
        excelRow,
        startF: startF || '',
        dueF: dueF || '',
        startRule: parseFormula(startF),
        dueRule: parseFormula(dueF)
      });
    } else {
      const pn = iPhase >= 0 ? S(iPhase, row) : '';
      const pid = (pn && phaseMap[pn]) ? phaseMap[pn].id : ensurePhase(pn || ('阶段' + (phaseOrder.length + 1))).id;
      tasks.push({
        title: sv,
        phaseId: pid,
        note: iNote >= 0 ? String(row[iNote] == null ? '' : row[iNote]) : '',
        estimateDays: iDays >= 0 ? (Number(row[iDays]) || 0) : 0,
        assignee: iWho >= 0 ? String(row[iWho] == null ? '' : row[iWho]) : '',
        done: iStatus >= 0 ? /完成|done|yes|true|100/i.test(String(row[iStatus] == null ? '' : row[iStatus])) : false,
        startDate: iStart >= 0 ? normDate(row[iStart]) : null,
        dueDate: iDue >= 0 ? normDate(row[iDue]) : null
      });
    }
  }
  const eff = {
    task: iTitle >= 0 ? headers[iTitle] : '', taskFallback: iSeq >= 0 ? headers[iSeq] : '', phase: iPhase >= 0 ? headers[iPhase] : '',
    groupPhase: gantt, who: iWho >= 0 ? headers[iWho] : '', start: iStart >= 0 ? headers[iStart] : '',
    due: iDue >= 0 ? headers[iDue] : '', days: iDays >= 0 ? headers[iDays] : '', status: iStatus >= 0 ? headers[iStatus] : '', note: iNote >= 0 ? headers[iNote] : ''
  };
  return { tasks, phases: phaseOrder, mapping: eff, startCell };
}

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(PROJECTS_FILE)) saveJSON(PROJECTS_FILE, []);
if (!fs.existsSync(TEMPLATES_FILE)) saveJSON(TEMPLATES_FILE, []);
if (!fs.existsSync(OPTIONS_FILE)) saveJSON(OPTIONS_FILE, DEFAULT_OPTIONS);
// 初始化 SQLite 数据层 + 引导：正式版建 admin 并迁移存量 projects.json，演示版建 demo 用户；都确保 guest 游客账号
db.init(DB_FILE);
if (DEMO_MODE) db.ensureDemoUser(PROJECTS_FILE);
else db.ensureAdminAndMigrate(PROJECTS_FILE);
db.ensureGuestUser();

// 首次运行（非演示模式）若项目库为空，自动播种一个示例项目，避免用户看到空白首屏
(() => {
  if (DEMO_MODE) return;
  try {
    if (db.listProjects(null, true).length === 0) {
      const tpls = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
      const tpl = (tpls.find(t => /音箱|语音|speaker/i.test(t.name)) || tpls[0]);
      if (tpl) {
        const admin = db.getUserByName('admin');
        const seed = createFromTemplate(tpl, tpl.name + '（示例）', { type: 'C端', level: 'B', productType: 'AI', cert: 'CCC', engineers: { hardware: '张工', structure: '李工', project: '王工' } });
        db.saveProject(seed, admin.id);
        console.log('[种子] 已生成示例项目：' + seed.name + '（' + seed.tasks.length + ' 个任务）');
      }
    }
  } catch (e) { /* 不影响启动 */ }
})();

/* ---------- AI 助手：OpenAI 兼容接口（Node 原生 https/http，无额外依赖；支持本地大模型） ---------- */
async function loadAI() {
  const cfg = Object.assign({ base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: '', local: false }, await loadJSON(AI_FILE, {}));
  const envKey = (process.env.KB_AI_API_KEY || '').trim();
  if (envKey) cfg.api_key = envKey; // 环境变量优先（KB_AI_API_KEY），且密钥不落盘
  return cfg;
}
async function saveAI(cfg) {
  try {
    const out = Object.assign({}, cfg);
    if ((process.env.KB_AI_API_KEY || '').trim()) out.api_key = ''; // 有环境变量时密钥不写盘
    await fsp.writeFile(AI_FILE, JSON.stringify(out, null, 2));
  } catch (e) {}
  return cfg;
}
// 已配置判定：云 Key 或本地模型（local 标志）任一即可
function aiConfigured(cfg) { return !!(cfg && (cfg.api_key || cfg.local)); }
function maskKey(k) { if (!k) return ''; const s = String(k); if (s.length <= 8) return '****'; return s.slice(0, 3) + '****' + s.slice(-4); }
function chatCompletions(cfg, messages, temperature) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    let url; try { url = new URL(base + '/chat/completions'); } catch (e) { return reject(new Error('base_url 无效')); }
    const payload = JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, temperature: (typeof temperature === 'number' ? temperature : 0.7), stream: false });
    const data = Buffer.from(payload);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key; // 本地模型无 Key 不带头
    const options = { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: 60000 };
    const req = lib.request(options, resp => {
      let buf = ''; resp.on('data', d => buf += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (t) resolve(t); else { console.error('AI 未返回内容:', (buf || '').slice(0, 300)); reject(new Error('AI 未返回内容')); }
        } catch (e) { console.error('解析 AI 响应失败:', e.message, (buf || '').slice(0, 300)); reject(new Error('解析 AI 响应失败')); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.write(data); req.end();
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png'
};
// 安全响应头（防 XSS/点击劫持/MIME 嗅探；HSTS 仅 HTTPS 生效，浏览器对 http://localhost 自动忽略）
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
function send(res, status, body) { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS)); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
const BODY_LIMIT = 10 * 1024 * 1024; // 请求体上限 10MB
// 内存速率限制（登录防爆破 / AI 防额度滥用；过期桶定时清理，防 Map 无限增长）
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.t > windowMs) { b = { n: 0, t: now }; rateBuckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (now - b.t > 3600000) rateBuckets.delete(k); }, 600000).unref();
// 资源版本号（静态缓存策略）：取 app.js/style.css 的 mtime 和（5s 缓存）；文件一变 → 版本号变 → ?v= 换新 → 浏览器拉新
let _assetVer = { t: 0, v: '' };
async function assetVer() {
  const now = Date.now();
  if (_assetVer.v && now - _assetVer.t < 5000) return _assetVer.v;
  try {
    const [a, s] = await Promise.all([fsp.stat(path.join(PUBLIC, 'app.js')), fsp.stat(path.join(PUBLIC, 'style.css'))]);
    _assetVer = { t: now, v: 'r' + Math.round(a.mtimeMs + s.mtimeMs).toString(36) };
    return _assetVer.v;
  } catch (e) { return 'v1'; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    let tooLarge = false;
    req.on('data', c => {
      d += c;
      if (!tooLarge && d.length > BODY_LIMIT) { tooLarge = true; req.destroy(); reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })); }
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_JSON' })); } });
    req.on('error', reject);
  });
}
// --- 多用户鉴权：每用户 token（登录下发，存 SQLite tokens 表）---
// 兼容旧单 token（data/auth.token）：校验通过时视为 admin（老前端无缝升级）
const TOKEN_FILE = path.join(DATA, 'auth.token');
function ensureToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch (e) {}
  const t = 'kb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try { fs.writeFileSync(TOKEN_FILE, t, 'utf8'); } catch (e) {}
  return t;
}
const AUTH_TOKEN = ensureToken();
function resolveUser(req) {
  if (DEMO_MODE) return { id: 'demo', name: 'demo', role: 'admin' }; // 演示版免登录，全量可见
  const h = req.headers['x-auth-token'] || req.headers.authorization;
  const uid = db.tokenUserId(h);
  if (uid) { const u = db.getUserById(uid); if (u) return u; }
  if (h === AUTH_TOKEN) { const a = db.getUserByName('admin'); if (a) return { id: a.id, name: a.name, role: a.role }; } // 旧 token 兼容 = admin
  return null;
}
function authorized(req) { return !!req.user; }

function createFromTemplate(tpl, name, opts) {
  opts = opts || {};
  const phases = (tpl.phases || []).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const tasks = (tpl.tasks || []).map(t => ({
    id: uid(), title: t.title, phaseId: t.phaseId, note: t.note || '',
    estimateDays: t.estimateDays || 0, assignee: t.assignee || '', done: false,
    startDate: null, dueDate: null
  }));
  const startDate = isoDate(new Date());
  scheduleTasks(phases, tasks, startDate);
  return {
    id: uid(), name: name || tpl.name, templateId: tpl.id,
    icon: opts.icon || tpl.icon, color: tpl.color,     startDate,
    type: opts.type || 'C端',
    level: opts.level || 'B',
    productType: opts.productType || '',
    cert: opts.cert || '',
    status: 'active', completedAt: null,
    engineers: opts.engineers || { hardware: '', structure: '', project: '' },
    createdAt: new Date().toISOString(), phases, tasks,
    baseline: tasks.map(t => ({ ...t }))
  };
}

// 只读标记（1s 缓存避免每请求读盘；切换后 1s 内生效）
let roCache = { v: false, t: 0 };
async function isRO() {
  const now = Date.now();
  if (now - roCache.t < 1000) return roCache.v;
  try { const s = await fsp.readFile(RO_FLAG, 'utf8'); roCache = { v: s.trim() === '1', t: now }; return roCache.v; }
  catch (e) { roCache = { v: false, t: now }; return false; }
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // 请求日志（响应结束打印：方法 路径 状态 耗时）
  const t0 = Date.now();
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`));
  if (p.startsWith('/api/')) {
    req.user = resolveUser(req); // 每请求解析当前用户（demo 模式恒为 admin 视角）
    // 登录接口（免鉴权，放最前）
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      if (!rateLimit('login:' + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: '登录尝试过于频繁，请 15 分钟后再试' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const u = db.verifyUser(name, String(body.password || ''));
      if (!u) return send(res, 401, { error: '用户名或密码错误' });
      const token = db.issueToken(u.id);
      return send(res, 200, { token, user: { id: u.id, name: u.name, role: u.role }, mustChange: !!u.mustChange });
    }
    // GET 接口统一鉴权（2026-08-25 两轮评审）：除登录 / 只读状态 / 本机 Ollama 探测外，其余 GET 均需登录
    const PUBLIC_GET = ['/api/readonly', '/api/ai/ollama-models'];
    if (req.method === 'GET' && !PUBLIC_GET.includes(p) && !req.user) {
      return send(res, 401, { error: '请先登录（X-Auth-Token）' });
    }
    // 请求体大小上限（content-length 预检，chunked 由 readBody 兜底断开）
    if (req.method !== 'GET' && parseInt(req.headers['content-length'] || '0', 10) > BODY_LIMIT) {
      return send(res, 413, { error: '请求体过大（上限 10MB）' });
    }
    // 自助改密（所有登录用户可调，含 viewer）
    if (p === '/api/password' && req.method === 'POST') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      const err = db.changePassword(req.user.id, String(body.old || ''), String(body.next || ''));
      if (err) return send(res, 400, { error: err });
      return send(res, 200, { ok: true });
    }
    // 最小鉴权：写操作必须登录（GET 查询不受限，projects 列表在路由内另行校验登录）
    if (req.method !== 'GET' && !authorized(req)) {
      return send(res, 401, { error: '未授权：请先登录（X-Auth-Token）' });
    }
    // viewer 只读：任何写操作一律拒绝（含项目/任务/选项/AI/用户）
    if (req.method !== 'GET' && req.user && req.user.role === 'viewer') {
      return send(res, 403, { error: '只读访客，无修改权限' });
    }
    // 用户管理（admin）：列出 / 新建 / 改角色
    if (p === '/api/users') {
      if (!DEMO_MODE && (!req.user || req.user.role !== 'admin')) return send(res, 403, { error: '仅管理员可操作' });
      if (req.method === 'GET') return send(res, 200, db.listUsers());
      if (req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        const pw = String(body.password || '');
        if (!name || pw.length < 6) return send(res, 400, { error: '用户名必填，密码至少 6 位' });
        if (db.getUserByName(name)) return send(res, 400, { error: '用户名已存在' });
        const role = ['admin', 'manager', 'member', 'viewer'].includes(body.role) ? body.role : 'member';
        const u = db.createUser(name, pw, role);
        return send(res, 201, { id: u.id, name: u.name, role: u.role });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    // 修改角色 / 删除用户（admin；不能操作自己；guest 系统账号禁删；至少保留一名管理员）
    const uOp = p.match(/^\/api\/users\/([^/]+)$/);
    if (uOp && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!DEMO_MODE && (!req.user || req.user.role !== 'admin')) return send(res, 403, { error: '仅管理员可操作' });
      const targetId = uOp[1];
      if (targetId === req.user.id) return send(res, 400, { error: '不能操作自己的账号' });
      const target = db.getUserById(targetId);
      if (!target) return send(res, 404, { error: '用户不存在' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const role = ['admin', 'manager', 'member', 'viewer'].includes(body.role) ? body.role : null;
        if (!role) return send(res, 400, { error: '角色无效' });
        if (!db.updateUserRole(targetId, role)) return send(res, 404, { error: '用户不存在' });
        return send(res, 200, { ok: true, role });
      }
      // DELETE
      if (target.name === 'guest') return send(res, 400, { error: 'guest 为系统游客账号，不可删除' });
      if (target.role === 'admin' && db.listUsers().filter(u => u.role === 'admin').length <= 1) return send(res, 400, { error: '至少保留一名管理员' });
      const r = db.deleteUser(targetId);
      if (!r.ok) return send(res, 400, { error: r.reason });
      return send(res, 200, { ok: true });
    }
    // 按人聚合报告：admin/manager/viewer 全量；member 仅自己的统计
    if (p === '/api/report' && req.method === 'GET') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const full = DEMO_MODE || ['admin', 'manager', 'viewer'].includes(req.user.role);
      const data = db.reportByUser();
      return send(res, 200, full ? data : data.filter(r => r.user.id === req.user.id));
    }
    // 聚合报告导出 xlsx（权限同 /api/report）
    if (p === '/api/report/export' && req.method === 'GET') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const full = DEMO_MODE || ['admin', 'manager', 'viewer'].includes(req.user.role);
      const data = db.reportByUser();
      const rows = full ? data : data.filter(r => r.user.id === req.user.id);
      const buf = buildReportXlsx(rows);
      const date = isoDate(new Date()).replace(/-/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="kanban_report_${date}.xlsx"; filename*=UTF-8''${encodeURIComponent('项目聚合报告_' + date + '.xlsx')}`
      });
      return res.end(buf);
    }
    // 只读模式：查询 / 切换（始终可用）
    if (p === '/api/readonly') {
      if (req.method === 'GET') return send(res, 200, { on: await isRO(), demo: DEMO_MODE });
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { fs.writeFileSync(RO_FLAG, (body && body.on) ? '1' : '0'); }
        catch (e) { return send(res, 500, { error: '切换失败' }); }
        return send(res, 200, { on: !!(body && body.on) });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    // 只读模式：拦截所有非 GET 修改请求
    if (req.method !== 'GET' && await isRO()) {
      return send(res, 403, { error: '只读模式，禁止修改' });
    }
    if (p === '/api/templates' && req.method === 'GET') return send(res, 200, await loadJSON(TEMPLATES_FILE, []));
    // 可配置选项：项目类型 / 产品类型 / 等级 / 认证 / 工程师
    if (p === '/api/options' && req.method === 'GET') return send(res, 200, await loadOptions());
    if (p === '/api/options' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return send(res, 400, { error: '参数无效' });
      const o = await loadOptions();
      ['types', 'productTypes', 'levels'].forEach(k => { if (body[k] && typeof body[k] === 'object') o[k] = body[k]; });
      ['engineerTypes'].forEach(k => { if (Array.isArray(body[k])) o[k] = body[k]; });
      saveJSON(OPTIONS_FILE, o);
      return send(res, 200, o);
    }
    // 修改模版（改名）
    const tplPut = p.match(/^\/api\/templates\/([^/]+)$/);
    if (tplPut && req.method === 'PUT') {
      const body = await readBody(req);
      const cur = await loadJSON(TEMPLATES_FILE, []);
      const t = cur.find(x => x.id === tplPut[1]);
      if (!t) return send(res, 404, { error: '模版不存在' });
      const name = body && body.name ? String(body.name).trim() : '';
      if (!name) return send(res, 400, { error: '请输入模版名称' });
      t.name = name;
      saveJSON(TEMPLATES_FILE, cur);
      return send(res, 200, t);
    }
    // 删除模版（模板共创：内置/导入的模板均可删）
    const tplDel = p.match(/^\/api\/templates\/([^/]+)$/);
    if (tplDel && req.method === 'DELETE') {
      const cur = await loadJSON(TEMPLATES_FILE, []);
      const next = cur.filter(t => t.id !== tplDel[1]);
      if (next.length === cur.length) return send(res, 404, { error: '模版不存在' });
      saveJSON(TEMPLATES_FILE, next);
      return send(res, 200, { ok: true });
    }
    // 下载参考模版（内置模版生成的甘特方言 Excel，开始/截止带公式 → 导入后甘特级联）
    if (p === '/api/templates/reference-xlsx' && req.method === 'GET') {
      const tpls = await loadJSON(TEMPLATES_FILE, []);
      const id = url.searchParams.get('tplId');
      const tpl = (id && tpls.find(t => t.id === id)) || tpls[0];
      if (!tpl) return send(res, 404, { error: '暂无内置模版' });
      const buf = buildTemplateXlsx(tpl);
      const date = isoDate(new Date()).replace(/-/g, '');
      const ascii = `kanban_reference_${date}.xlsx`;
      const utf8 = `${tpl.name}_参考模版_${date}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`
      });
      return res.end(buf);
    }

    // ---- AI 助手（OpenAI 兼容） ----
    if (p === '/api/ai/config') {
      if (req.method === 'GET') { const c = await loadAI(); return send(res, 200, { base_url: c.base_url, model: c.model, configured: aiConfigured(c), key_masked: maskKey(c.api_key), local: !!c.local }); }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const c = await loadAI();
        if (body.base_url !== undefined) c.base_url = String(body.base_url).trim() || 'https://api.openai.com/v1';
        if (body.model !== undefined) c.model = String(body.model).trim() || 'gpt-4o-mini';
        if (body.local !== undefined) c.local = !!body.local;
        // Key：留空/未传 = 保持不变（修复：旧逻辑空串会清掉已配置 Key）；显式 clear_key 才清除
        if (body.clear_key === true) c.api_key = '';
        else if (body.api_key !== undefined && body.api_key !== null && String(body.api_key).trim() !== '') c.api_key = String(body.api_key).trim();
        saveAI(c);
        return send(res, 200, { base_url: c.base_url, model: c.model, configured: aiConfigured(c), key_masked: maskKey(c.api_key), local: !!c.local });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    // 本地大模型：探测本机 Ollama（OpenAI 兼容本地服务），返回可用模型列表
    if (p === '/api/ai/ollama-models' && req.method === 'GET') {
      try {
        const body = await new Promise((resolve, reject) => {
          const rq = http.get('http://127.0.0.1:11434/api/tags', { timeout: 2000 }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => resolve(b)); });
          rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('timeout')));
        });
        const j = JSON.parse(body);
        const models = ((j.models || []).map(m => m.name)).filter(Boolean);
        return send(res, 200, { online: true, models });
      } catch (e) { return send(res, 200, { online: false, models: [] }); }
    }
    if (p === '/api/ai/chat' && req.method === 'POST') {
      if (!rateLimit('ai:' + req.user.id, 30, 60 * 1000)) return send(res, 429, { error: 'AI 调用过于频繁，请稍后再试' });
      const body = await readBody(req);
      const c = await loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key' });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return send(res, 400, { error: 'messages 为空' });
      try { const text = await chatCompletions(c, messages, body.temperature); return send(res, 200, { text }); }
      catch (e) { return send(res, 502, { error: 'AI 调用失败: ' + e.message }); }
    }
    if (p === '/api/ai/generate-tasks' && req.method === 'POST') {
      if (!rateLimit('ai:' + req.user.id, 30, 60 * 1000)) return send(res, 429, { error: 'AI 调用过于频繁，请稍后再试' });
      const body = await readBody(req);
      const desc = String(body.description || '').trim();
      if (!desc) return send(res, 400, { error: '请描述项目' });
      const c = await loadAI();
      if (!aiConfigured(c)) {
        // 离线兜底：基于内置模板的规则建议（非 LLM，界面会明确标注）
        const tpls = await loadJSON(TEMPLATES_FILE, []);
        const tpl = tpls.find(t => /音箱|语音|speaker/i.test(t.name)) || tpls[0];
        const nameMap = {}; (tpl ? tpl.phases || [] : []).forEach(ph => nameMap[ph.id] = ph.name);
        const tasks = (tpl ? tpl.tasks : []).map(t => ({ title: t.title, phase: nameMap[t.phaseId] || '', estimateDays: t.estimateDays || 3, assignee: t.assignee || '' }));
        return send(res, 200, { source: 'template', tasks, note: '未配置 AI：已用内置模板智能建议（规则生成，非大模型）' });
      }
      const sys = '你是智能硬件 NPI 项目经理。根据用户描述，仅输出一个 JSON 数组（不要任何解释文字、不要 markdown 代码块），每项结构：{title:任务名, phase:所属阶段(只能从"需求立项/设计开发/打样试制/测试验证/量产导入/上市运营"中选), estimateDays:工期天数(数字), assignee:建议负责角色}。';
      try {
        const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: desc }], 0.6);
        const m = text.match(/\[[\s\S]*\]/);
        const tasks = m ? JSON.parse(m[0]) : [];
        if (!Array.isArray(tasks) || !tasks.length) return send(res, 502, { error: 'AI 未返回有效任务清单' });
        return send(res, 200, { source: 'ai', tasks });
      } catch (e) { return send(res, 502, { error: 'AI 生成失败: ' + e.message }); }
    }
    if (p === '/api/ai/summarize' && req.method === 'POST') {
      if (!rateLimit('ai:' + req.user.id, 30, 60 * 1000)) return send(res, 429, { error: 'AI 调用过于频繁，请稍后再试' });
      const body = await readBody(req);
      const c = await loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key' });
      const projects = Array.isArray(body.projects) ? body.projects : (body.project ? [body.project] : null);
      if (!projects || !projects.length) return send(res, 400, { error: '缺少项目数据' });
      const modeLabel = body.mode === 'daily' ? '日报' : body.mode === 'weekly' ? '周报' : '月报';
      // 单项目 → 详细复盘；多项目（全局汇报）→ 组合概览
      if (projects.length === 1) {
        const proj = projects[0];
        const total = (proj.tasks || []).length, done = (proj.tasks || []).filter(t => t.done).length;
        const overdue = (proj.tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < isoDate(new Date())).length;
        const phaseStat = (proj.phases || []).map(ph => { const ts = (proj.tasks || []).filter(t => t.phaseId === ph.id); return ph.name + '：' + ts.filter(t => t.done).length + '/' + ts.length + ' 完成'; }).join('；');
        const sys = '你是项目复盘助手。根据以下结构化数据，用简洁中文写一段 120 字以内的项目总结，突出进度、风险与下一步。';
        const user = `项目：${proj.name}\n整体进度：${total ? Math.round(done / total * 100) : 0}%（${done}/${total}）\n逾期节点：${overdue}\n各阶段：${phaseStat}`;
        try { const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0.5); return send(res, 200, { text }); }
        catch (e) { return send(res, 502, { error: 'AI 总结失败: ' + e.message }); }
      }
      const lines = projects.map(proj => {
        const ts = proj.tasks || []; const total = ts.length, done = ts.filter(t => t.done).length;
        const overdue = ts.filter(t => !t.done && t.dueDate && t.dueDate < isoDate(new Date())).length;
        const cur = (proj.phases || []).find(ph => ts.some(t => t.phaseId === ph.id && !t.done));
        const arch = (proj.status || 'active') === 'archived' ? '（已归档）' : '';
        return `「${proj.name}」进度${total ? Math.round(done / total * 100) : 0}%（${done}/${total}）${overdue ? '，逾期' + overdue + '项' : ''}${cur ? '，当前阶段：' + cur.name : ''}${arch}`;
      }).join('\n');
      const sys = '你是项目组合复盘助手。根据以下所有项目的结构化摘要，用简洁中文写一段 160 字以内的全局' + modeLabel + '，归纳整体进展、点名风险项目、给出下一步建议。';
      const user = `共 ${projects.length} 个项目：\n${lines}`;
      try { const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0.5); return send(res, 200, { text }); }
      catch (e) { return send(res, 502, { error: 'AI 总结失败: ' + e.message }); }
    }

    // ---- 模板共创：导入参考模版 Excel 新建模板 ----
    if (p === '/api/templates/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.kind !== 'xlsx' || !body.data) return send(res, 400, { error: '仅支持 .xlsx 参考模版导入' });
      const cur = await loadJSON(TEMPLATES_FILE, []);
      try {
        const buf = Buffer.from(body.data, 'base64');
        const parsed = parseXlsxProject(buf);
        const name = String(body.filename || '导入模板').replace(/\.[^.]+$/, '');
        const tpl = {
          id: uid(), name, color: PHASE_COLORS[0], icon: '◆',
          phases: (parsed.phases || []).map((p, i) => ({ id: p.id, name: p.name || ('阶段' + (i + 1)), color: PHASE_COLORS[i % PHASE_COLORS.length] })),
          tasks: (parsed.tasks || []).map(t => ({ title: t.title, phaseId: t.phaseId, note: t.note || '', estimateDays: t.estimateDays || 0, assignee: t.assignee || '' }))
        };
        cur.push(tpl);
        saveJSON(TEMPLATES_FILE, cur);
        return send(res, 200, { added: 1, templates: [tpl] });
      } catch (e) { return send(res, 400, { error: '解析参考模版失败: ' + e.message }); }
    }

    // 周报待办清单导出（带样式 xlsx）
    if (p === '/api/reports/todo-export' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.projects)) return send(res, 400, { error: '缺少项目数据' });
      const monIso = body.mon || isoDate(new Date()), sunIso = body.sun || monIso;
      const buf = buildTodoXlsx(body.projects, monIso, sunIso);
      const date = isoDate(new Date()).replace(/-/g, '');
      const ascii = 'weekly_todo_' + date + '.xlsx';
      const utf8 = '周报待办清单_' + date + '.xlsx';
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`
      });
      return res.end(buf);
    }

    // 导出计划表（初版 / 最新），文件名区分
    const ex = p.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (ex && req.method === 'GET') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const proj = db.getProject(ex[1], req.user.id, ['admin', 'manager', 'viewer'].includes(req.user.role));
      if (!proj) return send(res, 404, { error: '项目不存在' });
      const type = url.searchParams.get('type') || 'latest';
      const date = isoDate(new Date()).replace(/-/g, '');
      let buf, tag, ascii;
      if (type === 'initial') { buf = buildPlanXlsx(proj, (proj.baseline || proj.tasks).map(t => ({ ...t }))); tag = '初版计划'; ascii = `project_initial_${date}.xlsx`; }
      else if (type === 'diff') { buf = buildDiffXlsx(proj); tag = '差异对比'; ascii = `project_diff_${date}.xlsx`; }
      else { buf = buildPlanXlsx(proj, proj.tasks.map(t => ({ ...t }))); tag = '最新计划'; ascii = `project_latest_${date}.xlsx`; }
      const utf8 = `${proj.name}_${tag}_${date}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`
      });
      return res.end(buf);
    }

    // 导入计划表（支持本应用导出的 .xlsx 或项目 .json）
    if (p === '/api/projects/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.data) return send(res, 400, { error: '缺少文件数据' });
      let np;
      try {
        const buf = Buffer.from(body.data, 'base64');
        if (body.kind === 'json') {
          np = JSON.parse(buf.toString('utf8'));
          if (!np || !np.tasks) throw new Error('不是有效的项目文件');
          np.name = np.name || (body.filename || '导入项目').replace(/\.[^.]+$/, '');
        } else {
          const parsed = parseXlsxProject(buf);
          np = { name: (body.filename || '导入项目').replace(/\.[^.]+$/, ''), phases: parsed.phases, tasks: parsed.tasks, icon: '◆', color: '#0a84ff', startDate: null, startCell: parsed.startCell || null };
        }
      } catch (e) { return send(res, 400, { error: '解析失败: ' + e.message }); }
      np.id = uid();
      np.createdAt = new Date().toISOString();
      if (!np.type) np.type = 'C端';
      if (!np.level) np.level = 'B';
      if (!np.productType) np.productType = '';
      if (!np.cert) np.cert = '';
      if (!np.icon) np.icon = '';
      if (!np.status) np.status = 'active';
      if (np.completedAt === undefined) np.completedAt = null;
      if (!np.engineers) np.engineers = { hardware: '', structure: '', project: '' };
      if (!np.phases || !np.phases.length) np.phases = [];
      np.tasks = (np.tasks || []).map(t => ({ id: uid(), title: t.title || '', phaseId: t.phaseId || (np.phases[0] && np.phases[0].id), note: t.note || '', estimateDays: t.estimateDays || 0, assignee: t.assignee || '', done: !!t.done, startDate: normDate(t.startDate), dueDate: normDate(t.dueDate), excelRow: t.excelRow || undefined, startF: t.startF || undefined, dueF: t.dueF || undefined, startRule: t.startRule || undefined, dueRule: t.dueRule || undefined }));
      if (!np.startDate) np.startDate = np.tasks[0] ? (np.tasks[0].startDate || isoDate(new Date())) : isoDate(new Date());
      recalcProject(np);
      np.baseline = np.tasks.map(t => ({ ...t }));
      db.saveProject(np, req.user.id);
      return send(res, 201, np);
    }

    // 保存看板图标（上传 + 裁剪后的图片）
    if (p === '/api/brand-logo' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.data) return send(res, 400, { error: '缺少图片数据' });
      try {
        const raw = String(body.data || '');
        const mm = raw.match(/^data:([^;]+);base64,/);
        if (mm && !/^image\/(png|jpe?g|gif|webp)$/.test(mm[1])) return send(res, 400, { error: '仅支持 PNG/JPEG/GIF/WebP 图片（禁止 SVG）' });
        const b64 = raw.replace(/^data:[^;]+;base64,/, '');
        if (b64.length > 4 * 1024 * 1024) return send(res, 400, { error: '图片过大（上限 4MB）' });
        const imgBuf = Buffer.from(b64, 'base64');
        // magic bytes 内容校验（防 polyglot/伪装文件；SVG 天然不含这些头 → 拒绝）
        const magic = imgBuf.slice(0, 12).toString('hex');
        const ok = magic.startsWith('89504e47') // PNG
          || magic.startsWith('ffd8ff')          // JPEG
          || magic.startsWith('47494638')        // GIF
          || magic.startsWith('52494646');       // WebP (RIFF....WEBP)
        if (!ok || imgBuf.length < 8 || imgBuf.length > 8 * 1024 * 1024) return send(res, 400, { error: '文件内容不是有效图片' });
        fs.writeFileSync(path.join(PUBLIC, 'brand-logo.png'), imgBuf);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: '图片数据无效' }); }
    }

    // 项目排序（左侧项目卡片拖拽后保存顺序）
    if (p === '/api/projects/order' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || !body.ids.length) return send(res, 400, { error: '缺少 ids 数组' });
      const mine = db.listProjects(req.user.id, req.user.role === 'admin').map(x => x.id);
      if (body.ids.some(id => !mine.includes(id))) return send(res, 400, { error: '包含未知项目 id' });
      db.setOrder(body.ids, req.user.id, req.user.role === 'admin');
      return send(res, 200, { ok: true });
    }

    const m = p.match(/^\/api\/projects(?:\/([^/]+)(?:\/tasks(?:\/([^/]+))?|\/reschedule)?)?$/);
    if (m) {
      const pid = m[1]; const tid = m[2];
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const isAdmin = req.user.role === 'admin' || req.user.role === 'manager'; // admin/副管理员：全量项目权限
      const canAll = isAdmin || req.user.role === 'viewer'; // + viewer 只读全量
      if (!pid) {
        if (req.method === 'GET') return send(res, 200, db.listProjects(req.user.id, canAll));
        if (req.method === 'POST') {
          const body = await readBody(req);
          let proj;
          if (body && body.templateId) {
            const tpls = await loadJSON(TEMPLATES_FILE, []);
            const tpl = tpls.find(t => t.id === body.templateId);
            if (!tpl) return send(res, 400, { error: '模板不存在' });
            proj = createFromTemplate(tpl, body.name, { type: body.type, level: body.level, productType: body.productType, cert: body.cert, icon: body.icon, color: body.color, engineers: body.engineers });
          } else if (Array.isArray(body.phases) && Array.isArray(body.tasks)) {
            // 直接由阶段 + 任务创建（AI 生成 / 模板导入），按阶段顺序排期
            const startDate = body.startDate || isoDate(new Date());
            const phases = body.phases.map((ph, i) => ({ id: ph.id || ('p' + (i + 1)), name: ph.name || ('阶段' + (i + 1)), color: ph.color || PHASE_COLORS[i % PHASE_COLORS.length] }));
            const tasks = body.tasks.map(t => ({ id: uid(), title: t.title || '未命名任务', phaseId: t.phaseId || phases[0].id, note: t.note || '', estimateDays: t.estimateDays || 0, assignee: t.assignee || '', done: !!t.done, startDate: null, dueDate: null }));
            scheduleTasks(phases, tasks, startDate);
            proj = { id: uid(), name: body.name || '新项目', templateId: null, icon: body.icon || '◆', color: body.color || '#0a84ff', startDate, type: body.type || 'C端', level: body.level || 'B', productType: body.productType || '', cert: body.cert || '', status: 'active', completedAt: null, engineers: body.engineers || { hardware: '', structure: '', project: '' }, createdAt: new Date().toISOString(), phases, tasks, baseline: tasks.map(t => ({ ...t })) };
          } else {
            return send(res, 400, { error: '请提供 templateId 或 phases + tasks' });
          }
          db.saveProject(proj, req.user.id); return send(res, 201, proj);
        }
        return send(res, 405, { error: '方法不允许' });
      }
      const proj = db.getProject(pid, req.user.id, canAll);
      if (!proj) return send(res, 404, { error: '项目不存在' });
      if (m[0].endsWith('/reschedule') && req.method === 'POST') {
        // 保留公式：有公式 → 按公式全量重算一遍；无公式 → 顺序排期兜底
        const hasRules = (proj.tasks || []).some(t => t.startRule || t.dueRule);
        if (hasRules) recalcProject(proj);
        else scheduleTasks(proj.phases, proj.tasks, proj.startDate || isoDate(new Date()));
        db.saveProject(proj, req.user.id); return send(res, 200, proj);
      }
      if (!tid) {
        if (req.method === 'GET') return send(res, 200, proj);
        if (req.method === 'POST') {
          const body = await readBody(req);
          const start = body.startDate || proj.startDate || isoDate(new Date());
          const days = Math.max(1, body.estimateDays || 1);
          const t = {
            id: uid(), title: body.title || '未命名任务',
            phaseId: body.phaseId || (proj.phases[0] && proj.phases[0].id),
            note: body.note || '', estimateDays: body.estimateDays || 0,
            assignee: body.assignee || '', done: false,
            startDate: body.startDate || start,
            dueDate: body.dueDate || isoDate(addDays(new Date(start), days))
          };
          proj.tasks.push(t); db.saveProject(proj, req.user.id); return send(res, 201, t);
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (body.name !== undefined) proj.name = body.name;
          if (body.color !== undefined) proj.color = body.color;
          if (body.type !== undefined) proj.type = body.type;
          if (body.level !== undefined) proj.level = body.level;
          if (body.productType !== undefined) proj.productType = body.productType;
          if (body.cert !== undefined) proj.cert = body.cert;
          if (body.icon !== undefined) proj.icon = body.icon;
          if (body.status !== undefined) proj.status = body.status;
          if (body.completedAt !== undefined) proj.completedAt = body.completedAt;
          if (body.engineers !== undefined) proj.engineers = body.engineers;
          let needSchedule = false;
          if (body.startDate) {
            proj.startDate = body.startDate; needSchedule = true;
            // 立项（第一个任务）开始时间 = 项目开始时间，保持一致
            const ft = (proj.tasks || [])[0];
            if (ft) { ft.startDate = body.startDate; delete ft.startRule; delete ft.startF; }
          }
          if (needSchedule) {
            const hasRules = (proj.tasks || []).some(t => t.startRule || t.dueRule);
            if (hasRules) recalcProject(proj); // 有公式 → 按公式级联
            else scheduleTasks(proj.phases, proj.tasks, proj.startDate);
          }
          db.saveProject(proj, req.user.id); return send(res, 200, proj);
        }
        if (req.method === 'DELETE') { db.deleteProject(pid, req.user.id, isAdmin); return send(res, 200, { ok: true }); }
        return send(res, 405, { error: '方法不允许' });
      }
      const tIdx = proj.tasks.findIndex(t => t.id === tid);
      if (req.method === 'PUT') {
        if (tIdx < 0) return send(res, 404, { error: '任务不存在' });
        const body = await readBody(req); const t = proj.tasks[tIdx];
        if (body.title !== undefined) t.title = body.title;
        if (body.note !== undefined) t.note = body.note;
        if (body.phaseId !== undefined) t.phaseId = body.phaseId;
        if (body.done !== undefined) t.done = !!body.done;
        if (body.assignee !== undefined) t.assignee = body.assignee;
        if (body.estimateDays !== undefined) t.estimateDays = body.estimateDays;
        if (body.startDate) {
          t.startDate = body.startDate; delete t.startRule; delete t.startF; // 手动改开始 → 覆盖该任务自己的公式
          if ((proj.tasks || [])[0] && proj.tasks[0].id === t.id) proj.startDate = body.startDate; // 改立项开始 → 项目开始同步
        }
        if (body.dueDate) { t.dueDate = body.dueDate; delete t.dueRule; delete t.dueF; }
        if (body.startFormula !== undefined) { const sf = String(body.startFormula || '').trim(); t.startF = sf; t.startRule = sf ? parseFormula(sf) : undefined; } // 改公式
        if (body.dueFormula !== undefined) { const df = String(body.dueFormula || '').trim(); t.dueF = df; t.dueRule = df ? parseFormula(df) : undefined; }
        recalcProject(proj); // 级联重算依赖该任务的后继日期
        db.saveProject(proj, req.user.id); return send(res, 200, t);
      }
      if (req.method === 'DELETE') {
        if (tIdx < 0) return send(res, 404, { error: '任务不存在' });
        proj.tasks.splice(tIdx, 1); db.saveProject(proj, req.user.id); return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    return send(res, 404, { error: '接口不存在' });
  }
  let rel = p === '/' ? '/index.html' : p;
  // 路径遍历加固：path.resolve 归一后做「大小写无关 + 分隔符感知」前缀校验（Windows 大小写/短名绕过防护）
  const filepath = path.resolve(PUBLIC, '.' + rel);
  const base = path.resolve(PUBLIC).toLowerCase();
  const full = filepath.toLowerCase();
  if (full !== base && !full.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' });
  const ext = path.extname(filepath).toLowerCase();
  // 静态缓存策略（2026-08-25）：index.html 注入资源版本号；带 ?v= 的 app.js/style.css 长缓存 immutable（发布后版本号变→自动拉新）
  if (rel === '/index.html') {
    const ver = await assetVer();
    fs.readFile(filepath, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
      res.end(buf.toString().replace(/@VER@/g, ver));
    });
    return;
  }
  const hasVer = url.searchParams.has('v');
  const cache = (rel === '/app.js' || rel === '/style.css') && hasVer ? 'public, max-age=31536000, immutable' : 'no-cache';
  fs.readFile(filepath, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache }, SEC_HEADERS));
    res.end(buf);
  });
  } catch (e) {
    if (e && e.code === 'INVALID_JSON') return send(res, 400, { error: '请求体不是合法 JSON' });
    if (e && e.code === 'BODY_TOO_LARGE') return send(res, 413, { error: '请求体过大（上限 10MB）' });
    console.error('请求处理异常:', req.method, req.url, e);
    try { if (!res.headersSent) send(res, 500, { error: '服务器内部错误' }); } catch (_) {}
  }
});
server.listen(PORT, () => {
  console.log('Multi-project kanban running at http://localhost:' + PORT + (DEMO_MODE ? '  [演示模式：脱敏数据 + 免登录]' : ''));
  if (!DEMO_MODE) console.log('就绪：admin（管理员）· guest（游客只读）。首次登录请修改默认密码，密码不再输出到日志。');
});
