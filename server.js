const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const FE = require('./lib/formula-engine.js');
const { isoDate, addDays, normDate, colName, parseTerm, parseFormula, resolveRef, collectRuleRefs, evalRule, recalcProject } = FE;
// 公式引擎已抽取到 lib/formula-engine.js（2026-08-25）
const XLSX = require('xlsx'); // 参考模版生成 + 上传 xlsx 解析（buildTemplateXlsx / XLSX.read 仍在本文件使用）
const XLSXS = require('xlsx-js-style'); // 样式工具（stylePlanSheet / setDateFmt）
// 单元格样式导出与重复任务逻辑已抽到 lib/（xlsx-export.js / recurrence.js），减少主文件体积、便于单测
const { buildPlanXlsx, buildDiffXlsx, buildTodoXlsx, buildReportXlsx, stylePlanSheet, setDateFmt, PLAN_DATE_FMT } = require('./lib/xlsx-export.js');
const { RECUR, RECUR_NAME, shiftByRecurrence, spawnNextRecurrence } = require('./lib/recurrence.js');
// 自动升级功能已移除（v1.5.7）：仅保留版本显示（/api/version + /api/latest-release）

const PORT = process.env.PORT || 5181; // 单实例：5180 演示版已于 2026-09-11 下线，默认端口即正式版
// --demo 演示版已下线。带该参数启动直接退出——不能静默忽略：忽略会让它以「正式版」身份
// 在 5180 上再起一个实例、与 5181 双写同一份 app.db。
if (process.argv.includes('--demo')) {
  console.error('[启动失败] --demo 演示版已于 2026-09-11 下线，请直接运行 node server.js（端口 5181）。');
  process.exit(1);
}
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// 数据目录可经环境变量 KB_DATA_DIR 覆盖（默认 ROOT/data），用于测试隔离实例 / 异地部署指定数据盘
const DATA = process.env.KB_DATA_DIR ? path.resolve(process.env.KB_DATA_DIR) : path.join(ROOT, 'data');
const PROJECTS_FILE = path.join(DATA, 'projects.json');
// 模板文件位置：正式部署沿用**项目根** templates.json（升级包会带上，便于随版本更新内置模板）；
// KB_DATA_DIR 隔离实例（测试）则放进数据目录、首次从项目根复制种子——既保证内置模板可用，
// 又避免测试里的导入/改名写脏仓库文件。
const ISOLATED = !!process.env.KB_DATA_DIR;
const TEMPLATES_FILE = path.join(ISOLATED ? DATA : ROOT, 'templates.json');
if (ISOLATED) {
  try {
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
    if (!fs.existsSync(TEMPLATES_FILE) && fs.existsSync(path.join(ROOT, 'templates.json'))) {
      fs.copyFileSync(path.join(ROOT, 'templates.json'), TEMPLATES_FILE);
    }
  } catch (e) { console.error('复制模版种子失败:', (e && e.message) || e); }
}
const OPTIONS_FILE = path.join(DATA, 'options.json');
const RO_FLAG = path.join(DATA, 'readonly.flag');
const AI_FILE = path.join(DATA, 'ai.json');
// SQLite 数据层（node:sqlite 内置模块）；存量 JSON 仅作首次迁移种子
const db = require('./db.js');
const DB_FILE = path.join(DATA, 'app.db');
const BRAND_LOGO_FILE = path.join(PUBLIC, 'brand-logo.png');
// 隔离实例标记：测试 harness 经 KB_INSTANCE_TAG 传入随机串，/api/readonly 原样回显，
// 用于确认「连上的确实是刚拉起的那个进程」（端口被别的进程占用时不至于误判就绪）。
const INSTANCE_TAG = process.env.KB_INSTANCE_TAG || '';

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
  }).catch(e => { try { fs.unlinkSync(tmp); } catch (_) {} const msg = '保存失败: ' + file + ' ' + ((e && e.stack) || (e && e.message) || e); console.error(msg); try { fs.writeFileSync(path.join(DATA, '.save-error.log'), new Date().toISOString() + ' ' + msg + '\n', { flag: 'a' }); } catch (_) {} });
  return writeQ;
}
// data 目录 git 自动提交（静默失败：未初始化 git 或无可提交变更时忽略；2s 防抖合并高频写入，单进程串行执行）
let GIT_OK = false;
try { GIT_OK = cp.execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'pipe' }).toString().trim() === 'true'; } catch (e) { GIT_OK = false; }
let gitPending = new Set();
let gitTimer = null;
function gitAutoCommit(file) {
  if (!GIT_OK || !file) return;
  gitPending.add(path.relative(ROOT, file).replace(/\\/g, '/'));
  if (gitTimer) return;
  gitTimer = setTimeout(() => {
    gitTimer = null;
    const files = [...gitPending]; gitPending = new Set();
    if (!files.length) return;
    const args = files.map(f => '-- ' + JSON.stringify(f)).join(' ');
    cp.exec('git add ' + args + ' && git commit -m "data: ' + files.length + ' file(s) ' + new Date().toISOString() + '" --no-verify', { cwd: ROOT, stdio: 'ignore' }, (err) => { if (err) console.error('git 自动提交失败:', files.join(','), err.message); });
  }, 2000);
}
function uid() { return 'id_' + crypto.randomUUID().replace(/-/g, ''); }
/* ---------- 可配置选项（项目类型/产品类型/等级/工程师类型），默认值 + 可新增；姓名/认证为手填字段 ---------- */
const DEFAULT_OPTIONS = {
  types: { 'C端': '#0A84FF', 'B端': '#30D158', '预研': '#FF9F0A', '迭代': '#BF5AF2' },
  productTypes: { 'AI': '#10a37f', 'CC线': '#06b6d4', 'DOCK': '#0ea5e9', 'MI': '#a3e635', 'MST': '#eab308', 'PD+HUB': '#f97316', 'SSD HUB': '#64748b', 'TB5': '#6366f1', 'U4': '#a855f7', 'WiFi dongle': '#14b8a6', '基础hub': '#94a3b8' },
  levels: { 'S': '#E0241B', 'A': '#FF9F0A', 'B': '#30D158', 'C': '#0A84FF', 'D': '#BF5AF2', 'E': '#64D2FF', 'F': '#8E8E93' },
  engineerTypes: ['硬件工程师', '结构工程师', '项目工程师', '测试工程师']
};
async function loadOptions() { return Object.assign({}, DEFAULT_OPTIONS, await loadJSON(OPTIONS_FILE, {})); }
/* 排期（两条语义，由「项目任务是否携带 startRule/dueRule」决定用哪条 —— 见 callSite 的 hasRules）：
   - mode='calendar'（默认）：自然日。截止 = 开始 + 工期，下一任务从上一任务截止日当天开始（首尾重叠一天）。
   - mode='workday'：工作日。截止 = 开始 + (工期-1) 个工作日，下一任务从截止后的下一个工作日开始 ——
     与「导出参考模版」写进 Excel 的 WORKDAY.INTL 公式链逐字同构，保证同一模版页面与 Excel 日期一致。
   阶段边界不额外跳空：跨阶段延续全局游标（与 Excel 公式链的跨阶段级联一致）。 */
