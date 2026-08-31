/* =========================================================================
 * WorkBuddy 工作台模板 · 离线适配器
 * 作用：把真实 kanban 前端(app.js)的所有 /api/* 请求拦截到浏览器内
 *       localStorage 仓储，强制演示模式(免登录)，并灌入示例数据，
 *       使「最新版真实代码」无需后端即可在单文件 HTML 中完整运行。
 * 注意：本文件必须在 app.js 之前加载。
 * ========================================================================= */
(function () {
  'use strict';
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  var P = 'kb_offline_v1_';
  var LS = {
    g: function (k, d) { try { var v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    s: function (k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) {} }
  };

  function uid(p) { return (p || 'x') + Math.random().toString(36).slice(2, 9); }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function isoAdd(s, n) { var d = new Date((s || todayISO()) + 'T00:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function isOverdue(t) { return t && !t.done && t.dueDate && t.dueDate < todayISO(); }

  var PHASES = [
    { id: 'p1', name: '需求立项', color: '#0a84ff' },
    { id: 'p2', name: '设计开发', color: '#30d158' },
    { id: 'p3', name: '打样试制', color: '#ff9f0a' },
    { id: 'p4', name: '测试验证', color: '#bf5af2' },
    { id: 'p5', name: '量产导入', color: '#ff453a' },
    { id: 'p6', name: '上市运营', color: '#64d2ff' }
  ];
  function clonePhases() { return PHASES.map(function (x) { return { id: x.id, name: x.name, color: x.color }; }); }

  function task(id, title, phaseId, done, start, due, who, est, ms) {
    return {
      id: id, title: title, note: '', phaseId: phaseId, done: !!done,
      startDate: start || '', dueDate: due || '', assignee: who || '',
      estimateDays: est || 0, isMilestone: !!ms
    };
  }

  function mkProject(o) {
    return {
      id: o.id, name: o.name, type: o.type || 'C端', level: o.level || 'B',
      productType: o.productType || '', cert: o.cert || '',
      startDate: o.start || todayISO(), status: 'active', completedAt: null,
      color: o.color || '#10a37f', engineers: o.engineers || [],
      phases: clonePhases(), tasks: o.tasks || []
    };
  }

  function seed() {
    var p1 = mkProject({
      id: 'prj_uc0305j', name: '智能门锁', type: 'C端', level: 'B',
      productType: 'AI', cert: '3C', color: '#10a37f', engineers: ['张工', '李工'],
      start: '2026-08-03',
      tasks: [
        task('t1', '需求调研与立项', 'p1', true, '2026-08-03', '2026-08-07', '张工', 4),
        task('t2', '竞品拆解', 'p1', true, '2026-08-05', '2026-08-09', '李工', 4),
        task('t3', '主控方案设计', 'p2', true, '2026-08-10', '2026-08-15', '张工', 5),
        task('t4', '结构 / ID 设计', 'p2', false, '2026-08-12', '2026-08-18', '李工', 6),
        task('t5', '首版打样', 'p3', false, '2026-08-19', '2026-08-25', '张工', 6),
        task('t6', '模具 T0', 'p3', false, '2026-08-22', '2026-08-28', '李工', 6),
        task('t7', '功能测试', 'p4', false, '2026-08-26', '2026-08-29', '张工', 5),
        task('t8', '10 万次寿命测试', 'p4', false, '2026-08-30', '2026-09-05', '李工', 8),
        task('t9', '试产发布', 'p5', false, '2026-09-08', '2026-09-12', '张工', 3, true),
        task('t10', '量产爬坡', 'p5', false, '2026-09-13', '2026-09-30', '李工', 10),
        task('t11', '上市发布', 'p6', false, '2026-10-08', '2026-10-15', '张工', 2)
      ]
    });
    var p2 = mkProject({
      id: 'prj_wifi', name: '智能摄像头 迭代 v2', type: '迭代', level: 'A',
      productType: '智能摄像头', cert: 'CE', color: '#0a84ff', engineers: ['王工'],
      start: '2026-08-10',
      tasks: [
        task('w1', '迭代需求评审', 'p1', true, '2026-08-10', '2026-08-13', '王工', 3),
        task('w2', '驱动重构', 'p2', false, '2026-08-14', '2026-08-22', '王工', 8),
        task('w3', '射频调优', 'p3', false, '2026-08-23', '2026-08-29', '王工', 5),
        task('w4', '兼容性认证', 'p4', false, '2026-08-30', '2026-09-08', '王工', 7),
        task('w5', '量产导入', 'p5', false, '2026-09-09', '2026-09-20', '王工', 8)
      ]
    });
    var p3 = mkProject({
      id: 'prj_pdhub', name: '智能门铃 预研', type: '预研', level: 'C',
      productType: '智能门铃', cert: '', color: '#ff9f0a', engineers: ['赵工'],
      start: '2026-07-20',
      tasks: [
        task('h1', '技术可行性评估', 'p1', true, '2026-07-20', '2026-07-27', '赵工', 5),
        task('h2', '原型设计', 'p2', false, '2026-07-28', '2026-08-10', '赵工', 8),
        task('h3', '实验室验证', 'p4', false, '2026-08-11', '2026-08-25', '赵工', 10),
        task('h4', '预研结题', 'p6', false, '2026-08-26', '2026-09-05', '赵工', 3)
      ]
    });
    var tpls = [
      { id: 'tpl_std', name: '智能硬件标准模板', phases: clonePhases(), tasks: [
        task('tt1', '需求立项', 'p1', false, '', '', '', 4),
        task('tt2', '设计开发', 'p2', false, '', '', '', 8),
        task('tt3', '打样试制', 'p3', false, '', '', '', 6),
        task('tt4', '测试验证', 'p4', false, '', '', '', 7),
        task('tt5', '量产导入', 'p5', false, '', '', '', 10)
      ] },
      { id: 'tpl_ce', name: 'C 端消费电子', phases: clonePhases(), tasks: [
        task('ct1', '市场调研', 'p1', false, '', '', '', 5),
        task('ct2', '产品定义', 'p1', false, '', '', '', 4),
        task('ct3', '研发实现', 'p2', false, '', '', '', 12),
        task('ct4', '试产验证', 'p3', false, '', '', '', 8),
        task('ct5', '上市运营', 'p6', false, '', '', '', 3)
      ] }
    ];
    var options = {
      types: { 'C端': '#0A84FF', 'B端': '#30D158', '预研': '#FF9F0A', '迭代': '#BF5AF2' },
      productTypes: {
        'AI': '#10a37f', 'CC线': '#06b6d4', 'DOCK': '#0ea5e9', 'MI': '#a3e635', 'MST': '#eab308',
        '智能门铃': '#f97316', 'SSD HUB': '#64748b', 'TB5': '#6366f1', 'U4': '#a855f7',
        '智能摄像头': '#14b8a6', '基础hub': '#94a3b8'
      },
      levels: { 'S': '#E0241B', 'A': '#FF9F0A', 'B': '#30D158', 'C': '#0A84FF', 'D': '#BF5AF2', 'E': '#64D2FF', 'F': '#8E8E93' },
      phases: clonePhases()
    };
    return { projects: [p1, p2, p3], templates: tpls, options: options };
  }

  if (LS.g('projects', null) == null) {
    var s = seed();
    LS.s('projects', s.projects);
    LS.s('templates', s.templates);
    LS.s('options', s.options);
  }

  function projects() { return LS.g('projects', []); }
  function saveProjects(a) { LS.s('projects', a); }
  function templates() { return LS.g('templates', []); }
  function saveTemplates(a) { LS.s('templates', a); }
  function findProject(id) { return projects().filter(function (p) { return p.id === id; })[0] || null; }

  function res(data, status) {
    status = status || 200;
    var ok = status >= 200 && status < 300;
    var payload = (typeof data === 'string') ? data : JSON.stringify(data);
    return {
      ok: ok, status: status, statusText: ok ? 'OK' : 'ERR',
      json: function () { return Promise.resolve(typeof data === 'string' ? JSON.parse(data) : data); },
      text: function () { return Promise.resolve(payload); },
      blob: function () { return Promise.resolve(new Blob([payload], { type: 'application/octet-stream' })); },
      headers: new Map()
    };
  }

  function aiGenerate(desc) {
    var d = (desc || '').slice(0, 40);
    return [
      { title: '需求调研与立项', phase: '需求立项', estimateDays: 5, assignee: '' },
      { title: '方案设计与评审', phase: '设计开发', estimateDays: 8, assignee: '' },
      { title: '首版打样', phase: '打样试制', estimateDays: 6, assignee: '' },
      { title: '功能 / 可靠性测试', phase: '测试验证', estimateDays: 7, assignee: '' },
      { title: '试产与量产导入', phase: '量产导入', estimateDays: 10, assignee: '' }
    ].map(function (t) { return t; });
  }

  function buildReport() {
    var rows = {};
    projects().forEach(function (p) {
      (p.tasks || []).forEach(function (t) {
        var who = t.assignee || '未分配';
        if (!rows[who]) rows[who] = { user: { name: who, role: 'member' }, projects: {}, tasks: 0, done: 0, overdue: 0, phases: {} };
        var r = rows[who];
        r.projects[p.id] = 1; r.tasks++; if (t.done) r.done++;
        if (isOverdue(t)) r.overdue++;
        var ph = (p.phases || []).filter(function (x) { return x.id === t.phaseId; })[0];
        var nm = ph ? ph.name : '未分类';
        if (!r.phases[nm]) r.phases[nm] = { done: 0, total: 0 };
        r.phases[nm].total++; if (t.done) r.phases[nm].done++;
      });
    });
    return Object.keys(rows).map(function (k) {
      var r = rows[k];
      return {
        user: r.user, projects: Object.keys(r.projects).length, tasks: r.tasks,
        done: r.done, overdue: r.overdue, rate: r.tasks ? Math.round(r.done / r.tasks * 100) : 0,
        phases: r.phases
      };
    });
  }

  function route(method, path, body) {
    // /readonly
    if (method === 'GET' && path === '/readonly') return res({ on: false, demo: true });
    // /options
    if (path === '/options' && method === 'GET') return res(LS.g('options', null) || {});
    if (path === '/options' && method === 'POST') { LS.s('options', body || {}); return res(body || {}); }
    // /templates
    if (path === '/templates' && method === 'GET') return res(templates());
    if (path === '/templates' && method === 'POST') { var nt = body || {}; nt.id = uid('tpl'); saveTemplates(templates().concat([nt])); return res(nt); }
    if (path === '/templates/import' && method === 'POST') return res({});
    var m = path.match(/^\/templates\/([^/]+)$/);
    if (m) {
      if (method === 'DELETE') { saveTemplates(templates().filter(function (x) { return x.id !== m[1]; })); return res({}, 204); }
      if (method === 'PUT') { var up = templates().map(function (x) { return x.id === m[1] ? Object.assign({}, x, body) : x; }); saveTemplates(up); return res(up.filter(function (x) { return x.id === m[1]; })[0] || {}); }
    }
    // /report
    if (path === '/report' && method === 'GET') return res(buildReport());
    if (path === '/report/export' && method === 'GET') return res('');
    if (path === '/reports/todo-export' && method === 'GET') return res('');
    // /ai
    if (path === '/ai/config' && method === 'GET') return res({ configured: false });
    if (path === '/ai/config' && method === 'POST') return res({ ok: true });
    if (path === '/ai/ollama-models' && method === 'GET') return res([]);
    if (path === '/ai/generate-tasks' && method === 'POST') return res({ tasks: aiGenerate(body && body.description) });
    if (path === '/ai/summarize' && method === 'POST') return res({ text: '（离线演示）基于当前项目数据：整体进度可控，关键路径为打样试制→测试验证→试产发布；建议重点关注逾期任务与模具 T0 节点，确保试产发布按期达成。' });
    // /users / password / readonly(POST)
    if (path === '/users' && method === 'GET') return res([]);
    if (path === '/users' && method === 'POST') return res({});
    var um = path.match(/^\/users\/([^/]+)$/);
    if (um) return res({});
    if (path === '/password' && method === 'POST') return res({});
    if (path === '/readonly' && method === 'POST') return res({});
    // /login
    if (path === '/login' && method === 'POST') return res({ token: 'offline', user: { name: '演示用户', role: 'admin' } });
    // /brand-logo
    if (path === '/brand-logo' && method === 'POST') return res({});
    // projects/:id/export
    var exp = path.match(/^\/projects\/([^/]+)\/export$/);
    if (exp && method === 'GET') return res('');
    // templates/reference-xlsx
    if (path === '/templates/reference-xlsx' && method === 'GET') return res('');
    // /projects/order
    if (path === '/projects/order' && method === 'PUT') {
      var ids = (body && body.ids) || [];
      var map = {}; projects().forEach(function (p, i) { map[p.id] = p; });
      var ordered = ids.map(function (id) { return map[id]; }).filter(Boolean).concat(projects().filter(function (p) { return ids.indexOf(p.id) < 0; }));
      saveProjects(ordered); return res({});
    }
    // /projects/import
    if (path === '/projects/import' && method === 'POST') {
      var data = (body && body.data) || [];
      var name = (body && body.filename) || '导入项目';
      var arr = Array.isArray(data) ? data : [];
      var np = mkProject({ id: uid('prj'), name: name, tasks: arr.map(function (t, i) {
        return task(uid('t'), t.title || ('任务' + (i + 1)), t.phaseId || 'p2', !!t.done, t.startDate || '', t.dueDate || '', t.assignee || '', Number(t.estimateDays) || 0, !!t.isMilestone);
      }) });
      saveProjects(projects().concat([np])); return res(np);
    }
    // /projects/:id/tasks/:tid
    var tmt = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (tmt) {
      var arrT = projects();
      var pj = arrT.filter(function (p) { return p.id === tmt[1]; })[0]; if (!pj) return res({ error: 'project not found' }, 404);
      if (method === 'DELETE') { pj.tasks = pj.tasks.filter(function (x) { return x.id !== tmt[2]; }); saveProjects(arrT); return res({}, 204); }
      if (method === 'PUT') {
        var tk = pj.tasks.filter(function (x) { return x.id === tmt[2]; })[0]; if (!tk) return res({ error: 'task not found' }, 404);
        ['title', 'note', 'phaseId', 'done', 'assignee', 'estimateDays', 'startDate', 'dueDate', 'isMilestone'].forEach(function (f) {
          if (body && body[f] !== undefined) tk[f] = body[f];
        });
        saveProjects(arrT); return res(tk);
      }
    }
    // /projects/:id/tasks (create)
    var mt = path.match(/^\/projects\/([^/]+)\/tasks$/);
    if (mt && method === 'POST') {
      var arrM = projects();
      var pj2 = arrM.filter(function (p) { return p.id === mt[1]; })[0]; if (!pj2) return res({ error: 'project not found' }, 404);
      var nt2 = task(uid('t'), body.title || '未命名', body.phaseId || pj2.phases[0].id, false,
        body.startDate || pj2.startDate || todayISO(), body.dueDate || '', body.assignee || '', Number(body.estimateDays) || 0, false);
      nt2.note = body.note || '';
      pj2.tasks.push(nt2); saveProjects(arrM); return res(nt2);
    }
    // /projects/:id/reschedule
    var rs = path.match(/^\/projects\/([^/]+)\/reschedule$/);
    if (rs && method === 'POST') { var rp = findProject(rs[1]); return res(rp || {}); }
    // /projects/:id
    var pm = path.match(/^\/projects\/([^/]+)$/);
    if (pm) {
      var arrP = projects();
      if (method === 'GET') { var gp = arrP.filter(function (p) { return p.id === pm[1]; })[0]; return gp ? res(gp) : res({ error: 'not found' }, 404); }
      if (method === 'DELETE') { saveProjects(arrP.filter(function (x) { return x.id !== pm[1]; })); return res({}, 204); }
      if (method === 'PUT') {
        var up2 = arrP.filter(function (p) { return p.id === pm[1]; })[0]; if (!up2) return res({ error: 'not found' }, 404);
        ['name', 'type', 'level', 'productType', 'cert', 'engineers', 'startDate', 'status', 'completedAt', 'phases', 'color'].forEach(function (f) {
          if (body && body[f] !== undefined) up2[f] = body[f];
        });
        saveProjects(arrP); return res(up2);
      }
    }
    // /projects (list / create)
    if (path === '/projects' && method === 'GET') return res(projects());
    if (path === '/projects' && method === 'POST') {
      if (body && body.phases && body.tasks) {
        var np2 = mkProject({ id: uid('prj'), name: body.name || '新项目', type: body.type || 'C端', level: body.level || 'B', productType: body.productType || '', cert: body.cert || '', engineers: body.engineers || [] });
        np2.phases = body.phases;
        np2.tasks = (body.tasks || []).map(function (t) { return task(uid('t'), t.title || '未命名', t.phaseId || np2.phases[0].id, !!t.done, np2.startDate, '', t.assignee || '', Number(t.estimateDays) || 0, false); });
        saveProjects(projects().concat([np2])); return res(np2);
      }
      var tpl = null;
      if (body && body.templateId) tpl = templates().filter(function (x) { return x.id === body.templateId; })[0] || null;
      var np3 = mkProject({ id: uid('prj'), name: body.name || (tpl ? tpl.name : '新项目'), type: body.type || 'C端', level: body.level || 'B', productType: body.productType || '', cert: body.cert || '', engineers: body.engineers || [] });
      if (tpl) { np3.phases = tpl.phases.map(function (x) { return { id: x.id, name: x.name, color: x.color }; }); np3.tasks = (tpl.tasks || []).map(function (t) { return task(uid('t'), t.title, t.phaseId, false, np3.startDate, '', '', Number(t.estimateDays) || 0, false); }); }
      saveProjects(projects().concat([np3])); return res(np3);
    }
    return res({ error: 'not implemented: ' + method + ' ' + path }, 404);
  }

  window.fetch = function (input, opts) {
    opts = opts || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/\/api(\/|$)/.test(url)) return realFetch ? realFetch(input, opts) : Promise.reject(new Error('no fetch'));
    var qidx = url.indexOf('?');
    var path = (qidx >= 0 ? url.slice(0, qidx) : url).replace(/\/api/, '') || '/';
    var method = (opts.method || 'GET').toUpperCase();
    var body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = opts.body; } }
    try { return Promise.resolve(route(method, path, body)); }
    catch (e) { return res({ error: String(e && e.message || e) }, 500); }
  };

  // 便于演示：清空示例数据并恢复初始种子
  window.__resetKanbanDemo = function () {
    ['projects', 'templates', 'options'].forEach(function (k) { try { localStorage.removeItem(P + k); } catch (e) {} });
    location.reload();
  };
})();
