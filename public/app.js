const API = '/api';
const TYPE_COLORS = { 'C端': '#0A84FF', 'B端': '#30D158', '预研': '#FF9F0A', '迭代': '#BF5AF2' };
const PRODUCT_TYPE_COLORS = {
  'AI': '#10a37f', 'CC线': '#06b6d4', 'DOCK': '#0ea5e9', 'MI': '#a3e635', 'MST': '#eab308',
  'PD+HUB': '#f97316', 'SSD HUB': '#64748b', 'TB5': '#6366f1', 'U4': '#a855f7',
  'WiFi dongle': '#14b8a6', '基础hub': '#94a3b8'
};
const LEVEL_COLORS = { 'S': '#E0241B', 'A': '#FF9F0A', 'B': '#30D158', 'C': '#0A84FF', 'D': '#BF5AF2', 'E': '#64D2FF', 'F': '#8E8E93' };
const ICON = {
  edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18 10l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2l1.9 5.3L19 9l-5.1 1.7L12 16l-1.9-5.3L5 9l5.1-1.7z"/><circle cx="18.6" cy="17.4" r="1.5"/><circle cx="5.4" cy="15.8" r="1.1"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7l1 13h16l1-13H3z"/><path d="M3 7h18"/><path d="M10 7V4h4v3"/></svg>',
  tag: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7l1 3H4z"/><circle cx="16.5" cy="14.5" r="3.5"/></svg>'
};
let state = { projects: [], templates: [], currentId: null, editingTaskId: null, view: 'board', cal: new Date(), dailyDate: new Date(), weekDate: new Date(), monthlyDate: new Date(), demo: false, readonly: false };
let pending = null; // { mode:'tpl', tplId } | { mode:'import', projId }

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const doFetch = () => fetch(API + path, { ...opts, method, headers });
  // 演示模式（--demo）：服务端免令牌鉴权，前端不再弹"访问令牌"输入框
  if (method !== 'GET' && !state.demo) {
    let tok = ''; try { tok = localStorage.getItem('kb-token') || ''; } catch (e) {}
    if (tok) headers['X-Auth-Token'] = tok;
    let r = await doFetch();
    if (r.status === 401) {
      // 写操作需要访问令牌：提示输入一次并记住（令牌在服务器 data/auth.token 或启动日志中）
      const t = prompt('写操作需要访问令牌，请输入（本机服务器 data/auth.token 文件里可以查看）：');
      if (t && t.trim()) {
        try { localStorage.setItem('kb-token', t.trim()); } catch (e) {}
        headers['X-Auth-Token'] = t.trim();
        r = await doFetch();
      }
    }
    if (!r.ok) { const e = await r.json().catch(() => ({ error: r.status })); throw new Error(e.error || r.status); }
    return r.status === 204 ? null : r.json();
  }
  let r = await doFetch();
  if (!r.ok) { const e = await r.json().catch(() => ({ error: r.status })); throw new Error(e.error || r.status); }
  return r.status === 204 ? null : r.json();
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 1800); }
// 输入防抖：连续修改只在停顿后提交一次
const _db = {};
function debounce(key, fn, ms) { clearTimeout(_db[key]); _db[key] = setTimeout(fn, ms || 300); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function proj() { return state.projects.find(p => p.id === state.currentId); }
function progress(p) {
  if (!p || !p.tasks.length) return 0;
  const total = p.tasks.reduce((a, t) => a + (Number(t.estimateDays) > 0 ? Number(t.estimateDays) : 1), 0);
  const done = p.tasks.reduce((a, t) => a + (t.done ? (Number(t.estimateDays) > 0 ? Number(t.estimateDays) : 1) : 0), 0);
  return Math.round(done / total * 100);
}

function isoDate(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function parseD(s) { return s ? new Date(s + 'T00:00:00') : null; }
function dayDiff(a, b) { return Math.round((parseD(a) - parseD(b)) / 86400000); }
function phaseColor(p, t) { const ph = p.phases.find(x => x.id === t.phaseId); return ph ? ph.color : '#888'; }
function TODAY() { return isoDate(new Date()); }

async function loadAll() {
  try {
    state.templates = await api('/templates');
    state.projects = await api('/projects');
    try { const r = await api('/readonly'); state.readonly = !!(r && r.on); state.demo = !!(r && r.demo); if (state.demo) { const b = document.getElementById('demoBadge'); if (b) b.classList.remove('hidden'); } } catch (e) {}
    if (!state.currentId && state.projects[0]) state.currentId = state.projects[0].id;
  } catch (e) { toast('加载失败: ' + e.message); }
  refreshMappingSelect();
  render();
}

function render() {
  renderSidebar();
  const p = proj();
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  const secMap = { board: 'board', gantt: 'gantt', calendar: 'calendar', panorama: 'panorama', daily: 'report', weekly: 'report', monthly: 'monthly' };
  ['board', 'gantt', 'calendar', 'panorama', 'report', 'monthly'].forEach(id => $('#' + id).classList.add('hidden'));
  if (secMap[state.view]) $('#' + secMap[state.view]).classList.remove('hidden');
  $('#viewActions').innerHTML = '';
  if (!p) {
    $('#projTitle').innerHTML = '<span class="muted">未选择项目</span>';
    $('#projMeta').innerHTML = '';
    $('#board').innerHTML = '<div class="empty" style="margin:auto">从左侧「新建项目」开始：从模版导入，或从 xlsx 导入已有计划。</div>';
    $('#gantt').innerHTML = ''; $('#calendar').innerHTML = ''; $('#panorama').innerHTML = ''; $('#report').innerHTML = '';
    $('#stats').style.display = 'none';
    updateIOState();
    applyReadOnly();
    return;
  }
  const c = TYPE_COLORS[p.type] || '#888';
  const lc = LEVEL_COLORS[p.level] || '#8E8E93';
  const ptc = PRODUCT_TYPE_COLORS[p.productType] || '#8E8E93';
  $('#projTitle').innerHTML = `<span class="pdot" style="background:${p.color}"></span> ${esc(p.name)} <span class="type-pill" style="background:${c}">${p.type || ''}</span><span class="level-pill" style="background:${lc}">${p.level || ''}</span>${p.productType ? `<span class="ptype-pill" style="color:${ptc}">${esc(p.productType)}</span>` : ''}`;
  const isArch = (p.status || 'active') === 'archived';
  $('#projMeta').innerHTML = `${p.cert ? `<span class="cert-tag">${ICON.tag} ${esc(p.cert)}</span>` : ''}${isArch ? '<span class="tag" style="background:#8E8E93;color:#fff">' + ICON.box + ' 已归档</span>' : ''}`;
  if (state.view === 'board') renderBoard(p);
  else if (state.view === 'gantt') renderGantt(p);
  else if (state.view === 'calendar') renderCalendar(p);
  else if (state.view === 'panorama') renderPanorama();
  else if (state.view === 'monthly') renderMonthly();
  else renderReport();
  $('#stats').style.display = (state.view === 'board') ? 'flex' : 'none';
  updateIOState();
  applyReadOnly();
}

function applyReadOnly() {
  const ro = state.readonly;
  document.body.classList.toggle('ro', ro);
  const b = $('#roBanner'); if (b) b.classList.toggle('hidden', !ro);
  const nb = $('#newProjectBtn'); if (nb) nb.disabled = ro;
  const rb = $('#roBtn'); if (rb) rb.textContent = ro ? '🔓 解除只读' : '🔒 开启只读';
}

function projCard(p, dim) {
  const el = document.createElement('div');
  el.className = 'proj' + (p.id === state.currentId ? ' active' : '') + (dim ? ' archived' : '');
  el.onclick = () => { state.currentId = p.id; render(); };
  const pc = progress(p);
  const c = TYPE_COLORS[p.type] || '#888';
  const lc = LEVEL_COLORS[p.level] || '#8E8E93';
  const ptc = PRODUCT_TYPE_COLORS[p.productType] || '#8E8E93';
  el.innerHTML = `<div class="proj-top"><span class="dot" style="background:${p.color}"></span><span class="pname">${esc(p.name)}</span><span class="type-pill" style="background:${c}">${p.type || ''}</span><span class="level-pill" style="background:${lc}">${p.level || ''}</span>${p.productType ? `<span class="ptype-pill" style="color:${ptc}">${esc(p.productType)}</span>` : ''}</div>
    <div class="bar"><div class="bar-fill" style="width:${pc}%;background:${p.color}"></div></div>
    <div class="pmeta">${pc}% · ${p.tasks.filter(t => t.done).length}/${p.tasks.length}${p.cert ? `<span class="cert-tag">${ICON.tag} ${esc(p.cert)}</span>` : ''}${dim ? ' · ' + ICON.box + '已归档' : ''}</div>
    <button class="proj-edit" title="编辑项目信息">${ICON.edit}</button>`;
  el.querySelector('.proj-edit').onclick = e => {
    e.stopPropagation();
    state.currentId = p.id;
    pending = { mode: 'edit', projId: p.id };
    openProjInfo('', p);
  };
  return el;
}
function renderSidebar() {
  const list = $('#projList'); list.innerHTML = '';
  const active = state.projects.filter(p => (p.status || 'active') !== 'archived');
  const archived = state.projects.filter(p => (p.status || 'active') === 'archived');
  if (!state.projects.length) { list.innerHTML = '<div class="empty">还没有项目。<br>点上方「新建项目」，用模板快速搭建。</div>'; return; }
  active.forEach(p => list.appendChild(projCard(p, false)));
  if (archived.length) {
    const sec = document.createElement('div'); sec.className = 'side-sec'; sec.textContent = '已归档 · ' + archived.length;
    list.appendChild(sec);
    archived.forEach(p => list.appendChild(projCard(p, true)));
  }
}

function renderBoard(p) {
  const pc = progress(p);
  $('#stats').style.display = 'flex';
  $('#stats').innerHTML = `
    <div class="stat"><div class="stat-num">${pc}%</div><div class="stat-lbl">总进度</div></div>
    <div class="stat"><div class="stat-num">${p.tasks.length}</div><div class="stat-lbl">任务</div></div>
    <div class="stat"><div class="stat-num">${p.tasks.filter(t => t.done).length}</div><div class="stat-lbl">已完成</div></div>
    <div class="stat"><div class="stat-num">${p.tasks.filter(t => !t.done).length}</div><div class="stat-lbl">进行中</div></div>`;
  const board = $('#board'); board.innerHTML = '';
  p.phases.forEach(ph => {
    const col = document.createElement('div'); col.className = 'col';
    const tasks = p.tasks.filter(t => t.phaseId === ph.id);
    const head = document.createElement('div');
    head.className = 'col-head'; head.style.borderTopColor = ph.color;
    head.innerHTML = `<span>${esc(ph.name)}</span><span class="col-count">${tasks.length}</span>`;
    col.appendChild(head);
    const body = document.createElement('div'); body.className = 'col-body';
    body.ondragover = e => { e.preventDefault(); col.classList.add('drag'); };
    body.ondragleave = () => col.classList.remove('drag');
    body.ondrop = e => { e.preventDefault(); col.classList.remove('drag'); const tid = e.dataTransfer.getData('text/plain'); if (tid) moveTask(p.id, tid, ph.id); };
    tasks.forEach(t => body.appendChild(taskCard(p, t, ph)));
    if (!tasks.length) { const e = document.createElement('div'); e.className = 'empty'; e.style.padding = '8px'; e.textContent = '拖拽任务到此'; body.appendChild(e); }
    col.appendChild(body); board.appendChild(col);
  });
}

function taskCard(p, t, ph) {
  const el = document.createElement('div'); el.className = 'card' + (t.done ? ' done' : '');
  el.draggable = !state.readonly;
  el.ondragstart = e => e.dataTransfer.setData('text/plain', t.id);
  el.innerHTML = `
    <label class="chk"><input type="checkbox" ${t.done ? 'checked' : ''} ${state.readonly ? 'disabled' : ''}><span class="ctitle">${esc(t.title)}</span></label>
    ${t.note ? `<div class="cnote">${esc(t.note)}</div>` : ''}
    <div class="cmeta"><span class="phase" style="color:${ph.color}">${esc(ph.name)}</span>${t.assignee ? `<span class="who">@${esc(t.assignee)}</span>` : ''}${t.estimateDays ? `<span class="days">${t.estimateDays}d</span>` : ''}</div>
    <div class="cacts"><button class="mini" data-edit title="编辑">${ICON.edit}</button><button class="mini del" data-del title="删除">${ICON.del}</button></div>`;
  el.querySelector('input').onchange = async e => {
    try { await api(`/projects/${p.id}/tasks/${t.id}`, { method: 'PUT', body: JSON.stringify({ done: e.target.checked }) }); t.done = e.target.checked; render(); }
    catch (err) { toast(err.message); }
  };
  el.querySelector('[data-edit]').onclick = () => openTaskModal(p, t);
  el.querySelector('[data-del]').onclick = async () => {
    if (!confirm('删除任务？')) return;
    try { await api(`/projects/${p.id}/tasks/${t.id}`, { method: 'DELETE' }); p.tasks = p.tasks.filter(x => x.id !== t.id); render(); }
    catch (err) { toast(err.message); }
  };
  return el;
}

async function moveTask(pid, tid, phaseId) {
  try { const t = await api(`/projects/${pid}/tasks/${tid}`, { method: 'PUT', body: JSON.stringify({ phaseId }) }); const p = proj(); const x = p.tasks.find(y => y.id === tid); Object.assign(x, t); render(); }
  catch (err) { toast(err.message); }
}

/* ---------- Gantt ---------- */
function ruleStr(rule) {
  if (!rule) return '';
  if (rule.t === 'ref') return '=' + rule.ref;
  if (rule.t === 'lit') return '=' + rule.v;
  if (rule.t === 'off') return '=' + ruleStr(rule.base).slice(1) + (rule.days < 0 ? rule.days : '+' + rule.days);
  if (rule.t === 'arith') {
    let s = ruleStr(rule.parts[0]).slice(1);
    for (let i = 1; i < rule.parts.length; i++) { const p = rule.parts[i]; const ps = p.t === 'n' ? String(p.v) : ruleStr(p).slice(1); s += (ps[0] === '-' || ps[0] === '+' ? ps : '+' + ps); }
    return '=' + s;
  }
  if (rule.t === 'wd') return '=WORKDAY.INTL(' + ruleStr(rule.base).slice(1) + ',' + ruleStr(rule.days).slice(1) + ',' + (rule.weekend || 1) + ')';
  return '';
}
function ganttGridBg(min) {
  let first = -1;
  for (let i = 0; i < 7; i++) { const wd = new Date(min.getTime() + i * 86400000).getDay(); if (wd === 0 || wd === 6) { first = i; break; } }
  const x = first * 22;
  const layers = [];
  if (first >= 0) layers.push(`repeating-linear-gradient(90deg, transparent 0 ${x}px, var(--bg-2) ${x}px ${x + 44}px, transparent ${x + 44}px ${x + 154}px)`);
  layers.push('repeating-linear-gradient(90deg, transparent 0 21.5px, var(--border) 21.5px 22px)');
  return layers.join(',');
}
let ganttSel = null; // 当前选中的日期格 { tid, field:'start'|'due' }
let ganttRM = null;  // 当前视图行号映射 { rows, map }
/* 当前视图坐标系：row1=表头行, 2..=分组/任务行；列 A=任务 B=开始 C=结束 D=天数；B1=项目开始（虚拟格） */
function ganttRowMap(p) {
  const rows = []; let n = 2;
  (p.phases || []).forEach(ph => {
    const ts = (p.tasks || []).filter(t => t.phaseId === ph.id);
    if (!ts.length) return;
    rows.push({ kind: 'group', name: ph.name, row: n++ });
    ts.forEach(t => rows.push({ kind: 'task', task: t, row: n++ }));
  });
  const map = {}; rows.forEach(r => { if (r.kind === 'task') map[r.task.id] = r.row; });
  return { rows, map };
}
/* xlsx 坐标 → 当前视图坐标（D/E/F 列 → B/C/D；项目开始格 → B1） */
function xlsxToCur(ref, p, rm) {
  const m = String(ref).match(/^([A-Z]+)(\d+)$/); if (!m) return ref;
  const col = m[1].toUpperCase(), r = parseInt(m[2]);
  if (p.startCell && ref.toUpperCase() === p.startCell.toUpperCase()) return 'B1';
  if (col === 'D' || col === 'E' || col === 'F') {
    const t = (p.tasks || []).find(x => x.excelRow === r);
    const nr = t ? rm.map[t.id] : r;
    if (col === 'D') return 'B' + nr; if (col === 'E') return 'C' + nr; if (col === 'F') return 'D' + nr;
  }
  return ref;
}
/* 规则结构体 → 当前坐标公式字符串（显示用） */
function curFormulaStr(rule, p, rm) {
  if (!rule) return '';
  const T = x => curFormulaStr(x, p, rm);
  if (rule.t === 'ref') return xlsxToCur(rule.ref, p, rm);
  if (rule.t === 'lit' || rule.t === 'n') return String(rule.v);
  if (rule.t === 'off') return T(rule.base) + (rule.days < 0 ? rule.days : '+' + rule.days);
  if (rule.t === 'arith') {
    let s = T(rule.parts[0]);
    for (let i = 1; i < rule.parts.length; i++) { const ps = T(rule.parts[i]); s += (ps[0] === '-' || ps[0] === '+' ? ps : '+' + ps); }
    return s;
  }
  if (rule.t === 'wd') return 'WORKDAY.INTL(' + T(rule.base) + ',' + T(rule.days) + ',' + (rule.weekend || 1) + ')';
  return '';
}
/* 当前坐标公式字符串 → xlsx 坐标公式字符串（提交给服务端） */
function curToXlsxFormula(str, p, rm) {
  if (!str) return str;
  let s = String(str).trim().replace(/^=/, '');
  s = s.replace(/\b([A-Z]+)(\d+)\b/g, (_, col, r) => {
    col = col.toUpperCase(); r = parseInt(r);
    if (col === 'B' && r === 1 && p.startCell) return p.startCell.toUpperCase();
    if (col === 'B' || col === 'C' || col === 'D') {
      const row = rm.rows.find(x => x.row === r);
      if (row && row.kind === 'task' && row.task.excelRow) {
        const er = row.task.excelRow;
        return (col === 'B' ? 'D' : col === 'C' ? 'E' : 'F') + er;
      }
    }
    return col + r;
  });
  return s;
}
function syncFormulaBox(p) {
  const box = $('#gFormulaBox'); if (!box) return;
  if (!ganttSel) { box.value = ''; box.placeholder = '点选开始/结束日期查看并修改公式'; return; }
  const t = p.tasks.find(x => x.id === ganttSel.tid);
  const isStart = ganttSel.field === 'start';
  const rule = t ? (isStart ? (t.startRule || null) : (t.dueRule || null)) : null;
  const raw = t ? (isStart ? (t.startF || '') : (t.dueF || '')) : '';
  if (rule) { box.value = '=' + curFormulaStr(rule, p, ganttRM); box.placeholder = ''; }
  else if (raw) { const rf = String(raw).trim(); box.value = (rf.startsWith('=') ? '' : '=') + rf; box.placeholder = '原表公式（xlsx 坐标），可直接修改'; }
  else { box.value = ''; box.placeholder = t ? '无公式 · 输入公式可设置联动（空=清除）' : ''; }
}
function renderGantt(p) {
  $('#viewActions').innerHTML = `<span class="va-label">项目开始</span><input type="date" id="projStart" class="inp" value="${p.startDate || ''}"><button class="btn" id="reschedBtn" title="保留公式，按公式全量重算一遍（无公式则顺序排期）">重新排期</button>`;
  $('#projStart').onchange = e => {
    const v = e.target.value;
    debounce('ps', async () => {
      try { await api('/projects/' + p.id, { method: 'PUT', body: JSON.stringify({ startDate: v }) }); p.startDate = v; const np = await api('/projects/' + p.id); Object.assign(p, np); render(); }
      catch (err) { toast(err.message); }
    });
  };
  $('#reschedBtn').onclick = async () => {
    try { const np = await api('/projects/' + p.id + '/reschedule', { method: 'POST' }); Object.assign(p, np); render(); toast('已按公式重算排期'); }
    catch (err) { toast(err.message); }
  };
  const wrap = $('#gantt');
  if (!p.tasks.length) { wrap.innerHTML = '<div class="empty" style="margin:auto">暂无任务</div>'; return; }
  const rm = ganttRowMap(p);
  const starts = p.tasks.map(t => parseD(t.startDate || p.startDate));
  const dues = p.tasks.map(t => parseD(t.dueDate || t.startDate || p.startDate));
  let min = new Date(Math.min(...starts, parseD(p.startDate)));
  let max = new Date(Math.max(...dues));
  min = addDays(min, -2); max = addDays(max, 3);
  const totalDays = Math.max(1, dayDiff(isoDate(max), isoDate(min)) + 1);
  const dayW = 22, trackW = totalDays * dayW;
  const today = isoDate(new Date());
  const tIdx = dayDiff(today, isoDate(min));
  const todayLeft = (tIdx >= 0 && tIdx <= totalDays) ? tIdx * dayW : null;
  const bg = ganttGridBg(min);
  const headCell = (cls, content) => `<div class="${cls}">${content}</div>`;
  // 横坐标字母行：纯列标 A/B/C/D（独立坐标行，仅用于公式定位）+ 时间轴刻度/今日线
  let head = '<div class="g-label-head g-alpha">' + headCell('g-rnum', '') +
    headCell('g-colA g-cols', 'A') + headCell('g-colB g-cols', 'B') + headCell('g-colC g-cols', 'C') + headCell('g-colD g-cols', 'D') +
    `<div class="g-track-head" style="width:${trackW}px;background-image:${bg}">`;
  for (let i = 0; i < totalDays; i += 7) { const dt = isoDate(addDays(min, i)); head += `<span class="g-tick" style="left:${i * dayW}px">${dt.slice(5)}</span>`; }
  if (todayLeft !== null) head += `<div class="today-line" style="left:${todayLeft}px"></div>`;
  head += '</div></div>';
  // 表头行（行号 1）：A1=公式框、B1=开始、C1=结束、D1=天数（列名，项目开始日期在工具栏）
  head += `<div class="g-label-head"><div class="g-rnum">1</div>` +
    `<div class="g-fbox"><span class="g-fbox-label">公式</span><input type="text" id="gFormulaBox" placeholder="点选开始/结束日期查看并修改公式"${state.readonly ? ' disabled' : ''}></div>` +
    headCell('g-date-head', '开始') + headCell('g-date-head', '结束') + headCell('g-colD', '天数') +
    `<div class="g-track-head" style="width:${trackW}px"></div></div>`;
  let body = '';
  // 分组/任务行（行号 2..）
  rm.rows.forEach(r => {
    if (r.kind === 'group') {
      const ph = p.phases.find(x => x.name === r.name) || { color: 'var(--border-strong)' };
      body += `<div class="g-row g-group-row"><div class="g-rnum">${r.row}</div>` +
        `<div class="g-group" style="border-left-color:${ph.color}">${esc(r.name)} · ${p.tasks.filter(t => t.phaseId === ph.id).length}</div>` +
        `<div class="g-track" style="width:${trackW}px"></div></div>`;
      return;
    }
    const t = r.task;
    const s = parseD(t.startDate || p.startDate), due = parseD(t.dueDate || t.startDate || p.startDate);
    const left = dayDiff(isoDate(s), isoDate(min)) * dayW;
    const w = Math.max(dayW, dayDiff(isoDate(due), isoDate(s)) * dayW);
    const ph = p.phases.find(x => x.id === t.phaseId) || { color: '#888' };
    body += `<div class="g-row"><div class="g-rnum">${r.row}</div>` +
      `<div class="g-colA" title="${esc(t.title)}">${t.done ? '✓ ' : ''}${esc(t.title)}</div>` +
      `<div class="g-colB"><input type="date" class="g-date-in g-date-s" data-tid="${t.id}" value="${t.startDate || ''}" ${state.readonly ? 'disabled' : ''}></div>` +
      `<div class="g-colC"><input type="date" class="g-date-in g-date-e" data-tid="${t.id}" value="${t.dueDate || ''}" ${state.readonly ? 'disabled' : ''}></div>` +
      `<div class="g-colD"><input type="number" class="g-days-in" data-tid="${t.id}" value="${t.estimateDays || ''}" min="0" step="1" title="工期（天），修改后结束日期级联更新" ${state.readonly ? 'disabled' : ''}></div>` +
      `<div class="g-track" style="width:${trackW}px;background-image:${bg}">` +
      `<div class="g-bar ${t.done ? 'done' : ''}" style="left:${left}px;width:${w}px;background:${ph.color}" data-tid="${t.id}"><span class="g-bar-txt">${t.estimateDays ? t.estimateDays + 'd' : ''}</span></div></div></div>`;
  });
  wrap.innerHTML = `<div class="gantt">${head}<div class="g-body">${body}</div></div>`;
  $$('.g-bar', wrap).forEach(b => b.onclick = () => { const t = p.tasks.find(x => x.id === b.dataset.tid); if (t) openTaskModal(p, t); });
  $$('.g-date-s', wrap).forEach(inp => {
    inp.onfocus = () => { ganttSel = { tid: inp.dataset.tid, field: 'start' }; ganttRM = rm; syncFormulaBox(p); };
    inp.onchange = e => {
      const t = p.tasks.find(x => x.id === e.target.dataset.tid); if (!t) return;
      const v = e.target.value;
      debounce('ds-' + t.id, async () => {
        try {
          await api('/projects/' + p.id + '/tasks/' + t.id, { method: 'PUT', body: JSON.stringify({ startDate: v }) });
          const np = await api('/projects/' + p.id); Object.assign(p, np); render(); // 级联：后续任务日期同步更新
        } catch (err) { toast(err.message); }
      });
    };
  });
  $$('.g-date-e', wrap).forEach(inp => {
    inp.onfocus = () => { ganttSel = { tid: inp.dataset.tid, field: 'due' }; ganttRM = rm; syncFormulaBox(p); };
    inp.onchange = e => {
      const t = p.tasks.find(x => x.id === e.target.dataset.tid); if (!t) return;
      const v = e.target.value;
      debounce('de-' + t.id, async () => {
        try {
          await api('/projects/' + p.id + '/tasks/' + t.id, { method: 'PUT', body: JSON.stringify({ dueDate: v }) });
          const np = await api('/projects/' + p.id); Object.assign(p, np); render(); // 级联：后续任务日期同步更新
        } catch (err) { toast(err.message); }
      });
    };
  });
  $$('.g-days-in', wrap).forEach(inp => {
    inp.onchange = e => {
      const t = p.tasks.find(x => x.id === e.target.dataset.tid); if (!t) return;
      const v = Math.max(0, parseInt(e.target.value) || 0);
      debounce('gd-' + t.id, async () => {
        try {
          await api('/projects/' + p.id + '/tasks/' + t.id, { method: 'PUT', body: JSON.stringify({ estimateDays: v }) });
          const np = await api('/projects/' + p.id); Object.assign(p, np); render(); // 改工期 → 结束日期按公式级联重算
        } catch (err) { toast(err.message); }
      });
    };
  });
  const fbox = $('#gFormulaBox');
  if (fbox) {
    const applyFormula = async () => {
      if (!ganttSel) { toast('请先点击一个任务的开始或结束日期'); return; }
      const t = p.tasks.find(x => x.id === ganttSel.tid); if (!t) return;
      const key = ganttSel.field === 'start' ? 'startFormula' : 'dueFormula';
      const origF = ganttSel.field === 'start' ? (t.startF || '') : (t.dueF || '');
      const raw = fbox.value.trim();
      // 未修改（等于原表公式原文）→ 原样提交，避免把 xlsx 坐标误当当前坐标转换
      const xlsxF = origF && String(raw).replace(/^=/, '') === String(origF).replace(/^=/, '') ? origF : curToXlsxFormula(raw, p, rm);
      try {
        await api('/projects/' + p.id + '/tasks/' + t.id, { method: 'PUT', body: JSON.stringify({ [key]: xlsxF }) });
        const np = await api('/projects/' + p.id); Object.assign(p, np); render(); // 改公式 → 级联重算
      } catch (err) { toast(err.message); }
    };
    fbox.onchange = () => debounce('gf', applyFormula);
    fbox.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); fbox.blur(); } };
  }
  ganttRM = rm;
  syncFormulaBox(p); // 保持选中态：重绘后重新同步公式框
}

