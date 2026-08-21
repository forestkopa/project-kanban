const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const XLSX = require('xlsx');

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

function loadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
// 写队列：所有落盘串行化，杜绝并发覆盖；原子写：临时文件→rename，崩溃不损坏原文件
let writeQ = Promise.resolve();
function saveJSON(file, data) {
  const tmp = file + '.tmp';
  const json = JSON.stringify(data, null, 2);
  writeQ = writeQ.then(() => {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
    gitAutoCommit(file);
  }).catch(e => { try { fs.unlinkSync(tmp); } catch (_) {} console.error('保存失败:', file, e.message); });
  return writeQ;
}
// data 目录 git 自动提交（静默失败：未初始化 git 或无可提交变更时忽略）
let GIT_OK = false;
try { GIT_OK = cp.execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'pipe' }).toString().trim() === 'true'; } catch (e) { GIT_OK = false; }
function gitAutoCommit(file) {
  if (!GIT_OK || !file || DEMO_MODE) return;
  try {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    cp.spawn('git', ['add', '--', rel], { cwd: ROOT, stdio: 'ignore' }).on('exit', () => {
      cp.spawn('git', ['commit', '-m', 'data: ' + rel + ' ' + new Date().toISOString(), '--no-verify'], { cwd: ROOT, stdio: 'ignore' });
    });
  } catch (e) {}
}
function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function isoDate(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/* ---------- 可配置选项（项目类型/产品类型/等级），默认值 + 可新增；工程师/认证为手填字段 ---------- */
const DEFAULT_OPTIONS = {
  types: { 'C端': '#0A84FF', 'B端': '#30D158', '预研': '#FF9F0A', '迭代': '#BF5AF2' },
  productTypes: { 'AI': '#10a37f', 'CC线': '#06b6d4', 'DOCK': '#0ea5e9', 'MI': '#a3e635', 'MST': '#eab308', 'PD+HUB': '#f97316', 'SSD HUB': '#64748b', 'TB5': '#6366f1', 'U4': '#a855f7', 'WiFi dongle': '#14b8a6', '基础hub': '#94a3b8' },
  levels: { 'S': '#E0241B', 'A': '#FF9F0A', 'B': '#30D158', 'C': '#0A84FF', 'D': '#BF5AF2', 'E': '#64D2FF', 'F': '#8E8E93' }
};
function loadOptions() { return Object.assign({}, DEFAULT_OPTIONS, loadJSON(OPTIONS_FILE, {})); }
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
  if (col === 'F') { const t = (proj.tasks || []).find(x => x.excelRow === row); return t ? (Number(t.estimateDays) || 0) : null; }
  if (col === 'D' || col === 'E') { const t = (proj.tasks || []).find(x => x.excelRow === row); return t ? (col === 'D' ? t.startDate : t.dueDate) : null; }
  return null;
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
function recalcProject(proj) {
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    (proj.tasks || []).forEach(t => {
      if (t.startRule) { const v = evalRule(proj, t.startRule, 0); if (v && v !== t.startDate) { t.startDate = v; changed = true; } }
      if (t.dueRule) { const v = evalRule(proj, t.dueRule, 0); if (v && v !== t.dueDate) { t.dueDate = v; changed = true; } }
    });
    if (!changed) return true;
  }
  console.warn('[公式环检测] 依赖超过 60 轮未收敛，疑似公式成环:', proj.name);
  return false;
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

// 为已有项目补齐「初版计划」快照（以当前任务为基线）
(() => {
  try {
    const ps = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    let ch = false;
    ps.forEach(p => { if (!p.baseline) { p.baseline = (p.tasks || []).map(t => ({ ...t })); ch = true; } });
    if (ch) fs.writeFileSync(PROJECTS_FILE, JSON.stringify(ps, null, 2));
  } catch (e) { /* ignore */ }
})();

// 首次运行（非演示模式）若项目为空，自动播种一个示例项目，避免评委/用户看到空白首屏
(() => {
  if (DEMO_MODE) return;
  try {
    const ps = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(ps) && ps.length === 0) {
      const tpls = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
      const tpl = (tpls.find(t => /音箱|语音|speaker/i.test(t.name)) || tpls[0]);
      if (tpl) {
        const seed = createFromTemplate(tpl, tpl.name + '（示例）', { type: 'C端', level: 'B', productType: 'AI', cert: 'CCC', engineers: { hardware: '张工', structure: '李工', project: '王工' } });
        ps.push(seed);
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(ps, null, 2));
        console.log('[种子] 已生成示例项目：' + seed.name + '（' + seed.tasks.length + ' 个任务）');
      }
    }
  } catch (e) { /* 不影响启动 */ }
})();