function scheduleTasks(phases, tasks, startStr, mode) {
  const wd = mode === 'workday';
  let cur = null; // 上一个任务的截止日（ISO）
  for (const ph of phases) {
    for (const t of tasks.filter(x => x.phaseId === ph.id)) {
      const days = Math.max(1, t.estimateDays || 1);
      const start = cur === null ? isoDate(new Date(startStr)) : (wd ? workdayAdd(cur, 1) : cur);
      t.startDate = start;
      t.dueDate = wd ? workdayAdd(start, days - 1) : isoDate(addDays(new Date(start), days));
      cur = t.dueDate;
    }
  }
}

const PHASE_COLORS = ['#8b5cf6', '#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#ffd60a'];
// 计划表导出（buildPlanXlsx）/ 差异对比导出（buildDiffXlsx）已移至 lib/xlsx-export.js

// 周报待办导出（buildTodoXlsx）/ 聚合报告导出（buildReportXlsx）已移至 lib/xlsx-export.js

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
  // 与计划表导出保持同构：序号/阶段/任务/负责人/开始日期/截止日期/工期(天)/状态/备注
  // 第 1 行表头；第 2 行起数据。项目开始时间 = 序号 1 任务的开始日期。
  const rows = [
    ['序号', '阶段', '任务', '负责人', '开始日期', '截止日期', '工期(天)', '状态', '备注']
  ];
  let seq = 0;
  const phaseSpans = []; // { name, startR, endR } in 0-based rows
  phases.forEach(ph => {
    const phTasks = tasks.filter(t => t.phaseId === ph.id);
    if (!phTasks.length) return;
    const startR = rows.length;
    phTasks.forEach((t, idx) => {
      seq++;
      rows.push([
        seq,
        idx === 0 ? (phaseName[ph.id] || ph.name || ph.id) : '', // 阶段列只填首行，下面合并
        t.title || ('任务' + seq),
        t.assignee || '',
        '', // 开始日期：由公式/固定日期填充
        '', // 截止日期：由公式填充
        Math.max(1, Number(t.estimateDays) || 1),
        '', // 状态：留空
        t.note || ''
      ]);
    });
    phaseSpans.push({ name: phaseName[ph.id] || ph.name || ph.id, startR, endR: rows.length - 1 });
  });
  const ws = XLSXS.utils.aoa_to_sheet(rows, { cellDates: true });
  ws['!cols'] = [{ wch: 6 }, { wch: 16 }, { wch: 38 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 32 }];
  // 阶段列合并单元格
  ws['!merges'] = phaseSpans.map(({ startR, endR }) => ({ s: { r: startR, c: 1 }, e: { r: endR, c: 1 } }));
  // 公式链：数据从 excel 第 2 行开始（rows 索引 1）
  const serial = s => Math.round((new Date(s + 'T00:00:00').getTime() / 86400000) + 25569);
  let prevTaskRow = null, cur = startDate;
  // 列索引：E=开始日期(4)，F=截止日期(5)，G=工期(天)(6)
  for (let r = 1; r < rows.length; r++) {
    const R = r + 1;
    const days = Math.max(1, Number(rows[r][6]) || 1);
    const s = prevTaskRow === null ? startDate : workdayAdd(cur, 1);
    const due = workdayAdd(s, days - 1);
    cur = due;
    if (prevTaskRow === null) {
      // 序号 1：固定日期（项目开始时间），无公式，确保导入 / 渲染稳定
      ws[XLSXS.utils.encode_cell({ r, c: 4 })] = { t: 'n', v: serial(s), z: PLAN_DATE_FMT };
    } else {
      const startF = '=WORKDAY.INTL(F' + prevTaskRow + ',1)';
      ws[XLSXS.utils.encode_cell({ r, c: 4 })] = { t: 'n', f: startF, v: serial(s), z: PLAN_DATE_FMT };
    }
    const dueF = '=WORKDAY.INTL(E' + R + ',G' + R + '-1)';
    ws[XLSXS.utils.encode_cell({ r, c: 5 })] = { t: 'n', f: dueF, v: serial(due), z: PLAN_DATE_FMT };
    prevTaskRow = R;
  }
  // 统一样式：表头深蓝底白字加粗、全表细黑边框、全列居中；日期列套用 yyyy/m/d
  stylePlanSheet(ws, rows.length, 9, [0, 1, 2, 3, 4, 5, 6, 7, 8], 0);
  setDateFmt(ws, rows.length, [4, 5], 1); // 数据行从第 2 行（rows 索引 1）开始
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, '参考模版');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
/* ---------- 公式级联：导入解析 + 依赖重算 ---------- */
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
  // 真正的「序号」列（计划表/参考模版方言有；旧甘特方言没有 → -1）。
  // 注意不能拿 iSeq 当序号列：新格式没有「内容」列时 iSeq 会落到「任务」列上。
  const iSeqNo = headers.findIndex(h => h && /^(序号|编号|no\.?)$/i.test(h));
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
  // 项目开始时间由序号 1 任务（第一行数据）的开始日期决定，不再单独定位「项目开始」单元格
  const S = (i, r) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  // 把 Excel 公式里的列字母统一映射为内部固定语义：D=开始 / E=截止 / F=天数
  // 这样无论表头是旧甘特方言(D/E/F)还是新计划表方言(E/F/G)，resolveRef 都按固定列解释
  const startCol = iStart >= 0 ? colName(iStart) : 'D';
  const dueCol = iDue >= 0 ? colName(iDue) : 'E';
  const daysCol = iDays >= 0 ? colName(iDays) : 'F';
  function mapFormulaCols(f) {
    if (!f) return f;
    return f.replace(/\b([A-Z]+)(\d+)\b/g, (_, col, r) => {
      const c = col.toUpperCase();
      if (c === startCol) return 'D' + r;
      if (c === dueCol) return 'E' + r;
      if (c === daysCol) return 'F' + r;
      return col + r;
    });
  }
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const sv = S(iSeq, row), tv = S(iTitle, row);
    if (!sv && !tv) continue;
    // 跳过提示/汇总行：有序号列时，序号为数字就认定是正经任务行，不再按关键词判定。
    // 为什么这么改：任务名可能天然含这些词（「包装与说明书」「隐私说明」），早先无条件按关键词
    // 跳过会把整行任务吞掉；而参考模版阶段列已改合并单元格（阶段名只写在阶段首行），
    // 首行一旦被误杀，整个阶段的名称都读不到 → 阶段丢失 + 后续任务错归上一阶段。
    const seqIsNum = iSeqNo >= 0 && /^\d+$/.test(S(iSeqNo, row));
    if (!seqIsNum && skipRe.test(sv + '|' + tv)) {
      // 兜底：被跳过的行若正是合并单元格的阶段首行，先登记阶段再跳过，避免整阶段丢失
      const pnSkip = iPhase >= 0 ? S(iPhase, row) : '';
      if (pnSkip && !phaseMap[pnSkip]) curPhase = ensurePhase(pnSkip);
      continue;
    }
    if (gantt) {
      const hasDate = (iStart >= 0 && row[iStart] != null && row[iStart] !== '') || (iDue >= 0 && row[iDue] != null && row[iDue] !== '');
      if (!tv && !hasDate) { curPhase = ensurePhase(sv || ('阶段' + (phaseOrder.length + 1))); continue; } // 分组行 → 阶段
      const excelRow = r + 1;
      const startF = mapFormulaCols(iStart >= 0 && ws[colName(iStart) + excelRow] ? ws[colName(iStart) + excelRow].f : null);
      const dueF = mapFormulaCols(iDue >= 0 && ws[colName(iDue) + excelRow] ? ws[colName(iDue) + excelRow].f : null);
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
      let pn = iPhase >= 0 ? S(iPhase, row) : '';
      // 阶段列合并单元格时，仅首行有值；后续行沿用当前阶段（curPhase）
      if (!pn && curPhase) pn = curPhase.name;
      const pid = (pn && phaseMap[pn]) ? phaseMap[pn].id : ensurePhase(pn || ('阶段' + (phaseOrder.length + 1))).id;
      if (pn && phaseMap[pn]) curPhase = phaseMap[pn];
      const excelRow = r + 1;
      const startF = mapFormulaCols(iStart >= 0 && ws[colName(iStart) + excelRow] ? ws[colName(iStart) + excelRow].f : null);
      const dueF = mapFormulaCols(iDue >= 0 && ws[colName(iDue) + excelRow] ? ws[colName(iDue) + excelRow].f : null);
      tasks.push({
        title: sv,
        phaseId: pid,
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
    }
  }
  const eff = {
    task: iTitle >= 0 ? headers[iTitle] : '', taskFallback: iSeq >= 0 ? headers[iSeq] : '', phase: iPhase >= 0 ? headers[iPhase] : '',
    groupPhase: gantt, who: iWho >= 0 ? headers[iWho] : '', start: iStart >= 0 ? headers[iStart] : '',
    due: iDue >= 0 ? headers[iDue] : '', days: iDays >= 0 ? headers[iDays] : '', status: iStatus >= 0 ? headers[iStatus] : '', note: iNote >= 0 ? headers[iNote] : ''
  };
  return { tasks, phases: phaseOrder, mapping: eff, startCell: null };
}

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(PROJECTS_FILE)) saveJSON(PROJECTS_FILE, []);
if (!fs.existsSync(TEMPLATES_FILE)) saveJSON(TEMPLATES_FILE, []);
if (!fs.existsSync(OPTIONS_FILE)) saveJSON(OPTIONS_FILE, DEFAULT_OPTIONS);
// 初始化 SQLite 数据层 + 引导：建 admin 并迁移存量 projects.json，并确保 guest 游客账号
db.init(DB_FILE);
db.ensureAdminAndMigrate(PROJECTS_FILE);
db.ensureGuestUser();