/* ---------- Calendar ---------- */
function renderCalendar(p) {
  const y = state.cal.getFullYear(), mo = state.cal.getMonth();
  const names = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  $('#viewActions').innerHTML = `<button class="btn" id="calPrev">‹</button><span class="cal-title">${y}年 ${names[mo]}</span><button class="btn" id="calNext">›</button>`;
  $('#calPrev').onclick = () => { state.cal = new Date(y, mo - 1, 1); render(); };
  $('#calNext').onclick = () => { state.cal = new Date(y, mo + 1, 1); render(); };
  const byDate = {};
  (p.tasks || []).forEach(t => { if (t.dueDate) (byDate[t.dueDate] = byDate[t.dueDate] || []).push(t); });
  const first = new Date(y, mo, 1), startDow = first.getDay(), daysInMo = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  const prevDays = new Date(y, mo, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) cells.push({ d: prevDays - i, m: 'prev' });
  for (let d = 1; d <= daysInMo; d++) cells.push({ d, m: 'cur' });
  let nx = 1; while (cells.length < 42) cells.push({ d: nx++, m: 'next' });
  const todayKey = isoDate(new Date());
  let grid = '<div class="cal-grid">';
  ['日', '一', '二', '三', '四', '五', '六'].forEach(w => grid += `<div class="cal-dow">${w}</div>`);
  cells.forEach(c => {
    const key = c.m === 'cur' ? `${y}-${String(mo + 1).padStart(2, '0')}-${String(c.d).padStart(2, '0')}` : '';
    const isToday = key && key === todayKey;
    const evs = key ? (byDate[key] || []) : [];
    let evHtml = evs.slice(0, 3).map(t => `<div class="cal-ev" style="background:${phaseColor(p, t)}" data-tid="${t.id}">${t.done ? '✓ ' : ''}${esc(t.title)}</div>`).join('');
    if (evs.length > 3) evHtml += `<div class="cal-more">+${evs.length - 3}</div>`;
    grid += `<div class="cal-cell ${c.m !== 'cur' ? 'muted-cell' : ''} ${isToday ? 'today' : ''}"><div class="cal-day">${c.d}</div>${evHtml}</div>`;
  });
  grid += '</div>';
  $('#calendar').innerHTML = `<div class="calendar">${grid}</div>`;
  $$('.cal-ev', $('#calendar')).forEach(e => e.onclick = ev => { ev.stopPropagation(); const t = p.tasks.find(x => x.id === e.dataset.tid); if (t) openTaskModal(p, t); });
}

