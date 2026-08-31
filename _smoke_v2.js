const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'kanban-workbench-template.html'), 'utf-8');
const errors = [];

const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = e && e.message || '';
  // jsdom-only limitation, harmless in a real browser: canvas getContext not implemented
  if (/HTMLCanvasElement|getContext|Not implemented/i.test(m)) return;
  errors.push('jsdomError: ' + m);
});
// forward page console.* to node (replaces unavailable vc.sendTo)
for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
  vc.on(lvl, (...args) => console.log('[page:' + lvl + ']', ...args.map(a => typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a)).slice(0, 1)));
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://workbuddy-space-static.codebuddy.work/page/x/0/',
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || function () {
      return { matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
    };
    window.AbortController = global.AbortController;
    window.AbortController = window.AbortController || global.AbortController;
    window.Blob = window.Blob || global.Blob;
    window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:fake');
    window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
    window.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
    window.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  }
});

setTimeout(async () => {
  const w = dom.window, doc = w.document;
  function q(s) { return doc.querySelector(s); }
  function qa(s) { return doc.querySelectorAll(s); }

  const projCount = qa('#projList .proj').length;
  const cards = qa('#board .card').length;
  const cols = qa('#board .col').length;
  const stats = q('#stats') ? q('#stats').textContent.replace(/\s+/g, ' ').trim() : '(none)';
  const demo = q('#demoBadge');
  const demoShown = demo ? !demo.classList.contains('hidden') : 'no-el';
  console.log('projects=', projCount, '| board cols=', cols, '| cards=', cards);
  console.log('demoBadge shown=', demoShown);
  console.log('stats=', stats.slice(0, 90));

  // adapter fetch sanity
  try {
    const r = await w.fetch('/api/projects');
    const data = await r.json();
    console.log('adapter /api/projects returns', data.length, 'projects');
  } catch (e) { errors.push('adapter fetch: ' + e.message); }

  // switch views
  function clickView(v) {
    const b = [...qa('.tab')].find(x => x.dataset.view === v);
    if (b) b.click();
  }
  let viewErr = [];
  for (const v of ['gantt', 'weekly', 'panorama', 'monthly', 'summary', 'calendar', 'board']) {
    try { clickView(v); } catch (e) { viewErr.push(v + ':' + e.message); }
  }
  console.log('view switch errors=', viewErr.length ? viewErr.join('; ') : 'none');
  console.log('gantt children after switch=', qa('#gantt *').length, '| weekly/report html len=', (q('#report') ? q('#report').innerHTML.length : 0));

  // simulate add task through real API path
  try {
    const before = (await (await w.fetch('/api/projects')).json()).reduce((a, p) => a + p.tasks.length, 0);
    const pj = (await (await w.fetch('/api/projects')).json())[0];
    const created = await (await w.fetch('/api/projects/' + pj.id + '/tasks', { method: 'POST', body: JSON.stringify({ title: '冒烟测试任务', phaseId: pj.phases[1].id, assignee: '测', estimateDays: 2 }) })).json();
    const after = (await (await w.fetch('/api/projects')).json()).reduce((a, p) => a + p.tasks.length, 0);
    console.log('add-task: before=', before, 'after=', after, 'created.id=', created.id ? 'ok' : 'fail');
  } catch (e) { errors.push('add-task: ' + e.message); }

  console.log('=== CAPTURED ERRORS (' + errors.length + ') ===');
  errors.slice(0, 10).forEach(e => console.log(' -', e.slice(0, 200)));

  if (projCount >= 3 && cards > 0 && demoShown === true && errors.length === 0) {
    console.log('SMOKE_OK');
  } else {
    console.log('SMOKE_FAIL');
  }
}, 700);