// 首次运行若项目库为空，自动播种一个示例项目，避免用户看到空白首屏
(() => {
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
  } catch (e) { console.error('保存 AI 配置失败:', (e && e.message) || e); }
  return cfg;
}
// 已配置判定：云 Key 或本地模型（local 标志）任一即可
function aiConfigured(cfg) { return !!(cfg && (cfg.api_key || cfg.local)); }
function maskKey(k) { if (!k) return ''; const s = String(k); if (s.length <= 8) return '****'; return s.slice(0, 3) + '****' + s.slice(-4); }
// 完整版：返回 { content, tool_calls, message, raw }——Agent 用，支持 function calling
// opts: { temperature, tools }（tools 为空则退化成普通对话；模型不支持 tools 时多数服务会忽略或报 400，由 agent 自动降级文本协议）
function chatCompletionsFull(cfg, messages, opts) {
  return new Promise((resolve, reject) => {
    const o = opts || {};
    const base = String(cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    let url; try { url = new URL(base + '/chat/completions'); } catch (e) { return reject(new Error('base_url 无效')); }
    const body = { model: cfg.model || 'gpt-4o-mini', messages, temperature: (typeof o.temperature === 'number' ? o.temperature : 0.7), stream: false };
    if (o.tools && o.tools.length) body.tools = o.tools;
    // 给本地小模型显式 max_tokens，避免 LM Studio 默认值（如 128）把输出截成空字符串；
    // OpenAI 云端不传则由模型默认值（gpt-4o-mini=16384 等），保持原行为。
    if (typeof o.max_tokens === 'number') body.max_tokens = o.max_tokens;
    else if (cfg.api_key) { /* 云端有 Key：不强制覆盖，沿用原行为 */ }
    else { body.max_tokens = 1024; }
    const payload = JSON.stringify(body);
    const data = Buffer.from(payload);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key; // 本地模型无 Key 不带头
    const options = { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: 120000 };
    const req = lib.request(options, resp => {
      let buf = ''; resp.on('data', d => buf += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const choice = j.choices && j.choices[0];
          const msg = choice && choice.message;
          if (msg) {
            // 兼容 LM Studio 本地模型：把 reasoning_content 当 content 兜底（许多小模型把正文放进 reasoning）
            const content = msg.content || msg.reasoning_content || '';
            resolve({
              content,
              tool_calls: msg.tool_calls || null,
              reasoning: msg.reasoning_content || '',
              finish_reason: choice.finish_reason || '',
              message: msg, raw: j
            });
          } else { console.error('AI 未返回内容:', (buf || '').slice(0, 300)); reject(new Error('AI 未返回内容')); }
        } catch (e) { console.error('解析 AI 响应失败:', e.message, (buf || '').slice(0, 300)); reject(new Error('解析 AI 响应失败')); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.write(data); req.end();
  });
}
// 兼容旧调用：只要文本
function chatCompletions(cfg, messages, temperature) {
  return chatCompletionsFull(cfg, messages, { temperature }).then(r => {
    if (!r.content && !r.reasoning) throw new Error('AI 未返回内容');
    return r.content;
  });
}

const zlib = require('zlib');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
};
// 安全响应头（防 XSS/点击劫持/MIME 嗅探；HSTS 仅 HTTPS 生效，浏览器对 http://localhost 自动忽略）
// CSP 改为每请求 nonce：script-src 去除 'unsafe-inline'，仅允许 'self' + nonce；style-src 保留 unsafe-inline（内联 style 属性）
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
function cspHeader(nonce) {
  return "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
}
// 统一响应写出：按 Accept-Encoding 透明 gzip 压缩（API/静态文本均走此路）
function endBody(res, status, buf, headers) {
  const accept = res._acceptEnc || '';
  if (res._canGzip && /\bgzip\b/.test(accept) && Buffer.isBuffer(buf) && buf.length > 256) {
    try {
      const gz = zlib.gzipSync(buf);
      res.writeHead(status, Object.assign({}, headers, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length }));
      res.end(gz); return;
    } catch (e) { /* 压缩失败则原样返回 */ }
  }
  res.writeHead(status, Object.assign({}, headers, { 'Content-Length': buf.length }));
  res.end(buf);
}
function send(res, status, body) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS);
  if (res._csp) headers['Content-Security-Policy'] = res._csp;
  endBody(res, status, Buffer.from(data, 'utf8'), headers);
}
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
  const h = req.headers['x-auth-token'] || req.headers.authorization;
  const uid = db.tokenUserId(h);
  if (uid) { const u = db.getUserById(uid); if (u) return u; }
  // 旧 token 兼容 = admin（不安全：data/auth.token 明文即 admin 钥匙）。默认关闭，需显式 KB_LEGACY_TOKEN=1 才启用；DB token 体系已取代它
  if (h === AUTH_TOKEN && process.env.KB_LEGACY_TOKEN === '1') { const a = db.getUserByName('admin'); if (a) return { id: a.id, name: a.name, role: a.role }; }
  return null;
}
function authorized(req) { return !!req.user; }
/* 鉴权契约统一：避免散落的数组字面量/三元导致越权 bug（P1-11） */
const CAN_ALL = ['admin', 'manager', 'viewer'];   // 可读全量项目/任务（含 viewer 只读全量）
const FULL_REPORT = ['admin', 'manager'];          // 报告聚合全量（viewer 仅看自己，防数据越界）
const MANAGERS = ['admin', 'manager'];
function canAllRole(role) { return CAN_ALL.includes(role); }
function isManagerRole(role) { return MANAGERS.includes(role); }
function fullReportRole(role) { return FULL_REPORT.includes(role); }