/* ---------- project / task modals ---------- */
function openTplModal() {
  const grid = $('#tplGrid'); grid.innerHTML = ''; $('#projName').value = '';
  if (!state.templates.length) {
    grid.innerHTML = '<div class="empty" style="padding:28px">暂无计划模版<br><span style="font-size:12px;color:var(--text-3);line-height:1.8">可使用「从 xlsx 导入」导入母版计划表</span></div>';
    $('#tplModal').classList.remove('hidden');
    return;
  }
  state.templates.forEach(t => {
    const c = document.createElement('div'); c.className = 'tpl-card'; c.style.borderColor = t.color;
    c.innerHTML = `<div class="tpl-ico" style="background:${t.color}">${esc(t.icon || '◆')}</div>
      <div class="tpl-name">${esc(t.name)}</div>
      <div class="tpl-phases">${(t.phases || []).map(p => `<span style="background:${p.color}">${esc(p.name)}</span>`).join('')}</div>`;
    c.onclick = () => { const sug = $('#projName').value.trim() || t.name; pending = { mode: 'tpl', tplId: t.id }; $('#tplModal').classList.add('hidden'); openProjInfo(sug); };
    grid.appendChild(c);
  });
  $('#tplModal').classList.remove('hidden');
}
function openProjInfo(name, existing) {
  $('#piName').value = existing ? existing.name : (name || '');
  const eng = existing && existing.engineers ? existing.engineers : {};
  $('#piHardware').value = eng.hardware && eng.hardware !== '—' ? eng.hardware : '';
  $('#piStructure').value = eng.structure && eng.structure !== '—' ? eng.structure : '';
  $('#piProject').value = eng.project && eng.project !== '—' ? eng.project : '';
  $('#piCert').value = existing ? (existing.cert || '') : '';
  const t = existing ? existing.type : null, l = existing ? existing.level : null, pt = existing ? existing.productType : null;
  $$('#typeOpts .type-opt').forEach(o => o.classList.toggle('active', o.dataset.type === t));
  $$('#levelOpts .level-opt').forEach(o => o.classList.toggle('active', o.dataset.level === l));
  $$('#productTypeOpts .type-opt').forEach(o => o.classList.toggle('active', o.dataset.ptype === pt));
  $('#piTitle').textContent = existing ? '编辑项目信息' : '项目信息';
  $('#piConfirm').textContent = existing ? '保存修改' : '确认创建';
  $('#projInfoModal').classList.remove('hidden'); $('#piName').focus();
}
$$('#typeOpts .type-opt').forEach(o => o.onclick = () => {
  $$('#typeOpts .type-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active');
});
$$('#productTypeOpts .type-opt').forEach(o => o.onclick = () => {
  $$('#productTypeOpts .type-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active');
});
$$('#levelOpts .level-opt').forEach(o => o.onclick = () => {
  $$('#levelOpts .level-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active');
});
$('#piConfirm').onclick = async () => {
  const name = $('#piName').value.trim();
  const typeEl = $('#typeOpts .type-opt.active');
  const type = typeEl ? typeEl.dataset.type : null;
  const levelEl = $('#levelOpts .level-opt.active');
  const level = levelEl ? levelEl.dataset.level : null;
  const ptypeEl = $('#productTypeOpts .type-opt.active');
  const productType = ptypeEl ? ptypeEl.dataset.ptype : null;
  const cert = $('#piCert').value.trim();
  if (!name) { toast('请输入项目名称'); return; }
  if (!type) { toast('请选择项目类型'); return; }
  if (!level) { toast('请选择项目等级'); return; }
  if (!productType) { toast('请选择产品类型'); return; }
  if (!cert) { toast('请填写认证标签'); return; }
  const eng = { hardware: $('#piHardware').value.trim() || '—', structure: $('#piStructure').value.trim() || '—', project: $('#piProject').value.trim() || '—' };
  $('#projInfoModal').classList.add('hidden');
  try {
    if (pending && pending.mode === 'tpl') {
      const np = await api('/projects', { method: 'POST', body: JSON.stringify({ templateId: pending.tplId, name, type, level, productType, cert, engineers: eng }) });
      state.projects.push(np); state.currentId = np.id; render(); toast('已创建：' + np.name);
    } else if (pending && pending.mode === 'import') {
      const np = await api('/projects/' + pending.projId, { method: 'PUT', body: JSON.stringify({ type, level, productType, cert, engineers: eng }) });
      const p = state.projects.find(x => x.id === pending.projId);
      if (p) { p.type = np.type; p.level = np.level; p.productType = np.productType; p.cert = np.cert; p.engineers = np.engineers; }
      render(); toast('已补充信息：' + name);
    } else if (pending && pending.mode === 'edit') {
      const np = await api('/projects/' + pending.projId, { method: 'PUT', body: JSON.stringify({ name, type, level, productType, cert, engineers: eng }) });
      const p = state.projects.find(x => x.id === pending.projId);
      if (p) { p.name = np.name; p.type = np.type; p.level = np.level; p.productType = np.productType; p.cert = np.cert; p.engineers = np.engineers; }
      render(); toast('已更新项目信息：' + np.name);
    }
  } catch (e) { toast(e.message); }
  pending = null;
};

