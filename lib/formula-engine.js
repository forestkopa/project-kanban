// lib/formula-engine.js —— 甘特公式引擎（2026-08-25 从 server.js 抽取，纯函数无外部依赖）
// 含：日期工具 / Excel 列名与公式解析 / 单元格引用解析 / 依赖图拓扑级联重算

/* eslint-disable */
// @ts-nocheck  —— TS 控制流反向推断对 Date 重载歧义敏感；改严格检查请逐函数加 JSDoc 类型

/** @param {Date|string|number} d */
function isoDate(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
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


module.exports = { isoDate, addDays, normDate, colName, parseTerm, parseFormula, resolveRef, collectRuleRefs, evalRule, recalcProject };