// 重复任务逻辑（shiftByRecurrence / spawnNextRecurrence / RECUR / RECUR_NAME）已移至 lib/recurrence.js

/* ---------- AI Agent：让 AI 助手能调用看板工具（读写项目/任务） ----------
   依赖注入而非 require server 内部函数，避免循环依赖；所有工具以当前登录用户身份执行，受角色可见与只读模式约束。 */
const createAgent = require('./lib/ai-agent.js');
const agent = createAgent({
  db, uid, isoDate, addDays, recalcProject, scheduleTasks, PHASE_COLORS, canAllRole, isManagerRole,
  chat: chatCompletionsFull,
  isReadOnly: () => { try { return fs.readFileSync(RO_FLAG, 'utf8').trim() === '1'; } catch (e) { return false; } }
});

/* AI 助手路由（原巨石路由内联块抽取，缩小主函数；Node 原生 https，支持本地大模型） */
async function handleAi(p, req, res) {
    // ---- AI 对话记录（会话 CRUD + 消息，owner 隔离；写操作受全局 viewer 只读闸门保护）----
    // 路径：/api/ai/sessions、/api/ai/sessions/:id（重命名/删除）、/api/ai/sessions/:id/messages
    const sessMatch = p.match(/^\/api\/ai\/sessions(?:\/([^/]+)(?:\/messages)?)?$/);
    if (sessMatch) {
      const sessionId = sessMatch[1];
      if (!sessionId && req.method === 'GET') {
        return send(res, 200, { sessions: db.aiListSessions(req.user.id) });
      }
      if (!sessionId && req.method === 'POST') {
        const body = await readBody(req);
        const s = db.aiCreateSession(req.user.id, body && body.title);
        return send(res, 200, s);
      }
      if (sessionId && p.endsWith('/messages')) {
        if (req.method === 'GET') {
          const msgs = db.aiListMessages(req.user.id, sessionId);
          if (!msgs) return send(res, 404, { error: '对话不存在' });
          return send(res, 200, { messages: msgs });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const out = db.aiAppendMessages(req.user.id, sessionId, body && body.messages);
          if (!out) return send(res, 404, { error: '对话不存在' });
          return send(res, 200, out);
        }
        return send(res, 405, { error: '方法不允许' });
      }
      if (sessionId && req.method === 'PUT') {
        const body = await readBody(req);
        const ok = db.aiRenameSession(req.user.id, sessionId, body && body.title);
        if (!ok) return send(res, 404, { error: '对话不存在' });
        return send(res, 200, { ok: true });
      }
      if (sessionId && req.method === 'DELETE') {
        const ok = db.aiDeleteSession(req.user.id, sessionId);
        if (!ok) return send(res, 404, { error: '对话不存在' });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: '方法不允许' });
    }
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
    // 本地大模型：同时探测本机 LM Studio（OpenAI 兼容 /v1/models，端口 1234）与 Ollama（原生 /api/tags，端口 11434），返回可用模型列表
    if (p === '/api/ai/local-models' && req.method === 'GET') {
      const models = []; const seen = new Set();
      const push = (id, source, base_url) => { if (id && !seen.has(id)) { seen.add(id); models.push({ id, source, base_url }); } };
      // LM Studio：OpenAI 兼容接口
      try {
        const lmBody = await new Promise((resolve, reject) => {
          const rq = http.get('http://127.0.0.1:1234/v1/models', { timeout: 2000 }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => resolve(b)); });
          rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('timeout')));
        });
        const lm = JSON.parse(lmBody);
        (lm.data || []).forEach(m => push(m.id, 'LM Studio', 'http://127.0.0.1:1234/v1'));
      } catch (e) { /* LM Studio 未启动，跳过 */ }
      // Ollama：原生接口
      try {
        const olBody = await new Promise((resolve, reject) => {
          const rq = http.get('http://127.0.0.1:11434/api/tags', { timeout: 2000 }, resp => { let b = ''; resp.on('data', d => b += d); resp.on('end', () => resolve(b)); });
          rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('timeout')));
        });
        const ol = JSON.parse(olBody);
        (ol.models || []).forEach(m => push(m.name, 'Ollama', 'http://127.0.0.1:11434/v1'));
      } catch (e) { /* Ollama 未启动，跳过 */ }
      return send(res, 200, { online: models.length > 0, models });
    }
    // AI Agent：可用工具清单（前端展示"我能帮你做什么"）
    if (p === '/api/ai/agent/tools' && req.method === 'GET') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      return send(res, 200, {
        tools: agent.TOOLS.map(t => ({
          name: t.function.name,
          description: t.function.description,
          write: agent.WRITE_TOOLS.has(t.function.name),
          danger: agent.DANGER_TOOLS.has(t.function.name)
        }))
      });
    }
    // AI Agent：对话 + 工具调用（删除类操作返回 pending，需前端确认后才落地）
    if (p === '/api/ai/agent' && req.method === 'POST') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      if (!rateLimit('ai:' + req.user.id, 30, 60 * 1000)) return send(res, 429, { error: 'AI 调用过于频繁，请稍后再试' });
      const body = await readBody(req);
      const c = await loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key 或启用本地模型' });
      const message = String(body.message || '').trim();
      if (!message && !body.confirmToken && !body.cancelledToken) return send(res, 400, { error: '请输入内容' });
      try {
        const out = await agent.runAgent({ cfg: c, user: req.user, message, history: body.history, confirmToken: body.confirmToken, cancelledToken: body.cancelledToken });
        return send(res, 200, Object.assign({ ok: true }, out));
      } catch (e) {
        console.error('AI agent 失败:', (e && e.message) || e);
        return send(res, 502, { error: 'AI Agent 执行失败：' + ((e && e.message) || '服务不可用') });
      }
    }
    if (p === '/api/ai/chat' && req.method === 'POST') {
      if (!rateLimit('ai:' + req.user.id, 30, 60 * 1000)) return send(res, 429, { error: 'AI 调用过于频繁，请稍后再试' });
      const body = await readBody(req);
      const c = await loadAI();
      if (!aiConfigured(c)) return send(res, 400, { error: 'AI 未配置：请先在「AI 设置」中填写 API Key' });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return send(res, 400, { error: 'messages 为空' });
      try { const text = await chatCompletions(c, messages, body.temperature); return send(res, 200, { text }); }
      catch (e) { console.error('AI chat 失败:', e); return send(res, 502, { error: 'AI 服务暂时不可用，请稍后重试' }); }
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
      } catch (e) { console.error('AI 生成失败:', e); return send(res, 502, { error: 'AI 服务暂时不可用，请稍后重试' }); }
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
        const sys = '你是项目复盘助手。根据以下结构化数据，用简洁中文输出 160 字以内的 Markdown 排版总结：首句总览进度与主要风险，之后用「- 」要点列出进展、风险/逾期、下一步，关键数字用 **加粗**。不要输出长段散文。';
        const user = `项目：${proj.name}\n整体进度：${total ? Math.round(done / total * 100) : 0}%（${done}/${total}）\n逾期节点：${overdue}\n各阶段：${phaseStat}`;
        try { const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0.5); return send(res, 200, { text }); }
        catch (e) { console.error('AI 总结失败:', e); return send(res, 502, { error: 'AI 服务暂时不可用，请稍后重试' }); }
      }
      const lines = projects.map(proj => {
        const ts = proj.tasks || []; const total = ts.length, done = ts.filter(t => t.done).length;
        const overdue = ts.filter(t => !t.done && t.dueDate && t.dueDate < isoDate(new Date())).length;
        const cur = (proj.phases || []).find(ph => ts.some(t => t.phaseId === ph.id && !t.done));
        const arch = (proj.status || 'active') === 'archived' ? '（已归档）' : '';
        return `「${proj.name}」进度${total ? Math.round(done / total * 100) : 0}%（${done}/${total}）${overdue ? '，逾期' + overdue + '项' : ''}${cur ? '，当前阶段：' + cur.name : ''}${arch}`;
      }).join('\n');
      const sys = '你是项目组合复盘助手。根据以下所有项目的结构化摘要，用简洁中文输出 200 字以内的 Markdown 排版' + modeLabel + '：首句整体判断，之后用「- 」要点列出整体进展、点名风险项目（含数字）、下一步建议，重要数字用 **加粗**。不要输出长段散文。';
      const user = `共 ${projects.length} 个项目：\n${lines}`;
      try { const text = await chatCompletions(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0.5); return send(res, 200, { text }); }
      catch (e) { console.error('AI 总结失败:', e); return send(res, 502, { error: 'AI 服务暂时不可用，请稍后重试' }); }
    }
    return send(res, 404, { error: '接口不存在' });
}