function openTaskModal(p, t) {
  state.editingTaskId = t ? t.id : null;
  $('#taskModalTitle').textContent = t ? '编辑任务' : '新建任务';
  $('#taskTitle').value = t ? t.title : '';
  $('#taskNote').value = t ? t.note : '';
  $('#taskStart').value = t && t.startDate ? t.startDate : '';
  $('#taskDue').value = t && t.dueDate ? t.dueDate : '';
  $('#taskAssignee').value = t ? t.assignee : '';
  $('#taskEst').value = t ? t.estimateDays || '' : '';
  const sel = $('#taskPhase');
  sel.innerHTML = p.phases.map(ph => `<option value="${ph.id}" ${t && t.phaseId === ph.id ? 'selected' : ''}>${esc(ph.name)}</option>`).join('');
  $('#taskModal').classList.remove('hidden'); $('#taskTitle').focus();
}
async function saveTask() {
  const p = proj(); if (!p) return;
  const title = $('#taskTitle').value.trim();
  if (!title) { toast('请输入标题'); return; }
  const body = { title, note: $('#taskNote').value, phaseId: $('#taskPhase').value, assignee: $('#taskAssignee').value.trim(), estimateDays: parseInt($('#taskEst').value) || 0 };
  if ($('#taskStart').value) body.startDate = $('#taskStart').value;
  if ($('#taskDue').value) body.dueDate = $('#taskDue').value;
  try {
    if (state.editingTaskId) {
      await api(`/projects/${p.id}/tasks/${state.editingTaskId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api(`/projects/${p.id}/tasks`, { method: 'POST', body: JSON.stringify(body) });
    }
    const np = await api('/projects/' + p.id); Object.assign(p, np); // 拉取级联重算后的最新项目
    $('#taskModal').classList.add('hidden'); render();
  } catch (e) { toast(e.message); }
}

/* ---------- 导入 / 导出 ---------- */
function updateIOState() {
  const p = proj(); const has = !!p && !state.readonly;
  const eb = $('#exportBtn'); if (eb) eb.disabled = !p;
  const at = $('#addTaskBtn'), dp = $('#delProjectBtn'), ab = $('#archiveBtn');
  if (at) at.disabled = !has;
  if (dp) dp.disabled = !has;
  if (ab) { ab.disabled = !has; if (has) ab.textContent = ((p.status || 'active') === 'archived') ? '↩ 取消归档' : '📦 完成归档'; }
}
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf); let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function exportPlan(type) {
  const p = proj(); if (!p) { toast('请先选择项目'); return; }
  const a = document.createElement('a');
  a.href = `/api/projects/${p.id}/export?type=${type}`;
  document.body.appendChild(a); a.click(); a.remove();
  toast(type === 'initial' ? '正在导出初版计划…' : type === 'diff' ? '正在导出差异对比…' : '正在导出最新计划…');
}
$('#exportBtn').onclick = (e) => { e.stopPropagation(); $('#exportMenu').classList.toggle('open'); };
$$('#exportMenu button').forEach(b => b.onclick = () => { const x = b.dataset.x; $('#exportMenu').classList.remove('open'); exportPlan(x); });
document.addEventListener('click', e => {
  const m = $('#exportMenu'); if (m && !$('#exportBtn').contains(e.target) && !m.contains(e.target)) m.classList.remove('open');
});
$('#importFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const kind = file.name.toLowerCase().endsWith('.json') ? 'json' : 'xlsx';
    let data;
    if (kind === 'json') data = btoa(unescape(encodeURIComponent(await file.text())));
    else data = bufToBase64(await file.arrayBuffer());
    const np = await api('/projects/import', { method: 'POST', body: JSON.stringify({ filename: file.name, kind, data }) });
    state.projects.push(np); state.currentId = np.id;
    pending = { mode: 'import', projId: np.id };
    render();
    $('#importModal').classList.add('hidden');
    openProjInfo(np.name);
  } catch (err) { toast('导入失败: ' + err.message); }
  e.target.value = '';
};

/* ---- 参考模版：由内置模版生成 Excel（开始/截止带公式 → 甘特级联） ---- */
function populateRefTplSelect() {
  const sel = $('#refTplSelect'); if (!sel) return;
  sel.innerHTML = '';
  (state.templates || []).forEach(t => {
    const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o);
  });
}
$('#refTplDownload').onclick = () => {
  const sel = $('#refTplSelect');
  const t = (state.templates || []).find(x => x.id === sel.value) || (state.templates || [])[0];
  if (!t) { toast('暂无内置模版'); return; }
  const a = document.createElement('a');
  a.href = `/api/templates/reference-xlsx?tplId=${encodeURIComponent(t.id)}`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('已下载参考模版：' + t.name + '（开始/截止含公式，填写后导入即可级联）');
};

/* ---------- 事件 ---------- */
$$('.tab').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); });
$('#newProjectBtn').onclick = () => { if (state.readonly) { toast('只读模式，无法新建项目'); return; } $('#newProjectModal').classList.remove('hidden'); };
$('#roBtn').onclick = async () => {
  const target = !state.readonly;
  if (target && !confirm('开启只读模式？开启后任何人都只能查看、无法修改（包括你自己）。分享给同事前请开启。')) return;
  if (!target && !confirm('解除只读模式？解除后所有访客都可以修改数据。')) return;
  try {
    const r = await api('/readonly', { method: 'POST', body: JSON.stringify({ on: target }) });
    state.readonly = !!r.on; render();
    toast(target ? '已开启只读模式' : '已解除只读模式');
  } catch (e) { toast(e.message); }
};
$('#npFromTpl').onclick = () => { $('#newProjectModal').classList.add('hidden'); openTplModal(); };
$('#npFromXlsx').onclick = () => { $('#newProjectModal').classList.add('hidden'); populateRefTplSelect(); $('#importModal').classList.remove('hidden'); };
$('#importPick').onclick = () => $('#importFile').click();
$('#importCancel').onclick = () => $('#importModal').classList.add('hidden');
$('#addTaskBtn').onclick = () => { if (!proj()) { toast('请先创建项目'); return; } openTaskModal(proj(), null); };
$('#taskSave').onclick = saveTask;
$('#delProjectBtn').onclick = async () => {
  const p = proj(); if (!p) return;
  if (!confirm('删除整个项目「' + p.name + '」？此操作不可恢复。')) return;
  try { await api('/projects/' + p.id, { method: 'DELETE' }); state.projects = state.projects.filter(x => x.id !== p.id); state.currentId = state.projects[0] ? state.projects[0].id : null; render(); }
  catch (e) { toast(e.message); }
};
$('#archiveBtn').onclick = async () => {
  const p = proj(); if (!p) return;
  const isArch = (p.status || 'active') === 'archived';
  if (!isArch && !confirm('归档项目「' + p.name + '」？归档后将从进行中统计中移出，可在侧栏「已归档」查看。')) return;
  if (isArch && !confirm('将「' + p.name + '」恢复为进行中项目？')) return;
  try {
    const np = await api('/projects/' + p.id, { method: 'PUT', body: JSON.stringify(isArch ? { status: 'active', completedAt: null } : { status: 'archived', completedAt: TODAY() }) });
    Object.assign(p, np); render(); toast(isArch ? '已恢复进行中' : '已完成归档');
  } catch (e) { toast(e.message); }
};
$$('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.add('hidden'));
$$('.modal').forEach(m => m.onclick = e => { if (e.target === m) m.classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.add('hidden')); });

/* =========================================================
   AI 助手 + 移动端抽屉 + 模板共创
   ========================================================= */
const PHASE_OPTIONS = ['需求立项', '设计开发', '打样试制', '测试验证', '量产导入', '上市运营'];
let aiTasks = null;

/* ---- 移动端抽屉 ---- */
function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.remove('hidden'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); }
$('#menuBtn').onclick = openSidebar;
$('#scrim').onclick = closeSidebar;
$$('.tab').forEach(b => { const o = b.onclick; b.onclick = () => { o && o(); closeSidebar(); }; });

/* ---- AI 助手：生成任务清单 ---- */
async function loadAiConfig() {
  try { const c = await api('/ai/config'); $('#aiGenNote').textContent = c.configured ? ('已接入：' + (c.model || '')) : '未配置 AI Key：将使用内置模板智能建议'; return c; }
  catch (e) { return null; }
}
function openAiModal() { $('#aiModal').classList.remove('hidden'); $('#aiPreview').innerHTML = ''; $('#aiCreateRow').style.display = 'none'; $('#aiGenNote').textContent = ''; loadAiConfig(); $('#aiDesc').focus(); }
$('#aiBtn').onclick = openAiModal;
async function aiGenerate() {
  const desc = $('#aiDesc').value.trim();
  if (!desc) { toast('请先描述你的项目'); return; }
  const btn = $('#aiGenBtn'); btn.disabled = true; const old = btn.textContent; btn.textContent = '生成中…';
  try {
    const r = await api('/ai/generate-tasks', { method: 'POST', body: JSON.stringify({ description: desc }) });
    aiTasks = (r.tasks || []).map(t => ({ title: String(t.title || ''), phase: String(t.phase || ''), estimateDays: Number(t.estimateDays) || 3, assignee: String(t.assignee || '') }));
    $('#aiGenNote').textContent = r.note || (r.source === 'ai' ? '由大模型生成' : '');
    renderAiPreview(aiTasks);
    $('#aiCreateRow').style.display = 'flex';
    $('#aiProjName').value = desc.slice(0, 24) || 'AI 生成项目';
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}
function renderAiPreview(tasks) {
  const box = $('#aiPreview'); box.innerHTML = '';
  if (!tasks.length) { box.innerHTML = '<div class="ai-empty">未生成任务，换个描述试试。</div>'; return; }
  tasks.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'ai-row';
    row.innerHTML = `<span class="ar-seq">${i + 1}</span>
      <input class="ar-title" value="${esc(t.title)}" data-i="${i}">
      <select class="ar-phase" data-i="${i}">${PHASE_OPTIONS.map(o => `<option ${o === t.phase ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
      <input class="ar-days" type="number" min="0" value="${t.estimateDays}" data-i="${i}">`;
    box.appendChild(row);
  });
  box.querySelectorAll('.ar-title').forEach(el => el.oninput = () => { aiTasks[el.dataset.i].title = el.value; });
  box.querySelectorAll('.ar-phase').forEach(el => el.onchange = () => { aiTasks[el.dataset.i].phase = el.value; });
  box.querySelectorAll('.ar-days').forEach(el => el.oninput = () => { aiTasks[el.dataset.i].estimateDays = Number(el.value) || 0; });
}
async function aiCreate() {
  if (!aiTasks || !aiTasks.length) { toast('先生成任务清单'); return; }
  const name = ($('#aiProjName').value || 'AI 生成项目').trim();
  const order = [], map = {};
  aiTasks.forEach(t => { const ph = t.phase || PHASE_OPTIONS[0]; if (!map[ph]) { map[ph] = 'p' + (order.length + 1); order.push({ id: map[ph], name: ph, color: PHASE_COLORS[order.length % PHASE_COLORS.length] }); } });
  const phases = order.length ? order : [{ id: 'p1', name: PHASE_OPTIONS[0], color: PHASE_COLORS[0] }];
  const tasks = aiTasks.map(t => ({ title: t.title || '未命名', phaseId: map[t.phase || PHASE_OPTIONS[0]] || phases[0].id, estimateDays: t.estimateDays || 0, assignee: t.assignee || '' }));
  try {
    const np = await api('/projects', { method: 'POST', body: JSON.stringify({ name, phases, tasks, type: 'C端', level: 'B' }) });
    state.projects.push(np); state.currentId = np.id; $('#aiModal').classList.add('hidden'); aiTasks = null;
    toast('项目已创建：' + np.name); render();
  } catch (e) { toast(e.message); }
}
$('#aiGenBtn').onclick = aiGenerate;
$('#aiCreateBtn').onclick = aiCreate;

/* ---- AI 设置 ---- */
async function openAiSettings() {
  $('#aiSettingsModal').classList.remove('hidden');
  try { const c = await api('/ai/config'); $('#aiBase').value = c.base_url || ''; $('#aiModel').value = c.model || ''; $('#aiKey').value = ''; $('#aiSettingsMsg').textContent = c.configured ? '当前已配置 Key' : '尚未配置 Key'; }
  catch (e) { $('#aiSettingsMsg').textContent = ''; }
}
$('#aiSettingsOpen').onclick = openAiSettings;
$('#aiSaveBtn').onclick = async () => {
  try {
    const r = await api('/ai/config', { method: 'POST', body: JSON.stringify({ base_url: $('#aiBase').value, model: $('#aiModel').value, api_key: $('#aiKey').value }) });
    $('#aiSettingsMsg').textContent = r.configured ? '已保存（Key 已写入本机 data/ai.json）' : '已保存（未填 Key，将走模板规则兜底）';
    toast('AI 设置已保存');
  } catch (e) { $('#aiSettingsMsg').textContent = '保存失败：' + e.message; }
};

/* ---- AI 项目总结 ---- */
async function aiSummarize() {
  const p = proj(); if (!p) { toast('请先选择项目'); return; }
  const m = $('#aiSummaryModal'); const ta = $('#aiSummaryText');
  m.classList.remove('hidden'); ta.value = '生成中…';
  try { const r = await api('/ai/summarize', { method: 'POST', body: JSON.stringify({ project: p }) }); ta.value = r.text || ''; }
  catch (e) { ta.value = '生成失败：' + e.message; }
}
$('#aiSummaryClose').onclick = () => $('#aiSummaryModal').classList.add('hidden');
$('#aiSummaryCopy').onclick = () => { const ta = $('#aiSummaryText'); ta.select(); try { document.execCommand('copy'); } catch (e) {} toast('已复制'); };

/* ---- 模板共创：导出参考模版（Excel）/ 导入社区模板 ---- */
$('#tplExportBtn').onclick = () => {
  const t = (state.templates || [])[0];
  if (!t) { toast('暂无内置模版'); return; }
  const a = document.createElement('a');
  a.href = `/api/templates/reference-xlsx?tplId=${encodeURIComponent(t.id)}`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('已导出参考模版：' + t.name + '（Excel，含日期公式，填写后可从 xlsx 导入）');
};
$('#tplImportBtn').onclick = () => $('#tplImportFile').click();
$('#tplImportFile').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    let r;
    if (/\.xlsx?$/i.test(f.name)) {
      // 导入参考模版 Excel：取文件名作模板名，阶段作展示字段
      const data = bufToBase64(await f.arrayBuffer());
      r = await api('/templates/import', { method: 'POST', body: JSON.stringify({ kind: 'xlsx', filename: f.name, data }) });
      toast('已导入参考模版：' + (r.templates || []).map(t => t.name).join('、') || f.name);
    } else {
      const list = JSON.parse(await f.text());
      const arr = Array.isArray(list) ? list : (list.templates || []);
      r = await api('/templates/import', { method: 'POST', body: JSON.stringify({ templates: arr }) });
      toast('已导入 ' + r.added + ' 个新模板');
    }
    state.templates = await api('/templates');
    openTplModal();
  } catch (err) { toast('导入失败：' + err.message); }
  finally { e.target.value = ''; }
};

/* =========================================================
   全景视图（聚合所有项目）
   ========================================================= */
function allPhases() {
  const map = new Map();
  state.projects.forEach(p => (p.phases || []).forEach(ph => { if (!map.has(ph.id)) map.set(ph.id, ph); }));
  return [...map.values()];
}
function projStats(p) {
  const tasks = p.tasks || [];
  const total = tasks.length, done = tasks.filter(t => t.done).length;
  const progress = total ? Math.round(done / total * 100) : 0;
  const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < TODAY()).length;
  let status, scolor;
  if (overdue > 0) { status = '风险'; scolor = '#FF453A'; }
  else if (progress >= 70) { status = '正常'; scolor = '#30D158'; }
  else { status = '关注'; scolor = '#FF9F0A'; }
  let phaseName = '—', phaseColor = '#8E8E93';
  const cur = (p.phases || []).find(ph => tasks.some(t => t.phaseId === ph.id && !t.done));
  if (cur) { phaseName = cur.name; phaseColor = cur.color; }
  else if ((p.phases || []).length) { phaseName = '已完成'; phaseColor = '#30D158'; }
  return { total, done, progress, overdue, status, scolor, phaseName, phaseColor };
}
function donutSVG(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = 46, sw = 16, C = 2 * Math.PI * r, gap = C * 0.02; let off = 0; let paths = '';
  paths += `<circle cx="62" cy="62" r="${r}" fill="none" stroke="var(--bg-2)" stroke-width="${sw}"/>`;
  segments.forEach(s => {
    const full = s.value / total * C; const len = Math.max(0, full - gap);
    if (len > 0) paths += `<circle cx="62" cy="62" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 62 62)"/>`;
    off += full;
  });
  return `<svg viewBox="0 0 124 124" class="donut">${paths}<text x="62" y="60" text-anchor="middle" class="donut-c">${total}</text><text x="62" y="75" text-anchor="middle" class="donut-t">个项目</text></svg>`;
}
function renderPanorama() {
  const active = state.projects.filter(p => (p.status || 'active') !== 'archived');
  const archived = state.projects.filter(p => (p.status || 'active') === 'archived');
  let totDone = 0, totTasks = 0, overdue = 0, weekMs = 0;
  active.forEach(p => {
    const s = projStats(p); totDone += s.done; totTasks += s.total; overdue += s.overdue;
    (p.tasks || []).forEach(t => { if (t.isMilestone && t.dueDate) { const dd = dayDiff(t.dueDate, TODAY()); if (dd >= 0 && dd <= 7) weekMs++; } });
  });
  const prog = totTasks ? Math.round(totDone / totTasks * 100) : (archived.length ? 100 : 0);
  $('#panorama').innerHTML = `
    <div class="pano-hero">
      <div class="eyebrow">Overview</div>
      <h1 class="pano-title">项目全景</h1>
      <p class="pano-sub">多项目组合视图 · 进行中进度与已完成归档数据分析</p>
    </div>
    <div class="pano-kpis">
      <div class="kpi"><div class="kpi-l">整体进度</div><div class="kpi-v ${prog >= 70 ? 'good' : ''}">${prog}%</div></div>
      <div class="kpi"><div class="kpi-l">进行中项目</div><div class="kpi-v">${active.length}</div></div>
      <div class="kpi"><div class="kpi-l">已归档项目</div><div class="kpi-v">${archived.length}</div></div>
      <div class="kpi"><div class="kpi-l">逾期节点</div><div class="kpi-v ${overdue ? 'warn' : 'good'}">${overdue}</div></div>
      <div class="kpi"><div class="kpi-l">本周里程碑</div><div class="kpi-v">${weekMs}</div></div>
    </div>
    <div class="pano-grid">
      <div class="ptile span2" data-tile="pipe">
        <h4>阶段管道分布 <span class="ted">进行中项目 · 各 NPI 阶段任务量（绿=已完成 / 灰=未完）</span></h4>
        <div id="pipeBox"></div>
      </div>
      <div class="ptile" data-tile="donut">
        <h4>项目类型分布</h4>
        <div class="donut-wrap"><div id="donutBox"></div><div class="legend" id="typeLegend"></div></div>
      </div>
      <div class="ptile" data-tile="level">
        <h4>项目等级分布</h4>
        <div class="donut-wrap"><div id="levelDonutBox"></div><div class="legend" id="levelLegend"></div></div>
      </div>
      <div class="ptile" data-tile="load">
        <h4>工程师负载 <span class="ted">进行中项目负责数量</span></h4>
        <div id="loadBox"></div>
      </div>
      <div class="ptile span2" data-tile="archive">
        <h4>已完成项目统计 <span class="ted">归档项目 · 等级分布与项目周期</span></h4>
        <div id="archiveBox"></div>
      </div>
      <div class="ptile span2" data-tile="health">
        <h4>项目健康总览 <span class="ted">进行中项目 · 进度与状态（按风险排序）</span></h4>
        <div id="healthBox" class="health"></div>
      </div>
    </div>`;
  renderPipe(); renderDonut(); renderLevelDonut(); renderLoad(); renderArchive(); renderHealth();
  initResize();
}
function renderPipe() {
  const box = $('#pipeBox'); box.innerHTML = '';
  const active = state.projects.filter(p => (p.status || 'active') !== 'archived');
  allPhases().forEach(ph => {
    let tot = 0, done = 0;
    active.forEach(p => (p.tasks || []).forEach(t => { if (t.phaseId === ph.id) { tot++; if (t.done) done++; } }));
    if (!tot) return;
    const pct = Math.round(done / tot * 100);
    const row = document.createElement('div'); row.className = 'pipe-row';
    row.innerHTML = `<div class="pipe-name">${esc(ph.name)}</div>
      <div class="pipe-track"><div class="pipe-fill" style="width:${pct}%;background:${ph.color}"></div></div>
      <div class="pipe-num">${done}/${tot}</div>`;
    box.appendChild(row);
  });
}
function renderDonut() {
  const total = state.projects.length;
  const counts = {}; state.projects.forEach(p => counts[p.type] = (counts[p.type] || 0) + 1);
  const segs = Object.keys(TYPE_COLORS).filter(t => counts[t]).map(t => ({ label: t, value: counts[t] || 0, color: TYPE_COLORS[t] }));
  $('#donutBox').innerHTML = donutSVG(segs.length ? segs : [{ label: '—', value: 1, color: '#bbb' }]);
  $('#typeLegend').innerHTML = segs.map(s => `<div class="legend-row"><i style="background:${s.color}"></i><span class="lname">${s.label}</span><span class="lval">${s.value} 个 · ${Math.round(s.value / total * 100)}%</span></div>`).join('') || '<div class="empty">暂无数据</div>';
}
function renderLevelDonut() {
  const total = state.projects.length;
  const counts = {}; state.projects.forEach(p => counts[p.level || 'B'] = (counts[p.level || 'B'] || 0) + 1);
  const order = ['S', 'A', 'B', 'C', 'D', 'E', 'F'];
  const segs = order.filter(l => counts[l]).map(l => ({ label: l + '级', value: counts[l], color: LEVEL_COLORS[l] || '#8E8E93' }));
  $('#levelDonutBox').innerHTML = donutSVG(segs.length ? segs : [{ label: '—', value: 1, color: '#bbb' }]);
  $('#levelLegend').innerHTML = segs.map(s => `<div class="legend-row"><i style="background:${s.color}"></i><span class="lname">${s.label}</span><span class="lval">${s.value} 个 · ${Math.round(s.value / total * 100)}%</span></div>`).join('') || '<div class="empty">暂无数据</div>';
}
function renderLoad() {
  const counts = {};
  state.projects.filter(p => (p.status || 'active') !== 'archived').forEach(p => {
    const set = new Set([(p.engineers || {}).hardware, (p.engineers || {}).structure, (p.engineers || {}).project].filter(Boolean));
    set.forEach(name => { if (name && name !== '—') counts[name] = (counts[name] || 0) + 1; });
  });
  const palette = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#64D2FF', '#FF453A', '#FFD60A', '#5E5CE6'];
  const rows = Object.keys(counts).map(name => ({ name, v: counts[name] })).sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...rows.map(r => r.v));
  $('#loadBox').innerHTML = rows.map((r, i) => {
    const c = palette[i % palette.length]; const ini = r.name.slice(0, 1);
    return `<div class="load-row"><div class="load-ava" style="background:${c}">${esc(ini)}</div><div class="load-name">${esc(r.name)}</div><div class="load-track"><div class="load-fill" style="width:${Math.round(r.v / max * 100)}%;background:linear-gradient(90deg,${c}cc,${c})"></div></div><div class="load-num">${r.v}</div></div>`;
  }).join('') || '<div class="empty">暂无负载数据</div>';
}
function renderArchive() {
  const box = $('#archiveBox'); if (!box) return;
  const archived = state.projects.filter(p => (p.status || 'active') === 'archived');
  if (!archived.length) { box.innerHTML = '<div class="empty">暂无已归档项目。<br>项目完成后点右上角「📦 完成归档」。</div>'; return; }
  const lvCounts = {}; let totalDays = 0, valid = 0;
  const items = archived.map(p => {
    const start = (p.startDate || (p.createdAt || '').slice(0, 10));
    const end = p.completedAt;
    let days = null;
    if (start && end) { days = dayDiff(end, start); if (days >= 0) { totalDays += days; valid++; } }
    lvCounts[p.level || 'B'] = (lvCounts[p.level || 'B'] || 0) + 1;
    return { p, days };
  });
  const avg = valid ? Math.round(totalDays / valid) : null;
  const order = ['S', 'A', 'B', 'C', 'D', 'E', 'F'];
  const maxC = Math.max(1, ...Object.values(lvCounts));
  const bars = order.map(lv => {
    const v = lvCounts[lv] || 0;
    const color = LEVEL_COLORS[lv] || '#8E8E93';
    return `<div class="pipe-row"><div class="pipe-name" style="width:34px">${lv} 级</div>
      <div class="pipe-track"><div class="pipe-fill" style="width:${Math.round(v / maxC * 100)}%;background:${color}"></div></div>
      <div class="pipe-num">${v}</div></div>`;
  }).join('');
  const listHtml = items.map(({ p, days }) => {
    const lc = LEVEL_COLORS[p.level] || '#8E8E93';
    return `<div class="arch-item"><span class="level-pill" style="background:${lc}">${p.level || 'B'}</span><span class="an">${esc(p.name)}</span><span class="ad">${p.completedAt || '—'}${days !== null ? ' · ' + days + '天' : ''}</span></div>`;
  }).join('');
  box.innerHTML = `<div class="arch-wrap">
    <div class="arch-left">
      <div class="arch-stat-row">共 <b>${archived.length}</b> 个已完成项目 · 平均周期 <b>${avg === null ? '—' : avg + ' 天'}</b></div>
      <div>${bars}</div>
    </div>
    <div class="arch-right">${listHtml}</div>
  </div>`;
}
function renderHealth() {
  const box = $('#healthBox'); box.innerHTML = '';
  const order = { '风险': 0, '关注': 1, '正常': 2 };
  const list = state.projects.filter(p => (p.status || 'active') !== 'archived').sort((a, b) => order[projStats(a).status] - order[projStats(b).status]);
  list.forEach(p => {
    const s = projStats(p); const c = TYPE_COLORS[p.type] || '#888';
    const row = document.createElement('div'); row.className = 'hrow';
    row.innerHTML = `<div class="hname"><span class="hdot" style="background:${p.color}"></span><span class="hn">${esc(p.name)}</span><span class="hp" style="background:${c}">${p.type || ''}</span></div>
      <div class="hphase"><span class="hphase-tag" style="background:${s.phaseColor}22;color:${s.phaseColor}">${esc(s.phaseName)}</span></div>
      <div class="htrack"><div class="hfill" style="width:${s.progress}%;background:${s.scolor}"></div></div>
      <div class="hmeta"><span class="hpval">${s.progress}%</span><span class="hbadge" style="background:${s.scolor}22;color:${s.scolor}"><span class="bdot" style="background:${s.scolor}"></span>${s.status}${s.overdue ? ` · 逾期${s.overdue}` : ''}</span></div>`;
    box.appendChild(row);
  });
}