/* ---------- AI 助手：OpenAI 兼容接口（Node 原生 https，无额外依赖） ---------- */
function loadAI() { return Object.assign({ base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: '' }, loadJSON(AI_FILE, {})); }
function saveAI(cfg) { try { fs.writeFileSync(AI_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {} return cfg; }
function aiConfigured(cfg) { return !!(cfg && cfg.api_key); }
function chatCompletions(cfg, messages, temperature) {
  return new Promise((resolve, reject) => {
    const base = String(cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    let url; try { url = new URL(base + '/chat/completions'); } catch (e) { return reject(new Error('base_url 无效')); }
    const payload = JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, temperature: (typeof temperature === 'number' ? temperature : 0.7), stream: false });
    const data = Buffer.from(payload);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Authorization': 'Bearer ' + (cfg.api_key || '') }, timeout: 60000
    };
    const req = lib.request(options, resp => {
      let buf = ''; resp.on('data', d => buf += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (t) resolve(t); else reject(new Error('AI 未返回内容: ' + (buf || '').slice(0, 160)));
        } catch (e) { reject(new Error('解析 AI 响应失败: ' + (buf || '').slice(0, 160))); }
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
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
const BODY_LIMIT = 10 * 1024 * 1024; // 请求体上限 10MB
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    let tooLarge = false;
    req.on('data', c => { d += c; if (!tooLarge && d.length > BODY_LIMIT) { tooLarge = true; req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
// --- 最小鉴权：非 GET 请求校验静态 token（data/auth.token，首次启动自动生成） ---
const TOKEN_FILE = path.join(DATA, 'auth.token');
function ensureToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch (e) {}
  const t = 'kb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try { fs.writeFileSync(TOKEN_FILE, t, 'utf8'); } catch (e) {}
  return t;
}
const AUTH_TOKEN = ensureToken();
function authorized(req) { return DEMO_MODE || req.headers['x-auth-token'] === AUTH_TOKEN; }

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

function isRO() { try { return fs.readFileSync(RO_FLAG, 'utf8').trim() === '1'; } catch (e) { return false; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // 请求日志（响应结束打印：方法 路径 状态 耗时）
  const t0 = Date.now();
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`));
  if (p.startsWith('/api/')) {
    // 请求体大小上限（content-length 预检，chunked 由 readBody 兜底断开）
    if (req.method !== 'GET' && parseInt(req.headers['content-length'] || '0', 10) > BODY_LIMIT) {
      return send(res, 413, { error: '请求体过大（上限 10MB）' });
    }
    // 最小鉴权：写操作必须携带正确 token（GET 查询不受限）
    if (req.method !== 'GET' && !authorized(req)) {
      return send(res, 401, { error: '未授权：缺少或错误的访问令牌' });
    }
    // 只读模式：查询 / 切换（始终可用）
    if (p === '/api/readonly') {
      if (req.method === 'GET') return send(res, 200, { on: isRO(), demo: DEMO_MODE });
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { fs.writeFileSync(RO_FLAG, (body && body.on) ? '1' : '0'); }
        catch (e) { return send(res, 500, { error: '切换失败' }); }
        return send(res, 200, { on: !!(body && body.on) });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    // 只读模式：拦截所有非 GET 修改请求
    if (req.method !== 'GET' && isRO()) {
      return send(res, 403, { error: '只读模式，禁止修改' });
    }
    if (p === '/api/templates' && req.method === 'GET') return send(res, 200, loadJSON(TEMPLATES_FILE, []));
    // 可配置选项：项目类型 / 产品类型 / 等级 / 认证 / 工程师
    if (p === '/api/options' && req.method === 'GET') return send(res, 200, loadOptions());
    if (p === '/api/options' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return send(res, 400, { error: '参数无效' });
      const o = loadOptions();
      ['types', 'productTypes', 'levels'].forEach(k => { if (body[k] && typeof body[k] === 'object') o[k] = body[k]; });
      ['certs', 'engineers'].forEach(k => { if (Array.isArray(body[k])) o[k] = body[k]; });
      saveJSON(OPTIONS_FILE, o);
      return send(res, 200, o);
    }
    // 修改模版（改名）
    const tplPut = p.match(/^\/api\/templates\/([^/]+)$/);
    if (tplPut && req.method === 'PUT') {
      const body = await readBody(req);
      const cur = loadJSON(TEMPLATES_FILE, []);
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
      const cur = loadJSON(TEMPLATES_FILE, []);
      const next = cur.filter(t => t.id !== tplDel[1]);
      if (next.length === cur.length) return send(res, 404, { error: '模版不存在' });
      saveJSON(TEMPLATES_FILE, next);
      return send(res, 200, { ok: true });
    }
    // 下载参考模版（内置模版生成的甘特方言 Excel，开始/截止带公式 → 导入后甘特级联）
    if (p === '/api/templates/reference-xlsx' && req.method === 'GET') {
      const tpls = loadJSON(TEMPLATES_FILE, []);
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
      if (req.method === 'GET') { const c = loadAI(); return send(res, 200, { base_url: c.base_url, model: c.model, configured: aiConfigured(c) }); }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const c = loadAI();
        if (body.base_url !== undefined) c.base_url = String(body.base_url).trim() || 'https://api.openai.com/v1';
        if (body.model !== undefined) c.model = String(body.model).trim() || 'gpt-4o-mini';
        if (body.api_key !== undefined) c.api_key = String(body.api_key);
        saveAI(c);
        return send(res, 200, { base_url: c.base_url, model: c.model, configured: aiConfigured(c) });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    if (p === '/api/ai/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const c = loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key' });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return send(res, 400, { error: 'messages 为空' });
      try { const text = await chatCompletions(c, messages, body.temperature); return send(res, 200, { text }); }
      catch (e) { return send(res, 502, { error: 'AI 调用失败: ' + e.message }); }
    }
    if (p === '/api/ai/generate-tasks' && req.method === 'POST') {
      const body = await readBody(req);
      const desc = String(body.description || '').trim();
      if (!desc) return send(res, 400, { error: '请描述项目' });
      const c = loadAI();
      if (!aiConfigured(c)) {
        // 离线兜底：基于内置模板的规则建议（非 LLM，界面会明确标注）
        const tpls = loadJSON(TEMPLATES_FILE, []);
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
      const body = await readBody(req);
      const proj = body.project;
      if (!proj || !proj.tasks) return send(res, 400, { error: '缺少项目数据' });
      const c = loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key' });
      const total = (proj.tasks || []).length, done = (proj.tasks || []).filter(t => t.done).length;
      const overdue = (proj.tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < isoDate(new Date())).length;
      const phaseStat = (proj.phases || []).map(ph => { const ts = (proj.tasks || []).filter(t => t.phaseId === ph.id); return ph.name + '：' + ts.filter(t => t.done).length + '/' + ts.length + ' 完成'; }).join('；');
      const sys = '你是项目复盘助手。根据以下结构化数据，用简洁中文写一段 120 字以内的项目周报/总结，突出进度、风险与下一步。';
      const user = `项目：${proj.name}\n整体进度：${total ? Math.round(done / total * 100) : 0}%（${done}/${total}）\n逾期节点：${overdue}\n各阶段：${phaseStat}`;
      try { const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0.5); return send(res, 200, { text }); }
      catch (e) { return send(res, 502, { error: 'AI 总结失败: ' + e.message }); }
    }

    // ---- 模板共创：导入参考模版 Excel 新建模板 ----
    if (p === '/api/templates/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.kind !== 'xlsx' || !body.data) return send(res, 400, { error: '仅支持 .xlsx 参考模版导入' });
      const cur = loadJSON(TEMPLATES_FILE, []);
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

    // 导出计划表（初版 / 最新），文件名区分
    const ex = p.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (ex && req.method === 'GET') {
      const projects = loadJSON(PROJECTS_FILE, []);
      const proj = projects.find(x => x.id === ex[1]);
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
      const projects = loadJSON(PROJECTS_FILE, []);
      projects.push(np); saveJSON(PROJECTS_FILE, projects);
      return send(res, 201, np);
    }

    // 保存看板图标（上传 + 裁剪后的图片）
    if (p === '/api/brand-logo' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.data) return send(res, 400, { error: '缺少图片数据' });
      try {
        const raw = String(body.data || '');
        const mm = raw.match(/^data:([^;]+);base64,/);
        if (mm && !/^image\//.test(mm[1])) return send(res, 400, { error: '仅支持图片格式 (image/*)' });
        const b64 = raw.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(PUBLIC, 'brand-logo.png'), Buffer.from(b64, 'base64'));
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: '图片数据无效' }); }
    }

    const m = p.match(/^\/api\/projects(?:\/([^/]+)(?:\/tasks(?:\/([^/]+))?|\/reschedule)?)?$/);
    if (m) {
      const projects = loadJSON(PROJECTS_FILE, []);
      const pid = m[1]; const tid = m[2];
      if (!pid) {
        if (req.method === 'GET') return send(res, 200, projects);
        if (req.method === 'POST') {
          const body = await readBody(req);
          let proj;
          if (body && body.templateId) {
            const tpls = loadJSON(TEMPLATES_FILE, []);
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
          projects.push(proj); saveJSON(PROJECTS_FILE, projects); return send(res, 201, proj);
        }
        return send(res, 405, { error: '方法不允许' });
      }
      const idx = projects.findIndex(x => x.id === pid);
      if (idx < 0) return send(res, 404, { error: '项目不存在' });
      const proj = projects[idx];
      if (m[0].endsWith('/reschedule') && req.method === 'POST') {
        // 保留公式：有公式 → 按公式全量重算一遍；无公式 → 顺序排期兜底
        const hasRules = (proj.tasks || []).some(t => t.startRule || t.dueRule);
        if (hasRules) recalcProject(proj);
        else scheduleTasks(proj.phases, proj.tasks, proj.startDate || isoDate(new Date()));
        saveJSON(PROJECTS_FILE, projects); return send(res, 200, proj);
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
          proj.tasks.push(t); saveJSON(PROJECTS_FILE, projects); return send(res, 201, t);
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
          saveJSON(PROJECTS_FILE, projects); return send(res, 200, proj);
        }
        if (req.method === 'DELETE') { projects.splice(idx, 1); saveJSON(PROJECTS_FILE, projects); return send(res, 200, { ok: true }); }
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
        saveJSON(PROJECTS_FILE, projects); return send(res, 200, t);
      }
      if (req.method === 'DELETE') {
        if (tIdx < 0) return send(res, 404, { error: '任务不存在' });
        proj.tasks.splice(tIdx, 1); saveJSON(PROJECTS_FILE, projects); return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    return send(res, 404, { error: '接口不存在' });
  }
  let rel = p === '/' ? '/index.html' : p;
  const filepath = path.join(PUBLIC, path.normalize(rel));
  if (!filepath.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filepath, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(filepath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
server.listen(PORT, () => {
  console.log('Multi-project kanban running at http://localhost:' + PORT + (DEMO_MODE ? '  [演示模式：脱敏数据 + 免令牌]' : ''));
  if (!DEMO_MODE) console.log('写操作访问令牌 (X-Auth-Token): ' + AUTH_TOKEN + '  (文件: data/auth.token，可在页面首次写操作时输入一次)');
});
