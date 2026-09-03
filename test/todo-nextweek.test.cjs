// 前端 collectTodos('nextweek') 顺延模型单测（锁选择逻辑，无需 jsdom）
// 回归点：下周待办 = 本周未完成(done=false)自动顺延 + 下周计划；已完成排除；归档项目任务排除；顺延在前。
const path = require('path');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function makeEl() {
  const cls = new Set();
  return { _cls: cls, classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else { on ? cls.add(c) : cls.delete(c); } }, contains: c => cls.has(c) }, style: {}, value: '', checked: false, textContent: '', disabled: false, onclick: null, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, focus() {}, remove() {}, getContext: () => new Proxy({}, { get: () => (() => {}) }) }; }
function makeEnv() {
  const els = {}; const get = sel => (els[sel] || (els[sel] = makeEl()));
  global.document = { getElementById: get, querySelector: get, querySelectorAll: () => [], createElement: () => makeEl(), addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {} } } };
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  global.location = { reload() {} };
  global.window = undefined; // 关键：Node 下 typeof window === 'undefined'，app.js 顶层不自动 boot
  global.setInterval = () => 0; global.clearInterval = () => {};
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  return { els, store };
}

(async () => {
  makeEnv();
  const p = path.resolve(__dirname, '../public/app.js');
  delete require.cache[p];
  const app = require(p);
  const { isoDate, addDays, weekRange, TODAY } = app;
  const today = TODAY();
  const { mon, days } = weekRange(today);
  const thisSun = isoDate(days[6]);
  const nextMon = isoDate(addDays(mon, 7));
  const nextSun = isoDate(addDays(days[6], 7));
  const st = app.getState();
  st.weekDate = new Date(today);
  st.todoFilter = {};
  st.projects = [
    { id: 'p1', name: '项目A', status: 'active', tasks: [
      { id: 't1', title: '本周未完成顺延', done: false, dueDate: thisSun },
      { id: 't2', title: '已完成不出现', done: true, dueDate: thisSun },
      { id: 't3', title: '下周计划', done: false, dueDate: nextMon },
      { id: 't4', title: '下下周不出现', done: false, dueDate: isoDate(addDays(days[6], 14)) },
      { id: 't5', title: '更早逾期顺延', done: false, dueDate: isoDate(addDays(mon, -3)) },
    ] },
    { id: 'p2', name: '项目B', status: 'archived', tasks: [ { id: 't6', title: '归档不出现', done: false, dueDate: thisSun } ] },
  ];
  const rows = app.collectTodos('nextweek');
  const all = rows.flatMap(r => r.list);
  ok('collectTodos(nextweek) 返回数组', Array.isArray(rows));
  ok('仅含 active 项目（归档被过滤）', rows.length === 1 && rows[0].p.id === 'p1', rows.map(r => r.p.id));
  ok('纳入本周未完成顺延(t1)', all.some(t => t.id === 't1' && t.carryover === true));
  ok('纳入更早逾期顺延(t5)', all.some(t => t.id === 't5' && t.carryover === true));
  ok('纳入下周计划(t3)', all.some(t => t.id === 't3' && t.carryover === false));
  ok('排除已完成(t2)', !all.some(t => t.id === 't2'));
  ok('排除下下周(t4)', !all.some(t => t.id === 't4'));
  ok('排除归档项目任务(t6)', !all.some(t => t.id === 't6'));
  const idxCarry = all.findIndex(t => t.carryover);
  const idxNext = all.findIndex(t => !t.carryover);
  ok('排序：顺延任务在前', idxCarry >= 0 && idxNext >= 0 && idxCarry < idxNext, { idxCarry, idxNext });
  console.log('\n========== collectTodos(nextweek) 单测 ==========');
  console.log(fail === 0 ? ('✅ 通过 ' + pass + '/' + pass) : ('❌ 失败 ' + fail + '/' + (pass + fail) + '  [' + fails.join(', ') + ']'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', (e && e.stack) || e); process.exit(1); });