/* ---------- 全景图块手动调整大小 ---------- */
function loadLayout() { try { return JSON.parse(localStorage.getItem('panoLayout') || '{}'); } catch (e) { return {}; } }
function saveLayout(l) { try { localStorage.setItem('panoLayout', JSON.stringify(l)); } catch (e) {} }
function applyTileLayout(tile, id) {
  const s = loadLayout()[id]; if (!s) return;
  if (!tile.classList.contains('span2') && s.w) { tile.style.flexGrow = '0'; tile.style.flexShrink = '0'; tile.style.flexBasis = s.w + 'px'; }
  if (s.h) tile.style.minHeight = s.h + 'px';
}
function initResize() {
  const grid = $('#panorama .pano-grid'); if (!grid) return;
  $$('.ptile', grid).forEach(tile => {
    const id = tile.dataset.tile;
    applyTileLayout(tile, id);
    const handle = document.createElement('div'); handle.className = 'tile-resize'; handle.title = '拖动调整大小';
    tile.appendChild(handle);
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const rect = tile.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY, startW = rect.width, startH = rect.height;
      handle.setPointerCapture(e.pointerId);
      const isSpan = tile.classList.contains('span2');
      const move = ev => {
        const dh = ev.clientY - startY;
        const h = Math.max(120, startH + dh);
        tile.style.minHeight = h + 'px';
        if (!isSpan) {
          let w = Math.max(280, startW + (ev.clientX - startX));
          w = Math.min(w, grid.clientWidth);
          tile.style.flexGrow = '0'; tile.style.flexShrink = '0'; tile.style.flexBasis = w + 'px';
        }
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        const l = loadLayout();
        const h = parseInt(tile.style.minHeight) || startH;
        if (isSpan) l[id] = { h };
        else { const w = parseInt(tile.style.flexBasis) || startW; l[id] = { w, h }; }
        saveLayout(l);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  });
}

/* =========================================================
   日报 / 周报实时展示页（阶段泳道图）
   ========================================================= */
const WD = ['日', '一', '二', '三', '四', '五', '六'];
function fmtCN(d) { return isoDate(d) + ' 周' + WD[d.getDay()]; }
function weekRange(d) {
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const mon = new Date(day); mon.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const days = []; for (let i = 0; i < 7; i++) { const x = new Date(mon); x.setDate(mon.getDate() + i); days.push(x); }
  return { mon, days };
}
function activeProjects() { return state.projects.filter(p => (p.status || 'active') !== 'archived'); }
function allPhaseUnion() {
  const map = new Map();
  state.projects.forEach(p => (p.phases || []).forEach(ph => { if (!map.has(ph.id)) map.set(ph.id, ph); }));
  return [...map.values()];
}
function currentPhaseOf(p) {
  const tasks = p.tasks || [];
  return (p.phases || []).find(ph => tasks.some(t => t.phaseId === ph.id && !t.done)) || null;
}
function renderReport() {
  const wrap = $('#report'); wrap.innerHTML = '';
  if (proj()) { $('#viewActions').innerHTML = `<button class="btn" id="aiSummaryBtn">${ICON.spark} AI 总结</button>`; const b = $('#aiSummaryBtn'); if (b) b.onclick = aiSummarize; }
  else $('#viewActions').innerHTML = '';
  if (state.view === 'daily') buildDaily(wrap);
  else buildWeekly(wrap);
}
function buildPhaseSwim(box, mode) {
  const phases = allPhaseUnion();
  let projs = activeProjects();
  const refD = isoDate(state.dailyDate);
  const wk = weekRange(state.weekDate), mI = isoDate(wk.mon), sI = isoDate(wk.days[6]);
  const phaseIdx = {}; phases.forEach((ph, i) => phaseIdx[ph.id] = i);
  projs = projs.sort((a, b) => {
    const ca = currentPhaseOf(a), cb = currentPhaseOf(b);
    return ((ca ? phaseIdx[ca.id] : phases.length)) - ((cb ? phaseIdx[cb.id] : phases.length));
  });
  let head = '<div class="sw-head"><div class="sw-track-h">';
  phases.forEach(ph => {
    const n = projs.reduce((a, p) => a + (p.tasks || []).filter(t => t.phaseId === ph.id).length, 0);
    head += `<div class="sw-colh">${esc(ph.name)}<i>共 ${n} 任务</i></div>`;
  });
  const doneN = projs.filter(p => !currentPhaseOf(p)).length;
  head += `<div class="sw-colh">已完成<i>${doneN} 项目</i></div></div></div>`;
  let rows = '';
  projs.forEach(p => {
    const cur = currentPhaseOf(p);
    let cells = '';
    phases.forEach(ph => {
      const phTasks = (p.tasks || []).filter(t => t.phaseId === ph.id);
      const doneCnt = phTasks.filter(t => t.done).length;
      if (cur && cur.id === ph.id) {
        let sub = `${doneCnt}/${phTasks.length}`;
        let n = 0;
        if (mode === 'daily') n = phTasks.filter(t => t.dueDate === refD || (!t.done && t.startDate && t.startDate <= refD && (!t.dueDate || t.dueDate >= refD))).length;
        else n = phTasks.filter(t => t.dueDate && t.dueDate >= mI && t.dueDate <= sI).length;
        if (n) sub += ` · ${mode === 'daily' ? '今日' : '本周'} ${n}`;
        if (phTasks.some(t => t.isMilestone)) sub += ' · ⚑';
        cells += `<div class="sw-col"><div class="sw-pos" style="background:${ph.color}"><b>${esc(p.name)}</b><small>${sub}</small></div></div>`;
      } else {
        const prog = phTasks.length ? Math.round(doneCnt / phTasks.length * 100) : 0;
        cells += `<div class="sw-col"><div class="sw-cell">${prog ? `<i class="sw-prog" style="width:${prog}%"></i>` : ''}</div></div>`;
      }
    });
    const doneCell = cur ? '<div class="sw-col"><div class="sw-cell"></div></div>'
      : `<div class="sw-col"><div class="sw-pos done" style="background:var(--accent)"><b>${esc(p.name)}</b><small>已完成 ${p.tasks.filter(t => t.done).length}/${p.tasks.length}</small></div></div>`;
    rows += `<div class="sw-row"><div class="sw-grid">${cells}${doneCell}</div></div>`;
  });
  box.innerHTML = `<div class="swim">${head}${rows}</div>`;
}
function buildDaily(wrap) {
  const d = state.dailyDate, dIso = isoDate(d);
  const projs = activeProjects();
  let due = 0, doneT = 0, over = 0, activeN = 0;
  projs.forEach(p => {
    if ((p.tasks || []).length) activeN++;
    (p.tasks || []).forEach(t => {
      if (t.dueDate === dIso) due++;
      if (t.done && t.dueDate === dIso) doneT++;
      if (!t.done && t.dueDate && t.dueDate < dIso) over++;
    });
  });
  wrap.innerHTML = `
    <div class="report-hero">
      <div class="eyebrow">Daily Report</div>
      <h1 class="pano-title">项目日报</h1>
      <div class="report-tools">
        <p class="pano-sub">横轴 = NPI 阶段 · 色块 = 各项目当前所处阶段（按阶段排序，含今日明细）</p>
        <div class="date-nav">
          <button class="btn" id="dpPrev">‹</button>
          <span class="cal-title" id="dpLabel">${fmtCN(d)}</span>
          <button class="btn" id="dpNext">›</button>
          <button class="btn" id="dpToday">今天</button>
        </div>
      </div>
    </div>
    <div class="pano-kpis">
      <div class="kpi"><div class="kpi-l">今日任务</div><div class="kpi-v">${due}</div></div>
      <div class="kpi"><div class="kpi-l">今日完成</div><div class="kpi-v good">${doneT}</div></div>
      <div class="kpi"><div class="kpi-l">逾期未完成</div><div class="kpi-v ${over ? 'warn' : ''}">${over}</div></div>
      <div class="kpi"><div class="kpi-l">进行中项目</div><div class="kpi-v">${activeN}</div></div>
    </div>
    <div class="report-wrap">
      <div class="ptile span2" style="padding:20px 22px">
        <h4>阶段泳道图 <span class="ted">各项目当前所处阶段 · 色块内含阶段进度 / 今日任务数 / 里程碑</span></h4>
        <div id="swimBox"></div>
        <div class="sw-legend">
          <span><i style="background:#0a84ff"></i>当前阶段色块（按阶段着色）</span>
          <span><i style="background:var(--accent)"></i>已完成项目</span>
          <span>⚑ 里程碑</span>
        </div>
      </div>
    </div>`;
  $('#dpPrev').onclick = () => { const x = new Date(state.dailyDate); x.setDate(x.getDate() - 1); state.dailyDate = x; renderReport(); };
  $('#dpNext').onclick = () => { const x = new Date(state.dailyDate); x.setDate(x.getDate() + 1); state.dailyDate = x; renderReport(); };
  $('#dpToday').onclick = () => { state.dailyDate = new Date(); renderReport(); };
  buildPhaseSwim($('#swimBox'), 'daily');
}
function buildWeekly(wrap) {
  const { mon, days } = weekRange(state.weekDate);
  const monIso = isoDate(mon), sunIso = isoDate(days[6]);
  const projs = activeProjects();
  let wkTotal = 0, wkDone = 0, wkMs = 0;
  projs.forEach(p => (p.tasks || []).forEach(t => {
    if (t.dueDate && t.dueDate >= monIso && t.dueDate <= sunIso) { wkTotal++; if (t.done) wkDone++; if (t.isMilestone) wkMs++; }
  }));
  // 待完成项目清单：本周内未完成的任务（与本周有交集），按项目分组、逾期优先
  const fmtMD = s => s ? s.slice(5).replace('-', '/') : '';
  const todoRows = [];
  projs.forEach(p => {
    const list = (p.tasks || []).filter(t => {
      if (t.done) return false;
      const s = t.startDate ? parseD(t.startDate) : null;
      const d = t.dueDate ? parseD(t.dueDate) : null;
      return (!s || s <= days[6]) && (!d || d >= mon);
    }).map(t => ({ ...t, overdue: t.dueDate && t.dueDate < monIso }));
    if (list.length) todoRows.push({ p, list });
  });
  todoRows.sort((a, b) => (b.list.filter(t => t.overdue).length - a.list.filter(t => t.overdue).length) || a.p.name.localeCompare(b.p.name, 'zh'));
  const todoTotal = todoRows.reduce((a, r) => a + r.list.length, 0);
  const todoOverdue = todoRows.reduce((a, r) => a + r.list.filter(t => t.overdue).length, 0);
  const todoHtml = todoRows.length ? todoRows.map(({ p, list }) => `
      <div class="todo-proj">
        <div class="todo-proj-h"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}<span class="todo-cnt">${list.length}</span></div>
        ${list.map(t => `<div class="todo-t"><span class="todo-chk">□</span>${esc(t.title)}${t.isMilestone ? ' <span class="todo-ms">⚑</span>' : ''}${t.estimateDays ? `<span class="todo-days">${t.estimateDays}天</span>` : ''}<span class="todo-date">${fmtMD(t.startDate)} ~ ${fmtMD(t.dueDate)}${t.overdue ? ' <b class="todo-warn">⚠逾期</b>' : ''}</span></div>`).join('')}
      </div>`).join('') : '<div class="todo-empty">🎉 本周没有待完成任务</div>';
  wrap.innerHTML = `
    <div class="report-hero">
      <div class="eyebrow">Weekly Report</div>
      <h1 class="pano-title">项目周报</h1>
      <div class="report-tools">
        <p class="pano-sub">横轴 = NPI 阶段 · 色块 = 各项目当前所处阶段（按阶段排序，含本周明细）</p>
        <div class="date-nav">
          <button class="btn" id="wpPrev">‹</button>
          <span class="cal-title" id="wpLabel">${mon.getMonth() + 1}/${mon.getDate()} — ${days[6].getMonth() + 1}/${days[6].getDate()} 周</span>
          <button class="btn" id="wpNext">›</button>
          <button class="btn" id="wpThis">本周</button>
        </div>
      </div>
    </div>
    <div class="pano-kpis">
      <div class="kpi"><div class="kpi-l">本周任务</div><div class="kpi-v">${wkTotal}</div></div>
      <div class="kpi"><div class="kpi-l">本周完成</div><div class="kpi-v good">${wkDone}</div></div>
      <div class="kpi"><div class="kpi-l">本周里程碑</div><div class="kpi-v">${wkMs}</div></div>
      <div class="kpi"><div class="kpi-l">涉及项目</div><div class="kpi-v">${projs.length}</div></div>
    </div>
    <div class="report-wrap">
      <div class="ptile span2" style="padding:20px 22px">
        <h4>阶段泳道图 <span class="ted">各项目当前所处阶段 · 色块内含阶段进度 / 本周任务数 / 里程碑</span></h4>
        <div id="swimBox"></div>
        <div class="sw-legend">
          <span><i style="background:#0a84ff"></i>当前阶段色块（按阶段着色）</span>
          <span><i style="background:var(--accent)"></i>已完成项目</span>
          <span>⚑ 里程碑</span>
        </div>
      </div>
      <div class="ptile span2" style="padding:20px 22px">
        <h4>待完成项目清单 <span class="ted">本周内未完成的任务 · 按项目分组 · 逾期优先</span></h4>
        <div class="todo-list">
          <div class="todo-kpis"><span>涉及项目 <b>${todoRows.length}</b></span><span>本周待完成 <b>${todoTotal}</b></span><span class="todo-warn">已逾期 <b>${todoOverdue}</b></span></div>
          ${todoHtml}
        </div>
      </div>
    </div>`;
  $('#wpPrev').onclick = () => { const x = new Date(state.weekDate); x.setDate(x.getDate() - 7); state.weekDate = x; renderReport(); };
  $('#wpNext').onclick = () => { const x = new Date(state.weekDate); x.setDate(x.getDate() + 7); state.weekDate = x; renderReport(); };
  $('#wpThis').onclick = () => { state.weekDate = new Date(); renderReport(); };
  buildPhaseSwim($('#swimBox'), 'weekly');
}

/* ---------- 月度计划：本月内「试产发布」的项目 + 勾选纳入计划 ---------- */
function renderMonthly() {
  if (proj()) { $('#viewActions').innerHTML = `<button class="btn" id="aiSummaryBtn">${ICON.spark} AI 总结</button>`; const b = $('#aiSummaryBtn'); if (b) b.onclick = aiSummarize; }
  else $('#viewActions').innerHTML = '';
  const y = state.monthlyDate.getFullYear(), mo = state.monthlyDate.getMonth();
  const moIso = y + '-' + String(mo + 1).padStart(2, '0');
  const moFirst = isoDate(new Date(y, mo, 1)), moEnd = isoDate(new Date(y, mo + 1, 0));
  const today = isoDate(new Date());
  const names = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const wrap = $('#monthly');
  const projs = activeProjects();
  // 只统计本月内「试产发布」的项目：达成率 = 已完成试产发布 / 本月计划试产发布
  const rows = [];
  projs.forEach(p => {
    const sp = (p.tasks || []).find(t => t.title.includes('试产发布'));
    if (!sp) return;
    const inMonth = (!sp.startDate || sp.startDate <= moEnd) && (!sp.dueDate || sp.dueDate >= moFirst);
    if (!inMonth) return;
    const done = !!sp.done;
    const overdue = !done && sp.dueDate && sp.dueDate < today;
    rows.push({ p, sp, done, overdue });
  });
  rows.sort((a, b) => a.p.name.localeCompare(b.p.name, 'zh'));
  const key = 'kb-monthly-' + moIso;
  let checked = []; try { checked = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
  if (!checked.length) checked = rows.map(r => r.p.id); // 默认全选
  const doneCnt = rows.filter(r => r.done).length;
  const rate = rows.length ? Math.round(doneCnt / rows.length * 100) : 0;
  const totOverdue = rows.filter(r => r.overdue).length;
  const fmt = s => s ? s.slice(5).replace('-', '/') : '';
  const cardHtml = rows.map(({ p, sp, done, overdue }) => {
    const on = checked.includes(p.id);
    const badge = done ? '<span class="mp-badge ok">已完成</span>'
      : overdue ? '<span class="mp-badge">已延期</span>'
      : sp.startDate && sp.startDate <= today ? '<span class="mp-badge go">进行中</span>'
      : '<span class="mp-badge wait">未开始</span>';
    return `<label class="mp-card ${on ? 'on' : ''}">
      <input type="checkbox" class="mp-chk" data-pid="${p.id}" ${on ? 'checked' : ''}>
      <span class="mp-card-b">
        <span class="mp-name"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${badge}</span>
        <span class="mp-sub">试产发布 ${fmt(sp.startDate)} ~ ${fmt(sp.dueDate)}</span>
      </span>
    </label>`;
  }).join('');
  wrap.innerHTML = `
    <div class="report-hero">
      <div class="eyebrow">Monthly Plan</div>
      <h1 class="pano-title">月度计划</h1>
      <div class="report-tools">
        <p class="pano-sub">只统计本月内试产发布：达成率 = 已完成试产发布项目 / 本月计划试产发布项目 · 勾选 = 纳入计划（本地记忆）</p>
        <div class="date-nav">
          <button class="btn" id="mpPrev">‹</button>
          <span class="cal-title" id="mpLabel">${y}年 ${names[mo]}</span>
          <button class="btn" id="mpNext">›</button>
          <button class="btn" id="mpThis">本月</button>
        </div>
      </div>
    </div>
    <div class="pano-kpis">
      <div class="kpi"><div class="kpi-l">本月试产项目</div><div class="kpi-v">${rows.length}</div></div>
      <div class="kpi"><div class="kpi-l">试产发布达成率</div><div class="kpi-v good">${rate}%</div></div>
      <div class="kpi"><div class="kpi-l">延期试产</div><div class="kpi-v ${totOverdue ? 'bad' : ''}">${totOverdue}</div></div>
      <div class="kpi"><div class="kpi-l">已完成试产</div><div class="kpi-v good">${doneCnt}</div></div>
    </div>
    <div class="report-wrap">
      <div class="ptile span2" style="padding:20px 22px">
        <h4>本月试产发布 <span class="ted">达成率 = 已完成试产发布项目 / 本月计划试产发布项目 · 延期 = 已过截止仍未完成</span></h4>
        <div class="mp-grid">
          ${rows.length ? cardHtml : '<div class="mp-empty">本月没有试产发布的项目</div>'}
        </div>
      </div>
    </div>`;
  $('#mpPrev').onclick = () => { state.monthlyDate = new Date(y, mo - 1, 1); renderMonthly(); };
  $('#mpNext').onclick = () => { state.monthlyDate = new Date(y, mo + 1, 1); renderMonthly(); };
  $('#mpThis').onclick = () => { state.monthlyDate = new Date(); renderMonthly(); };
  $$('.mp-chk', wrap).forEach(cb => cb.onchange = () => {
    let arr = []; try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
    if (!arr.length) arr = rows.map(r => r.p.id);
    const id = cb.dataset.pid;
    if (cb.checked) { if (!arr.includes(id)) arr.push(id); }
    else arr = arr.filter(x => x !== id);
    localStorage.setItem(key, JSON.stringify(arr));
    cb.closest('.mp-card').classList.toggle('on', cb.checked);
  });
}

/* ---------- 看板名称可编辑 ---------- */
(function () {
  const nameEl = $('#appName'); if (!nameEl) return;
  let saved = '项目看板'; try { saved = localStorage.getItem('kb-appname') || '项目看板'; } catch (e) {}
  nameEl.textContent = saved;
  nameEl.onclick = () => {
    if (state.readonly) { toast('只读模式，无法修改名称'); return; }
    const input = document.createElement('input');
    input.value = nameEl.textContent;
    nameEl.innerHTML = ''; nameEl.appendChild(input);
    input.focus(); input.select();
    const done = () => { const v = input.value.trim() || '项目看板'; nameEl.textContent = v; saved = v; try { localStorage.setItem('kb-appname', v); } catch (e) {} };
    input.onblur = done;
    input.onkeydown = e => { if (e.key === 'Enter') done(); else if (e.key === 'Escape') nameEl.textContent = saved; };
  };
})();

/* ---------- 更换看板图标：上传 + 裁剪 ---------- */
(function () {
  const img = document.getElementById('brandLogo');
  if (!img) return;
  const SIZE = 220;
  let ts = ''; try { ts = localStorage.getItem('kb-brand-ts') || ''; } catch (e) {}
  if (ts) img.src = '/brand-logo.png?t=' + ts;

  const modal = $('#brandModal'), file = $('#brandFile');
  const canvas = $('#brandCropCanvas'), ctx = canvas.getContext('2d');
  const zoomEl = $('#brandZoom'), saveBtn = $('#brandSave');
  let imgObj = null, scale = 1, ox = 0, oy = 0, baseScale = 1;

  function draw() {
    if (!ctx || !imgObj) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const dw = imgObj.naturalWidth * baseScale * scale;
    const dh = imgObj.naturalHeight * baseScale * scale;
    const x = (SIZE - dw) / 2 + ox, y = (SIZE - dh) / 2 + oy;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, SIZE, SIZE); ctx.clip();
    ctx.drawImage(imgObj, x, y, dw, dh);
    ctx.restore();
  }
  function clampOffset() {
    const dw = imgObj.naturalWidth * baseScale * scale;
    const dh = imgObj.naturalHeight * baseScale * scale;
    ox = Math.max(Math.min(ox, (dw - SIZE) / 2), -(dw - SIZE) / 2);
    oy = Math.max(Math.min(oy, (dh - SIZE) / 2), -(dh - SIZE) / 2);
  }
  function openWith(f) {
    if (!f || !f.type.startsWith('image/')) { toast('请选择图片文件'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        imgObj = im;
        baseScale = Math.max(SIZE / im.naturalWidth, SIZE / im.naturalHeight);
        scale = 1; ox = 0; oy = 0; zoomEl.value = 1;
        draw(); saveBtn.disabled = false;
      };
      im.src = reader.result;
    };
    reader.readAsDataURL(f);
  }
  let dragging = false, sx = 0, sy = 0, sox = 0, soy = 0;
  canvas.addEventListener('pointerdown', e => { dragging = true; sx = e.clientX; sy = e.clientY; sox = ox; soy = oy; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => { if (!dragging) return; ox = sox + (e.clientX - sx); oy = soy + (e.clientY - sy); clampOffset(); draw(); });
  canvas.addEventListener('pointerup', () => dragging = false);
  zoomEl.oninput = () => { scale = parseFloat(zoomEl.value); clampOffset(); draw(); };
  $('#brandPick').onclick = () => file.click();
  file.onchange = e => { openWith(e.target.files[0]); e.target.value = ''; };
  img.onclick = () => { if (state.readonly) { toast('只读模式，无法更换图标'); return; } imgObj = null; scale = 1; ox = 0; oy = 0; zoomEl.value = 1; saveBtn.disabled = true; if (ctx) ctx.clearRect(0, 0, SIZE, SIZE); modal.classList.remove('hidden'); };
  $('#brandCancel').onclick = () => modal.classList.add('hidden');
  saveBtn.onclick = async () => {
    if (!imgObj) return;
    const dw = imgObj.naturalWidth * baseScale * scale;
    const dh = imgObj.naturalHeight * baseScale * scale;
    const ix = (SIZE - dw) / 2 + ox, iy = (SIZE - dh) / 2 + oy;
    const sx = (-ix) * (imgObj.naturalWidth / dw);
    const sy = (-iy) * (imgObj.naturalHeight / dh);
    const sw = SIZE * (imgObj.naturalWidth / dw);
    const sh = SIZE * (imgObj.naturalHeight / dh);
    const out = document.createElement('canvas');
    out.width = 256; out.height = 256;
    out.getContext('2d').drawImage(imgObj, sx, sy, sw, sh, 0, 0, 256, 256);
    const dataUrl = out.toDataURL('image/png');
    try {
      const r = await fetch('/api/brand-logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: dataUrl }) });
      if (!r.ok) throw new Error('保存失败');
      ts = String(Date.now());
      try { localStorage.setItem('kb-brand-ts', ts); } catch (e) {}
      img.src = '/brand-logo.png?t=' + ts;
      modal.classList.add('hidden');
      toast('看板图标已更新');
    } catch (e) { toast('保存失败: ' + e.message); }
  };
})();

loadAll();