function createFromTemplate(tpl, name, opts) {
  opts = opts || {};
  const phases = (tpl.phases || []).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const tasks = (tpl.tasks || []).map(t => ({
    id: uid(), title: t.title, phaseId: t.phaseId, note: t.note || '',
    estimateDays: t.estimateDays || 0, assignee: t.assignee || '', done: false,
    startDate: null, dueDate: null,
    // 保留模版携带的排期公式/规则：用户自建（导入参考模版）的模版若带公式，用它建的项目
    // 也按工作日级联、导出的计划表同样带 WORKDAY.INTL 公式；内置模版无公式 → 自然日 + 纯日期。
    // 历史行为是这里直接丢弃规则，导致「同一模版，页面日期与 Excel 日期两套算法」。
    excelRow: t.excelRow != null ? t.excelRow : undefined,
    startF: t.startF || undefined, dueF: t.dueF || undefined,
    startRule: t.startRule || undefined, dueRule: t.dueRule || undefined
  }));
  const startDate = isoDate(new Date());
  const hasRules = tasks.some(t => t.startRule || t.dueRule);
  scheduleTasks(phases, tasks, startDate, hasRules ? 'workday' : 'calendar');
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
  const nonce = crypto.randomBytes(16).toString('base64');
  res._nonce = nonce;
  res._csp = cspHeader(nonce);
  res._acceptEnc = req.headers['accept-encoding'] || '';
  res._canGzip = true;
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`));
  if (p.startsWith('/api/')) {
    req.user = resolveUser(req); // 每请求解析当前用户（token → SQLite tokens 表；查不到即未登录）
    // 登录接口（免鉴权，放最前）
    if (p === '/api/login' && req.method === 'POST') {
      // 仅当直接 peer 是受信代理（cloudflared 连 localhost）才信任 X-Forwarded-For；
      // 否则（如绕过隧道直连）直接用真实 socket IP，防止客户端伪造 XFF 轮转登录限流键
      const peer = req.socket.remoteAddress;
      const trustedProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      const ip = trustedProxy ? ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || peer) : peer;
      if (!rateLimit('login:' + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: '登录尝试过于频繁，请 15 分钟后再试' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const u = db.verifyUser(name, String(body.password || ''));
      if (!u) {
        // 按账号失败计数锁定（防爆破）：连续 8 次失败临时锁定 15 分钟
        const k = 'lf:' + name.toLowerCase();
        const b = rateBuckets.get(k) || { n: 0, t: Date.now() }; b.n++; b.t = Date.now(); rateBuckets.set(k, b);
        if (b.n >= 8) return send(res, 429, { error: '该账号登录失败过多，已临时锁定 15 分钟' });
        return send(res, 401, { error: '用户名或密码错误' });
      }
      rateBuckets.delete('lf:' + name.toLowerCase());
      const token = db.issueToken(u.id);
      return send(res, 200, { token, user: { id: u.id, name: u.name, role: u.role }, mustChange: !!u.mustChange });
    }
    // GET 接口统一鉴权（2026-08-25 两轮评审）：除登录 / 只读状态 / 本机 Ollama 探测外，其余 GET 均需登录
    const PUBLIC_GET = ['/api/readonly', '/api/ai/ollama-models', '/api/version', '/api/latest-release'];
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
    // 待办导出为「前端已算好的数据 → 服务端排版成 xlsx」的纯 transform，不读服务端数据/不写库，免鉴权（与 /api/readonly 同列）
    const PUBLIC_POST = ['/api/reports/todo-export'];
    if (req.method !== 'GET' && !PUBLIC_POST.includes(p) && !authorized(req)) {
      return send(res, 401, { error: '未授权：请先登录（X-Auth-Token）' });
    }
    // viewer 只读：任何写操作一律拒绝（含项目/任务/选项/AI/用户）
    // 例外：/api/ai/summarize 为纯只读 AI 文本生成（读项目数据→调 LLM→返回 Markdown，不落任何库），
    //       viewer 也应能用（日报/周报/月报页的「AI 总结」按钮对只读访客可见）。
    const VIEWER_AI_READONLY = ['/api/ai/summarize'];
    if (req.method !== 'GET' && req.user && req.user.role === 'viewer' && !VIEWER_AI_READONLY.includes(p)) {
      return send(res, 403, { error: '只读访客，无修改权限' });
    }
    // P1-8 强制改密闸门：仍在用初始密码的账号，除改密外禁止任何写操作（服务端强制，不依赖前端弹窗）
    // 例外：viewer 游客（系统只读账号，本就无写权限）
    if (req.method !== 'GET' && req.user && req.user.role !== 'viewer' && db.usesDefaultPassword(req.user.id)) {
      return send(res, 403, { error: '您仍在使用初始密码，请先修改密码后再操作', code: 'MUST_CHANGE_PASSWORD' });
    }
    // 用户管理（admin）：列出 / 新建 / 改角色
    if (p === '/api/users') {
      if (!req.user || req.user.role !== 'admin') return send(res, 403, { error: '仅管理员可操作' });
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
      if (!req.user || req.user.role !== 'admin') return send(res, 403, { error: '仅管理员可操作' });
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
      const full = fullReportRole(req.user.role);
      const data = db.reportByUser();
      return send(res, 200, full ? data : data.filter(r => r.user.id === req.user.id));
    }
    // 聚合报告导出 xlsx（权限同 /api/report）
    if (p === '/api/report/export' && req.method === 'GET') {
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const full = fullReportRole(req.user.role);
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
      if (req.method === 'GET') return send(res, 200, { on: await isRO(), tag: INSTANCE_TAG });
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { fs.writeFileSync(RO_FLAG, (body && body.on) ? '1' : '0'); }
        catch (e) { return send(res, 500, { error: '切换失败' }); }
        return send(res, 200, { on: !!(body && body.on) });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    // 版本信息：本地版本（package.json）与 GitHub Release 对齐，用于确认 update.zip 升级是否成功
    if (p === '/api/version' && req.method === 'GET') {
      let ver = 'unknown';
      try { ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) {}
      return send(res, 200, {
        version: ver,
        port: PORT,
        node: process.version,
        uptime: Math.floor(process.uptime()),
        repo: 'forestkopa/project-kanban'
      });
    }
    // GitHub 最新 Release（服务端代理，规避浏览器 CSP connect-src 限制；用于版本对比）
    if (p === '/api/latest-release' && req.method === 'GET') {
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 8000);
        const gh = await fetch('https://api.github.com/repos/forestkopa/project-kanban/releases/latest', {
          headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'kanban-version-check' },
          signal: ac.signal
        });
        clearTimeout(to);
        if (!gh.ok) return send(res, 200, { ok: false, error: 'HTTP ' + gh.status });
        const j = await gh.json();
        return send(res, 200, { ok: true, tag: j.tag_name, version: (j.tag_name || '').replace(/^v/, ''), url: j.html_url });
      } catch (e) {
        return send(res, 200, { ok: false, error: (e && e.message) || 'fetch failed' });
      }
    }
    // 一键升级功能已移除（v1.5.7）：仅保留 /api/version 与 /api/latest-release 做版本显示
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
      await saveJSON(TEMPLATES_FILE, cur); // await：写盘落定后再响应，避免前端紧接着读列表/用模板建项目读到旧数据
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
    // 下载参考模版（内置模版生成的计划表方言 Excel：序号/阶段/任务/负责人/开始日期/截止日期/工期(天)/状态/备注，
    // 无「项目开始」行，序号 1 的开始日期即项目开始时间；后续行 WORKDAY.INTL 公式级联）
    if (p === '/api/templates/reference-xlsx' && req.method === 'GET') {
      const tpls = await loadJSON(TEMPLATES_FILE, []);
      const id = url.searchParams.get('tplId');
      const tpl = (id && tpls.find(t => t.id === id)) || tpls[0];
      if (!tpl) return send(res, 404, { error: '暂无内置模版' });
      const buf = buildTemplateXlsx(tpl);
      const date = isoDate(new Date()).replace(/-/g, '');
      const ascii = `kanban_reference_${date}.xlsx`;
      // 文件名净化：用户自建/导入的模板名可能含 /（历史内置模板「智能摄像头 / AI 视觉」就踩过坑），
      // 直接拼进文件名会让落盘名非法（浏览器会替换成 _ 或截断）。统一把 / \ : * ? " < > | 换成 _ 并收敛多余空格。
      const safeName = String(tpl.name || '模版').replace(/[\\/:*?"<>|]/g, '_').replace(/\s*_\s*/g, '_').trim();
      const utf8 = `${safeName}_参考模版_${date}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`
      });
      return res.end(buf);
    }

    // ---- AI 助手（OpenAI 兼容）：逻辑已抽取到模块级 handleAi()，此处仅做分发 ----
    if (p.startsWith('/api/ai')) { await handleAi(p, req, res); return; }

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
          tasks: (parsed.tasks || []).map(t => ({
            title: t.title, phaseId: t.phaseId, note: t.note || '', estimateDays: t.estimateDays || 0, assignee: t.assignee || '',
            startDate: t.startDate || null, dueDate: t.dueDate || null,
            // excelRow 必须一起保留：公式链（=WORKDAY.INTL(E3,1) 之类）靠行号定位依赖任务，
            // 丢了它 recalcProject 的 rowMap 就是空的 → 用该模板建的项目改工期不会级联重算。
            excelRow: t.excelRow != null ? t.excelRow : undefined,
            startF: t.startF || undefined, dueF: t.dueF || undefined,
            startRule: t.startRule || undefined, dueRule: t.dueRule || undefined
          }))
        };
        cur.push(tpl);
        // await：必须等模板落盘再响应 —— 否则「导入模板 → 立刻用该模板建项目」会因读到旧文件而 400 模板不存在
        await saveJSON(TEMPLATES_FILE, cur);
        return send(res, 200, { added: 1, templates: [tpl] });
      } catch (e) { return send(res, 400, { error: '解析参考模版失败: ' + e.message }); }
    }

    // 待办清单导出（带样式 xlsx）：按 kind 区分文件名,projects 由前端按 range 预过滤
    if (p === '/api/reports/todo-export' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.projects)) return send(res, 400, { error: '缺少项目数据' });
      const kind = body.kind === 'today' ? 'today' : body.kind === 'month' ? 'month' : body.kind === 'nextweek' ? 'nextweek' : 'week';
      const today = isoDate(new Date());
      const range = body.range || {};
      const monIso = range.mon || today, sunIso = range.sun || monIso;
      const buf = buildTodoXlsx(body.projects, monIso, sunIso, kind);
      const date = today.replace(/-/g, '');
      const fileMap = {
        today: { ascii: 'daily_todo_' + date + '.xlsx', utf8: '今日待办_' + date + '.xlsx' },
        week:  { ascii: 'weekly_todo_' + date + '.xlsx', utf8: '周报待办清单_' + date + '.xlsx' },
        month: { ascii: 'monthly_todo_' + date + '.xlsx', utf8: '本月待办_' + date + '.xlsx' },
        nextweek: { ascii: 'nextweek_todo_' + date + '.xlsx', utf8: '下周待办_' + date + '.xlsx' }
      };
      const { ascii, utf8 } = fileMap[kind];
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
      const proj = db.getProject(ex[1], req.user.id, canAllRole(req.user.role));
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

    /* ---------- 回收站（P0-4）：列表 / 恢复 / 彻底删除 ---------- */
    if (p === '/api/trash' && req.method === 'GET') {
      return send(res, 200, db.trashList(req.user.id, canAllRole(req.user.role)));
    }
    const trRestore = p.match(/^\/api\/trash\/([^/]+)\/restore$/);
    if (trRestore && req.method === 'POST') {
      const item = db.trashGet(trRestore[1], req.user.id, isManagerRole(req.user.role));
      if (!item) return send(res, 404, { error: '回收站条目不存在或无权访问' });
      if (item.kind === 'project') {
        const pj = item.payload;
        if (db.getProject(pj.id, item.userId, true)) return send(res, 409, { error: '同 ID 项目已存在，无法恢复' });
        db.saveProject(pj, item.userId);
        db.trashDrop(item.id, req.user.id, isManagerRole(req.user.role));
        return send(res, 200, { ok: true, kind: 'project', project: pj });
      }
      // 任务：写回原项目（项目已被删则拒绝，提示先恢复项目）
      const host = db.getProject(item.projectId, item.userId, true);
      if (!host) return send(res, 409, { error: '所属项目已删除，请先恢复项目' });
      const t = item.payload.task || item.payload;
      if ((host.tasks || []).some(x => x.id === t.id)) return send(res, 409, { error: '该任务已存在' });
      const at = Math.min(Math.max(0, item.payload.seq || 0), (host.tasks || []).length);
      host.tasks.splice(at, 0, t);
      recalcProject(host);
      db.saveProject(host, item.userId);
      db.trashDrop(item.id, req.user.id, isManagerRole(req.user.role));
      return send(res, 200, { ok: true, kind: 'task', task: t, projectId: host.id });
    }
    const trDel = p.match(/^\/api\/trash\/([^/]+)$/);
    if (trDel && req.method === 'DELETE') {
      const ok = db.trashDrop(trDel[1], req.user.id, isManagerRole(req.user.role));
      if (!ok) return send(res, 404, { error: '条目不存在或无权删除' });
      return send(res, 200, { ok: true });
    }

    // 保存看板图标（上传 + 裁剪后的图片）
    if (p === '/api/brand-logo' && req.method === 'POST') {
      if (!['admin', 'manager'].includes(req.user.role)) return send(res, 403, { error: '仅管理员/副管理员可更换看板图标' });
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
        fs.writeFileSync(BRAND_LOGO_FILE, imgBuf);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: '图片数据无效' }); }
    }

    // 项目排序（左侧项目卡片拖拽后保存顺序）
    if (p === '/api/projects/order' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || !body.ids.length) return send(res, 400, { error: '缺少 ids 数组' });
      const canAll = canAllRole(req.user.role);
      const mine = db.listProjects(req.user.id, canAll).map(x => x.id);
      if (body.ids.some(id => !mine.includes(id))) return send(res, 400, { error: '包含未知项目 id' });
      db.setOrder(body.ids, req.user.id, canAll);
      return send(res, 200, { ok: true });
    }

    const m = p.match(/^\/api\/projects(?:\/([^/]+)(?:\/tasks(?:\/([^/]+))?)?)?$/);
    if (m) {
      const pid = m[1]; const tid = m[2];
      if (!req.user) return send(res, 401, { error: '请先登录' });
      const isAdmin = isManagerRole(req.user.role); // admin/副管理员：全量项目权限
      const canAll = canAllRole(req.user.role); // + viewer 只读全量
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
            // 项目开始时间由序号 1 任务的开始日期决定；未提供则用今天
            const startDate = body.startDate || (body.tasks[0] && body.tasks[0].startDate) || isoDate(new Date());
            const phases = body.phases.map((ph, i) => ({ id: ph.id || ('p' + (i + 1)), name: ph.name || ('阶段' + (i + 1)), color: ph.color || PHASE_COLORS[i % PHASE_COLORS.length] }));
            const tasks = body.tasks.map(t => ({ id: uid(), title: t.title || '未命名任务', phaseId: t.phaseId || phases[0].id, note: t.note || '', estimateDays: t.estimateDays || 0, assignee: t.assignee || '', done: !!t.done, startDate: null, dueDate: null, excelRow: t.excelRow != null ? t.excelRow : undefined, startF: t.startF || undefined, dueF: t.dueF || undefined, startRule: t.startRule || undefined, dueRule: t.dueRule || undefined }));
            const hasRules = tasks.some(t => t.startRule || t.dueRule);
            scheduleTasks(phases, tasks, startDate, hasRules ? 'workday' : 'calendar');
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
            dueDate: body.dueDate || isoDate(addDays(new Date(start), days)),
            recurrence: RECUR.includes(String(body.recurrence || '')) ? String(body.recurrence || '') : ''
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
            // 项目开始时间由序号 1 任务的开始日期决定
            const ft = (proj.tasks || [])[0];
            if (ft) { ft.startDate = body.startDate; delete ft.startRule; delete ft.startF; }
            proj.startDate = ((proj.tasks || [])[0] && (proj.tasks || [])[0].startDate) || body.startDate;
            needSchedule = true;
          }
          if (needSchedule) {
            const hasRules = (proj.tasks || []).some(t => t.startRule || t.dueRule);
            if (hasRules) recalcProject(proj); // 有公式 → 按公式级联（尊重用户自定义公式）
            else scheduleTasks(proj.phases, proj.tasks, proj.startDate, 'calendar'); // 无公式 → 自然日
          }
          db.saveProject(proj, req.user.id); return send(res, 200, proj);
        }
        if (req.method === 'DELETE') {
          // 先落回收站快照再删（P0-4：可恢复，30 天后自动清理）
          let trashId = null;
          try { trashId = db.trashPush(req.user.id, 'project', proj.id, proj, { projectId: proj.id, projectName: proj.name, title: proj.name }); }
          catch (e) { console.error('回收站写入失败（仍继续删除）:', e); }
          db.deleteProject(pid, req.user.id, isAdmin);
          return send(res, 200, { ok: true, trashId });
        }
        return send(res, 405, { error: '方法不允许' });
      }
      const tIdx = proj.tasks.findIndex(t => t.id === tid);
      if (req.method === 'PUT') {
        if (tIdx < 0) return send(res, 404, { error: '任务不存在' });
        const body = await readBody(req); const t = proj.tasks[tIdx];
        if (body.title !== undefined) t.title = body.title;
        if (body.note !== undefined) t.note = body.note;
        if (body.phaseId !== undefined) t.phaseId = body.phaseId;
        const wasDone = !!t.done;
        if (body.done !== undefined) t.done = !!body.done;
        if (body.recurrence !== undefined) t.recurrence = RECUR.includes(String(body.recurrence)) ? String(body.recurrence) : '';
        if (body.assignee !== undefined) t.assignee = body.assignee;
        if (body.estimateDays !== undefined) t.estimateDays = body.estimateDays;
        if (body.startDate) {
          t.startDate = body.startDate; delete t.startRule; delete t.startF; // 手动改开始 → 覆盖该任务自己的公式
          if ((proj.tasks || [])[0] && proj.tasks[0].id === t.id) proj.startDate = body.startDate; // 改立项开始 → 项目开始同步
        }
        if (body.dueDate) { t.dueDate = body.dueDate; delete t.dueRule; delete t.dueF; }
        if (body.startFormula !== undefined) { const sf = String(body.startFormula || '').trim(); t.startF = sf; t.startRule = sf ? parseFormula(sf) : undefined; } // 改公式
        if (body.dueFormula !== undefined) { const df = String(body.dueFormula || '').trim(); t.dueF = df; t.dueRule = df ? parseFormula(df) : undefined; }
        // P0-4 重复任务：从未完成→已完成，且设了重复周期 → 自动派生下一期（原任务保留为已完成记录）
        let spawned = null;
        if (!wasDone && t.done && t.recurrence && RECUR.includes(t.recurrence)) {
          spawned = spawnNextRecurrence(t);
          if (spawned) { proj.tasks.splice(tIdx + 1, 0, spawned); t.recurrence = ''; } // 重复归属转移到新任务，避免重复派生
        }
        recalcProject(proj); // 级联重算依赖该任务的后继日期
        db.saveProject(proj, req.user.id); return send(res, 200, spawned ? Object.assign({}, t, { spawned }) : t);
      }
      if (req.method === 'DELETE') {
        if (tIdx < 0) return send(res, 404, { error: '任务不存在' });
        const removed = proj.tasks[tIdx];
        let trashId = null;
        try { trashId = db.trashPush(req.user.id, 'task', removed.id, { task: removed, seq: tIdx }, { projectId: proj.id, projectName: proj.name, title: removed.title }); }
        catch (e) { console.error('回收站写入失败（仍继续删除）:', e); }
        proj.tasks.splice(tIdx, 1); db.saveProject(proj, req.user.id);
        return send(res, 200, { ok: true, trashId });
      }
      return send(res, 405, { error: '方法不允许' });
    }
    return send(res, 404, { error: '接口不存在' });
  }
  // 看板图标：按运行模式返回对应文件（demo/真实隔离），不走静态目录避免污染
  if (p === '/brand-logo.png' && req.method === 'GET') {
    return fs.readFile(BRAND_LOGO_FILE, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      const headers = Object.assign({ 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }, SEC_HEADERS);
      if (res._csp) headers['Content-Security-Policy'] = res._csp;
      endBody(res, 200, buf, headers);
    });
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
      const headers = Object.assign({ 'Content-Type': MIME[ext] || 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC_HEADERS);
      if (res._csp) headers['Content-Security-Policy'] = res._csp;
      // CSP nonce 注入：index.html 内联脚本靠 @NONCE@ 占位符获得每请求随机 nonce（去掉 unsafe-inline 后必需）
      const html = buf.toString().replace(/@VER@/g, ver).replace(/@NONCE@/g, res._nonce || '');
      endBody(res, 200, Buffer.from(html, 'utf8'), headers);
    });
    return;
  }
  const hasVer = url.searchParams.has('v');
  const cache = (rel === '/app.js' || rel === '/style.css') && hasVer ? 'public, max-age=31536000, immutable' : 'no-cache';
  fs.readFile(filepath, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    const headers = Object.assign({ 'Content-Type': MIME[ext] || (ext === '.webmanifest' ? 'application/manifest+json' : 'application/octet-stream'), 'Cache-Control': cache }, SEC_HEADERS);
    if (res._csp) headers['Content-Security-Policy'] = res._csp;
    endBody(res, 200, buf, headers);
  });
  } catch (e) {
    if (e && e.code === 'INVALID_JSON') return send(res, 400, { error: '请求体不是合法 JSON' });
    if (e && e.code === 'BODY_TOO_LARGE') return send(res, 413, { error: '请求体过大（上限 10MB）' });
    console.error('请求处理异常:', req.method, req.url, e);
    try { if (!res.headersSent) send(res, 500, { error: '服务器内部错误' }); } catch (_) {}
  }
});
server.listen(PORT, () => {
  console.log('Multi-project kanban running at http://localhost:' + PORT);
  console.log('就绪：admin（管理员）· guest（游客只读）。首次登录请修改默认密码，密码不再输出到日志。');
});
