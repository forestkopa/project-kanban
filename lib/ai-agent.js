'use strict';
/**
 * AI Agent：让内置 AI 助手能真正"动手"操作看板（读写项目/任务）。
 *
 * 设计要点：
 * 1) 依赖注入（db / 辅助函数 / chat），不 require server.js，避免循环依赖且便于单测注入 mock。
 * 2) 权限红线：所有工具一律以「当前登录用户」身份经 db.* 执行，member 看不到他人项目；
 *    只读模式（readonly.flag）开启时，写工具一律拒绝。
 * 3) 危险操作（删除项目/任务）不直接执行，返回 needConfirm + token，前端确认后才落地（误删可进回收站找回）。
 * 4) 双协议：模型支持 function calling 走原生 tools；不支持（多数本地小模型）降级为 ReAct 文本协议
 *    （要求模型输出 `TOOL: {"tool":..,"args":..}` 指令块，后端解析执行）。
 */
module.exports = function createAgent(deps) {
  const {
    db, uid, isoDate, addDays, recalcProject, scheduleTasks,
    PHASE_COLORS, canAllRole, isManagerRole, chat, isReadOnly
  } = deps;

  const MAX_STEPS = 8;           // 单轮对话最多工具调用轮次（防死循环/烧钱）
  const TASK_LIST_LIMIT = 60;    // 单次返回任务条数上限（防 token 爆炸）
  const PENDING_TTL = 10 * 60 * 1000; // 待确认操作有效期 10 分钟

  /* ---------------- 待确认操作（危险操作二次确认） ---------------- */
  const pending = new Map(); // token -> { tool, args, ctx, expire }
  function newPending(tool, args, ctx) {
    const token = 'cf_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    pending.set(token, { tool, args, ctx, expire: Date.now() + PENDING_TTL });
    return token;
  }
  function takePending(token) {
    const p = pending.get(token);
    if (!p) return null;
    pending.delete(token);
    if (Date.now() > p.expire) return null;
    return p;
  }
  // 定期清理过期 pending，防内存泄漏
  const _cleanTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (now > v.expire) pending.delete(k);
  }, 60000);
  if (_cleanTimer.unref) _cleanTimer.unref();

  /* ---------------- 辅助：项目/任务解析（支持模糊名称） ---------------- */
  function visibleProjects(ctx) { return db.listProjects(ctx.userId, canAllRole(ctx.role)) || []; }

  // 按 id 或名称（支持包含/模糊）解析项目；命中多个返回候选
  function resolveProject(ref, ctx) {
    if (!ref) return { error: '缺少项目标识' };
    const list = visibleProjects(ctx);
    const s = String(ref).trim();
    const byId = list.find(p => p.id === s);
    if (byId) return { project: byId };
    const low = s.toLowerCase();
    const exact = list.filter(p => String(p.name || '').toLowerCase() === low);
    if (exact.length === 1) return { project: exact[0] };
    const partial = list.filter(p => String(p.name || '').toLowerCase().includes(low));
    if (partial.length === 1) return { project: partial[0] };
    if (partial.length > 1) {
      return { error: '匹配到多个项目：' + partial.map(p => p.name).join('、') + '，请让用户明确是哪一个' };
    }
    return { error: '未找到项目「' + s + '」（当前账号可见项目：' + (list.map(p => p.name).join('、') || '无') + '）' };
  }

  function resolveTask(proj, ref) {
    const tasks = proj.tasks || [];
    if (!ref) return { error: '缺少任务标识' };
    const s = String(ref).trim();
    const byId = tasks.find(t => t.id === s);
    if (byId) return { task: byId };
    const low = s.toLowerCase();
    const exact = tasks.filter(t => String(t.title || '').toLowerCase() === low);
    if (exact.length === 1) return { task: exact[0] };
    const partial = tasks.filter(t => String(t.title || '').toLowerCase().includes(low));
    if (partial.length === 1) return { task: partial[0] };
    if (partial.length > 1) return { error: '匹配到多个任务：' + partial.slice(0, 8).map(t => t.title).join('、') + '，请让用户明确是哪一个' };
    return { error: '未找到任务「' + s + '」' };
  }

  function today() { return isoDate(new Date()); }

  function projBrief(p) {
    const tasks = p.tasks || [];
    const done = tasks.filter(t => t.done).length;
    const td = today();
    const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < td).length;
    return {
      id: p.id, name: p.name, status: p.status || 'active',
      startDate: p.startDate || '', type: p.type || '', level: p.level || '',
      total: tasks.length, done,
      progress: tasks.length ? Math.round(done / tasks.length * 100) : 0,
      overdue,
      phases: (p.phases || []).map(x => x.name)
    };
  }

  function taskBrief(t, proj) {
    const ph = (proj.phases || []).find(x => x.id === t.phaseId);
    return {
      id: t.id, title: t.title || '', phase: ph ? ph.name : '',
      assignee: t.assignee || '', estimateDays: t.estimateDays || 0,
      done: !!t.done, startDate: t.startDate || '', dueDate: t.dueDate || '',
      overdue: !t.done && t.dueDate && t.dueDate < today()
    };
  }

  /* ---------------- 工具定义（OpenAI function calling schema） ---------------- */
  const TOOLS = [
    { type: 'function', function: { name: 'list_projects', description: '列出当前账号可见的所有项目及进度概览（项目名、状态、总任务数、已完成数、进度百分比、逾期数）。回答"有几个项目""进度如何"等问题时先调用它。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_overview', description: '获取全局概览：项目总数、任务总数、已完成、逾期任务清单、本周/下周到期任务。适合"整体情况""本周有什么到期""有哪些逾期"类问题。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_project', description: '获取单个项目的详情：阶段列表与任务清单（含负责人、工期、状态、起止日期、是否逾期）。project_ref 可以是项目 id 或项目名称（支持模糊匹配）。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或项目名称' } }, required: ['project_ref'] } } },
    { type: 'function', function: { name: 'search_tasks', description: '跨项目搜索任务。可按关键词、负责人、完成状态、是否逾期筛选。适合"张工负责哪些任务""有哪些未完成的结构任务"。', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '任务标题关键词' }, assignee: { type: 'string', description: '负责人姓名关键词' }, done: { type: 'boolean', description: 'true=只看已完成，false=只看未完成；不传则不限' }, overdue_only: { type: 'boolean', description: 'true=只看逾期任务' }, project_ref: { type: 'string', description: '限定在某个项目内（id 或名称）' }, limit: { type: 'number', description: '返回条数上限，默认 30' } }, required: [] } } },
    { type: 'function', function: { name: 'create_project', description: '创建一个新项目。传入项目名与任务清单（每项含阶段、标题、工期、负责人），系统自动按阶段顺序排期。适合"帮我建一个XX项目"。', parameters: { type: 'object', properties: { name: { type: 'string', description: '项目名称' }, start_date: { type: 'string', description: '开始日期 YYYY-MM-DD，默认今天' }, tasks: { type: 'array', description: '任务清单', items: { type: 'object', properties: { title: { type: 'string' }, phase: { type: 'string', description: '阶段名，如"需求立项/设计开发/打样试制/测试验证/量产导入/上市运营"' }, estimate_days: { type: 'number' }, assignee: { type: 'string' } }, required: ['title'] } } }, required: ['name', 'tasks'] } } },
    { type: 'function', function: { name: 'add_task', description: '给指定项目新增一个任务。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或名称' }, title: { type: 'string', description: '任务标题' }, phase: { type: 'string', description: '阶段名；不传则放到第一个阶段' }, assignee: { type: 'string', description: '负责人' }, estimate_days: { type: 'number', description: '工期天数' }, due_date: { type: 'string', description: '截止日期 YYYY-MM-DD，不传则按工期自动排' } }, required: ['project_ref', 'title'] } } },
    { type: 'function', function: { name: 'update_task', description: '修改任务：改标题、负责人、工期、完成状态或起止日期。task_ref 可以是任务 id 或任务标题（支持模糊匹配）。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或名称' }, task_ref: { type: 'string', description: '任务 id 或任务标题' }, title: { type: 'string' }, assignee: { type: 'string' }, estimate_days: { type: 'number' }, done: { type: 'boolean', description: 'true=标记完成' }, start_date: { type: 'string' }, due_date: { type: 'string' } }, required: ['project_ref', 'task_ref'] } } },
    { type: 'function', function: { name: 'update_project', description: '修改项目属性：改名、改状态（active/archived）、改开始日期（会级联重排所有任务）。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或名称' }, name: { type: 'string' }, status: { type: 'string', description: 'active 或 archived' }, start_date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['project_ref'] } } },
    { type: 'function', function: { name: 'delete_task', description: '【危险·需确认】删除指定任务（会先存入回收站，可恢复）。调用后会返回确认请求，须用户点确认才真正删除。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或名称' }, task_ref: { type: 'string', description: '任务 id 或任务标题' } }, required: ['project_ref', 'task_ref'] } } },
    { type: 'function', function: { name: 'delete_project', description: '【危险·需确认】删除整个项目（会先存入回收站，可恢复）。调用后会返回确认请求，须用户点确认才真正删除。', parameters: { type: 'object', properties: { project_ref: { type: 'string', description: '项目 id 或名称' } }, required: ['project_ref'] } } }
  ];

  const WRITE_TOOLS = new Set(['create_project', 'add_task', 'update_task', 'update_project', 'delete_task', 'delete_project']);
  const DANGER_TOOLS = new Set(['delete_task', 'delete_project']);

  /* ---------------- 工具实现 ---------------- */
  const impl = {
    list_projects(args, ctx) {
      const list = visibleProjects(ctx);
      if (!list.length) return { ok: true, result: { count: 0, projects: [], hint: '当前账号下还没有项目' } };
      return { ok: true, result: { count: list.length, projects: list.map(projBrief) } };
    },

    get_overview(args, ctx) {
      const list = visibleProjects(ctx);
      const td = today();
      const d = new Date();
      const dow = (d.getDay() + 6) % 7; // 周一=0
      const mon = isoDate(addDays(d, -dow));
      const sun = isoDate(addDays(d, 6 - dow));
      const nextSun = isoDate(addDays(d, 13 - dow));
      let total = 0, done = 0;
      const overdue = [], thisWeek = [], nextWeek = [];
      list.forEach(p => {
        (p.tasks || []).forEach(t => {
          total++; if (t.done) done++;
          const due = t.dueDate || '';
          const brief = { project: p.name, title: t.title, assignee: t.assignee || '', dueDate: due };
          if (!t.done && due && due < td) overdue.push(brief);
          else if (!t.done && due && due >= mon && due <= sun) thisWeek.push(brief);
          else if (!t.done && due && due > sun && due <= nextSun) nextWeek.push(brief);
        });
      });
      return {
        ok: true, result: {
          today: td, week: mon + ' ~ ' + sun,
          projectCount: list.length, taskTotal: total, taskDone: done,
          progress: total ? Math.round(done / total * 100) : 0,
          overdueCount: overdue.length, overdue: overdue.slice(0, 20),
          thisWeekCount: thisWeek.length, thisWeek: thisWeek.slice(0, 20),
          nextWeekCount: nextWeek.length, nextWeek: nextWeek.slice(0, 10)
        }
      };
    },

    get_project(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const tasks = (p.tasks || []).slice(0, TASK_LIST_LIMIT);
      return {
        ok: true, result: Object.assign(projBrief(p), {
          phases: (p.phases || []).map(x => ({ id: x.id, name: x.name })),
          tasks: tasks.map(t => taskBrief(t, p)),
          taskCount: (p.tasks || []).length,
          truncated: (p.tasks || []).length > TASK_LIST_LIMIT
        })
      };
    },

    search_tasks(args, ctx) {
      let list = visibleProjects(ctx);
      if (args.project_ref) {
        const r = resolveProject(args.project_ref, ctx);
        if (r.error) return { ok: false, error: r.error };
        list = [r.project];
      }
      const kw = String(args.keyword || '').toLowerCase();
      const asg = String(args.assignee || '').toLowerCase();
      const td = today();
      const out = [];
      list.forEach(p => (p.tasks || []).forEach(t => {
        if (kw && !String(t.title || '').toLowerCase().includes(kw)) return;
        if (asg && !String(t.assignee || '').toLowerCase().includes(asg)) return;
        if (args.done === true && !t.done) return;
        if (args.done === false && t.done) return;
        if (args.overdue_only && !( !t.done && t.dueDate && t.dueDate < td )) return;
        out.push(Object.assign({ project: p.name, projectId: p.id }, taskBrief(t, p)));
      }));
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), TASK_LIST_LIMIT);
      return { ok: true, result: { count: out.length, tasks: out.slice(0, limit) } };
    },

    create_project(args, ctx) {
      const name = String(args.name || '').trim();
      if (!name) return { ok: false, error: '缺少项目名称' };
      const raw = Array.isArray(args.tasks) ? args.tasks : [];
      if (!raw.length) return { ok: false, error: '缺少任务清单' };
      const startDate = args.start_date || isoDate(new Date());
      const order = [], map = {};
      const phases = [];
      raw.forEach(t => {
        const phName = String((t && t.phase) || '需求立项').trim() || '需求立项';
        if (!map[phName]) {
          const id = 'p' + (order.length + 1);
          map[phName] = id;
          const ph = { id, name: phName, color: PHASE_COLORS[order.length % PHASE_COLORS.length] };
          order.push(ph); phases.push(ph);
        }
      });
      if (!phases.length) { phases.push({ id: 'p1', name: '需求立项', color: PHASE_COLORS[0] }); map['需求立项'] = 'p1'; }
      const tasks = raw.map(t => ({
        id: uid(), title: String((t && t.title) || '未命名任务'),
        phaseId: map[String((t && t.phase) || '需求立项').trim()] || phases[0].id,
        note: '', estimateDays: Number(t && t.estimate_days) || 0,
        assignee: String((t && t.assignee) || ''), done: false, startDate: null, dueDate: null
      }));
      scheduleTasks(phases, tasks, startDate);
      const proj = {
        id: uid(), name, templateId: null, icon: '◆', color: '#0a84ff', startDate,
        type: 'C端', level: 'B', productType: '', cert: '', status: 'active', completedAt: null,
        engineers: { hardware: '', structure: '', project: '' },
        createdAt: new Date().toISOString(), phases, tasks,
        baseline: tasks.map(t => Object.assign({}, t))
      };
      db.saveProject(proj, ctx.userId);
      return { ok: true, result: { created: true, id: proj.id, name: proj.name, taskCount: tasks.length, startDate, message: '已创建项目「' + name + '」，共 ' + tasks.length + ' 个任务' } };
    },

    add_task(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const title = String(args.title || '').trim();
      if (!title) return { ok: false, error: '缺少任务标题' };
      let phaseId = (p.phases[0] && p.phases[0].id);
      if (args.phase) {
        const ph = (p.phases || []).find(x => String(x.name).includes(String(args.phase)));
        if (ph) phaseId = ph.id;
      }
      const start = p.startDate || isoDate(new Date());
      const days = Math.max(1, Number(args.estimate_days) || 1);
      const t = {
        id: uid(), title, phaseId, note: '',
        estimateDays: Number(args.estimate_days) || 0,
        assignee: String(args.assignee || ''), done: false,
        startDate: start, dueDate: args.due_date || isoDate(addDays(new Date(start), days)),
        recurrence: ''
      };
      p.tasks.push(t);
      recalcProject(p); db.saveProject(p, ctx.userId);
      return { ok: true, result: { created: true, project: p.name, task: taskBrief(t, p), message: '已在「' + p.name + '」新增任务「' + title + '」' } };
    },

    update_task(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const tr = resolveTask(p, args.task_ref);
      if (tr.error) return { ok: false, error: tr.error };
      const t = tr.task;
      const changes = [];
      if (args.title !== undefined && String(args.title) !== String(t.title)) { t.title = String(args.title); changes.push('标题'); }
      if (args.assignee !== undefined && String(args.assignee) !== String(t.assignee || '')) { t.assignee = String(args.assignee); changes.push('负责人'); }
      if (args.estimate_days !== undefined && Number(args.estimate_days) !== Number(t.estimateDays || 0)) { t.estimateDays = Number(args.estimate_days); changes.push('工期'); }
      if (args.done !== undefined && !!args.done !== !!t.done) { t.done = !!args.done; changes.push(t.done ? '标记完成' : '取消完成'); }
      if (args.start_date) { t.startDate = args.start_date; delete t.startRule; delete t.startF; changes.push('开始日期'); }
      if (args.due_date) { t.dueDate = args.due_date; delete t.dueRule; delete t.dueF; changes.push('截止日期'); }
      if (!changes.length) return { ok: true, result: { changed: false, message: '没有需要变更的内容' } };
      recalcProject(p); db.saveProject(p, ctx.userId);
      return { ok: true, result: { changed: true, project: p.name, task: taskBrief(t, p), changes, message: '已更新任务「' + t.title + '」（' + changes.join('、') + '）' } };
    },

    update_project(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const changes = [];
      if (args.name !== undefined && String(args.name) !== String(p.name)) { p.name = String(args.name); changes.push('名称'); }
      if (args.status !== undefined && ['active', 'archived'].includes(String(args.status))) { p.status = String(args.status); changes.push('状态'); }
      if (args.start_date) {
        p.startDate = args.start_date; changes.push('开始日期');
        const ft = (p.tasks || [])[0];
        if (ft) { ft.startDate = args.start_date; delete ft.startRule; delete ft.startF; }
        recalcProject(p);
      }
      if (!changes.length) return { ok: true, result: { changed: false, message: '没有需要变更的内容' } };
      db.saveProject(p, ctx.userId);
      return { ok: true, result: { changed: true, project: projBrief(p), changes, message: '已更新项目「' + p.name + '」（' + changes.join('、') + '）' } };
    },

    delete_task(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const tr = resolveTask(p, args.task_ref);
      if (tr.error) return { ok: false, error: tr.error };
      const t = tr.task;
      const token = newPending('delete_task', { projectId: p.id, taskId: t.id }, ctx);
      return {
        ok: true, needConfirm: true, token,
        preview: { action: '删除任务', project: p.name, task: t.title, assignee: t.assignee || '', dueDate: t.dueDate || '', hint: '删除后可在回收站恢复' }
      };
    },

    delete_project(args, ctx) {
      const r = resolveProject(args.project_ref, ctx);
      if (r.error) return { ok: false, error: r.error };
      const p = r.project;
      const token = newPending('delete_project', { projectId: p.id }, ctx);
      return {
        ok: true, needConfirm: true, token,
        preview: { action: '删除项目', project: p.name, taskCount: (p.tasks || []).length, hint: '整个项目及其 ' + (p.tasks || []).length + ' 个任务将移入回收站，可恢复' }
      };
    }
  };

  // 真正落地的危险操作（确认后执行）
  function commitPending(tool, args, ctx) {
    if (tool === 'delete_task') {
      const p = db.getProject(args.projectId, ctx.userId, canAllRole(ctx.role));
      if (!p) return { ok: false, error: '项目不存在或无权访问' };
      const idx = (p.tasks || []).findIndex(t => t.id === args.taskId);
      if (idx < 0) return { ok: false, error: '任务不存在' };
      const removed = p.tasks[idx];
      try { db.trashPush(ctx.userId, 'task', removed.id, { task: removed, seq: idx }, { projectId: p.id, projectName: p.name, title: removed.title }); }
      catch (e) { console.error('[agent] 回收站写入失败:', (e && e.message) || e); }
      p.tasks.splice(idx, 1); db.saveProject(p, ctx.userId);
      return { ok: true, result: { deleted: true, project: p.name, task: removed.title, message: '已删除任务「' + removed.title + '」（可在回收站恢复）' } };
    }
    if (tool === 'delete_project') {
      const p = db.getProject(args.projectId, ctx.userId, canAllRole(ctx.role));
      if (!p) return { ok: false, error: '项目不存在或无权访问' };
      try { db.trashPush(ctx.userId, 'project', p.id, p, { projectId: p.id, projectName: p.name, title: p.name }); }
      catch (e) { console.error('[agent] 回收站写入失败:', (e && e.message) || e); }
      db.deleteProject(p.id, ctx.userId, isManagerRole(ctx.role));
      return { ok: true, result: { deleted: true, project: p.name, message: '已删除项目「' + p.name + '」（可在回收站恢复）' } };
    }
    return { ok: false, error: '未知的待确认操作' };
  }

  /* ---------------- 工具调度（统一入口，含权限与只读校验） ---------------- */
  function executeTool(name, args, ctx) {
    const fn = impl[name];
    if (!fn) return { ok: false, error: '未知工具：' + name };
    // 写工具双闸门：全局只读模式（readonly.flag）或只读访客（viewer）一律拒绝
    if (WRITE_TOOLS.has(name) && ((isReadOnly && isReadOnly()) || ctx.role === 'viewer')) {
      return { ok: false, error: ctx.role === 'viewer' ? '只读访客，无修改权限' : '当前为只读模式，禁止修改数据' };
    }
    try { return fn(args || {}, ctx); }
    catch (e) { return { ok: false, error: '工具执行失败：' + ((e && e.message) || e) }; }
  }

  function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  /* ---------------- System Prompt ---------------- */
  function buildSystem(ctx, textMode) {
    const base = [
      '你是多项目看板（NPI 项目管理）的内置 AI 助手，能查询并操作当前用户的看板数据。',
      '今天是 ' + today() + '。当前用户：' + (ctx.name || '用户') + '（角色 ' + (ctx.role || 'member') + '）。',
      '行为准则：',
      '1. 涉及看板数据的问题必须先调用工具获取真实数据，严禁凭空编造项目名、任务名、进度数字。',
      '2. 用户给的往往是模糊名称（如"音箱项目"），用 get_project / search_tasks 的模糊匹配去查；匹配到多个时反问用户。',
      '3. 删除类工具会返回确认请求，此时如实告诉用户"需要你确认后才会删除"，不要谎称已删除。',
      '4. 回答用简洁中文，直接给结论和关键数据，不要罗列工具返回的原始 JSON。',
      '5. 修改类操作完成后，简要说明改了什么（项目名、任务名、变更项）。',
      '6. 最终回答用 Markdown 结构化排版，便于前端渲染成美观卡片：多条项目/任务信息优先用表格（首行 | 列名 | 列名 |，次行 | --- | --- |），要点用「- 」列表，重要数字用 **加粗**，短结论放开头一句话；不要输出 JSON 或长段散文。'
    ].join('\n');
    if (!textMode) return base;
    // 降级模式：要求模型用固定文本协议输出工具调用
    return base + '\n\n【工具调用协议】你无法使用原生函数调用，必须用严格文本格式。\n' +
      '需要调用工具时，输出且仅输出一行（不要有多余文字）：\n' +
      'TOOL: {"tool":"工具名","args":{...}}\n' +
      '可用工具：list_projects / get_overview / get_project / search_tasks / create_project / add_task / update_task / update_project / delete_task / delete_project\n' +
      '拿到工具结果后，若还需继续调用，再输出一行 TOOL: {...}；若已有足够信息，输出：\n' +
      'ANSWER: 你的最终回答（可用 Markdown 结构化排版：表格 / - 列表 / **加粗**）';
  }

  /* ---------------- 文本降级协议解析 ---------------- */
  const TOOL_RE = /TOOL:\s*(\{[\s\S]*?\})\s*(?=\n|$)/;
  const ANSWER_RE = /ANSWER:\s*([\s\S]*)$/;
  function extractToolCall(text) {
    const m = String(text || '').match(TOOL_RE);
    if (!m) return null;
    try {
      const o = JSON.parse(m[1]);
      if (o && o.tool) return { name: o.tool, arguments: o.args || {} };
    } catch (e) { /* JSON 不合法：忽略，交由模型重试 */ }
    return null;
  }
  function extractAnswer(text) {
    const m = String(text || '').match(ANSWER_RE);
    return m ? m[1].trim() : '';
  }

  /* ---------------- Agent 主循环 ---------------- */
  /**
   * @param {object} opts { cfg, user, message, history, confirmToken, cancelledToken }
   * @returns {object} { text, steps, pending, error }
   */
  async function runAgent(opts) {
    const cfg = opts.cfg || {};
    const user = opts.user || {};
    const ctx = { userId: user.id, role: user.role, name: user.name };
    const steps = [];
    const history = Array.isArray(opts.history) ? opts.history.slice(-10) : [];

    // 命中待确认操作 → 直接落地，并把结果作为上下文继续让模型总结
    if (opts.confirmToken) {
      const p = takePending(opts.confirmToken);
      if (!p) return { text: '该确认请求已失效或已处理，请重新发起。', steps, expired: true };
      if (p.ctx.userId !== ctx.userId) return { text: '确认请求与当前用户不匹配，已取消。', steps };
      const res = commitPending(p.tool, p.args, ctx);
      steps.push({ tool: p.tool, args: p.args, result: res.ok ? res.result : { error: res.error }, committed: true });
      const summary = await chat(cfg, [
        { role: 'system', content: '你是看板助手。用一句话确认刚才的操作结果，简洁中文，不要编造。' },
        { role: 'user', content: '操作结果：' + JSON.stringify(res.ok ? res.result : { error: res.error }) }
      ], {});
      return { text: (summary && summary.content) || (res.ok ? res.result.message || '操作已完成' : ('操作失败：' + res.error)), steps, changed: true };
    }
    if (opts.cancelledToken) {
      const p = pending.get(opts.cancelledToken);
      if (p) { pending.delete(opts.cancelledToken); }
      return { text: '已取消该操作，数据未改动。', steps };
    }

    // 能力探测：先尝试原生 function calling；失败则自动降级文本协议
    let nativeTools = true;
    const messages = [{ role: 'system', content: buildSystem(ctx, false) }];
    history.forEach(h => { if (h && h.role && h.content) messages.push({ role: h.role === 'ai' ? 'assistant' : h.role, content: String(h.content) }); });
    messages.push({ role: 'user', content: String(opts.message || '') });

    let reply = null;
    try {
      reply = await chat(cfg, messages, { tools: TOOLS });
    } catch (e) {
      // 400/404 多为"模型不支持 tools"或端点不认该参数 → 降级
      nativeTools = false;
    }
    if (reply && reply.tool_calls && reply.tool_calls.length) nativeTools = true;
    // 关键：模型未返回原生 tool_calls，却把工具调用写进了文本（TOOL: {...}）→ 判定其不支持 function calling，转文本协议
    else if (reply && reply.content && extractToolCall(reply.content)) nativeTools = false;
    else if (reply && !reply.content) nativeTools = false;

    // 原生 function calling 路径
    if (nativeTools && reply) {
      let cur = reply;
      for (let i = 0; i < MAX_STEPS; i++) {
        if (!cur.tool_calls || !cur.tool_calls.length) {
          return { text: cur.content || buildTextFallback(steps) || '本次模型未返回内容，请换种说法或检查 AI 设置。', steps };
        }
        // 关键：LM Studio 严格要求消息只有 role/content/tool_calls 字段，
        // 不能塞 reasoning/finish_reason/raw 等本地扩展，否则报 "misformatted. Got 'undefined'"
        messages.push({ role: 'assistant', content: cur.content || '', tool_calls: cur.tool_calls });
        for (const tc of cur.tool_calls) {
          const name = tc.function && tc.function.name;
          const args = parseArgs(tc.function && tc.function.arguments);
          const res = executeTool(name, args, ctx);
          if (res.needConfirm) {
            steps.push({ tool: name, args, pending: true, preview: res.preview });
            return { text: '⚠️ 需要你确认：' + (res.preview.action || '危险操作') + '（' + (res.preview.task || res.preview.project || '') + '）。确认后才会执行。', steps, pending: { token: res.token, preview: res.preview } };
          }
          steps.push({ tool: name, args, result: res.ok ? res.result : { error: res.error } });
          let content = res.ok ? JSON.stringify(res.result) : ('执行失败：' + res.error);
          if (content.length > 6000) content = content.slice(0, 6000) + '…（结果已截断）';
          messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
        cur = await chat(cfg, messages, { tools: TOOLS });
      }
      return { text: (cur && cur.content) || buildTextFallback(steps) || '已完成处理。', steps };
    }

    // 文本降级（ReAct）路径
    const tMessages = [{ role: 'system', content: buildSystem(ctx, true) }];
    history.forEach(h => { if (h && h.role && h.content) tMessages.push({ role: h.role === 'ai' ? 'assistant' : h.role, content: String(h.content) }); });
    let userMsg = String(opts.message || '');
    // 复用「能力探测」那次调用的响应作为首轮，避免重复请求一次 LLM（省时省 token）。
    // reasoning 也算"有内容"——许多本地小模型（minicpm、qwen）只填 reasoning_content 而 content 留空。
    let reused = (reply && (reply.content || reply.reasoning)) ? (reply.content || reply.reasoning) : null;
    for (let i = 0; i < MAX_STEPS; i++) {
      let content;
      if (reused !== null) {
        tMessages.push({ role: 'user', content: userMsg });
        content = reused; reused = null;
      } else {
        tMessages.push({ role: 'user', content: userMsg });
        let r = null;
        try { r = await chat(cfg, tMessages, {}); }
        catch (e) { return { text: '', steps, error: 'AI 服务不可用：' + ((e && e.message) || e) }; }
        // 同上：reasoning 兜底
        content = (r && (r.content || r.reasoning)) || '';
      }
      const call = extractToolCall(content);
      if (!call) {
        const ans = extractAnswer(content) || content;
        // 模型没产出 TOOL 也没产出 ANSWER → 用步骤里已收集的工具结果兜底（不抛"AI 未返回内容"）
        const text = (ans || '').trim() || buildTextFallback(steps);
        return { text: text || '本次模型未返回内容，请换种说法或检查 AI 设置。', steps, mode: 'text' };
      }
      const res = executeTool(call.name, call.arguments, ctx);
      if (res.needConfirm) {
        steps.push({ tool: call.name, args: call.arguments, pending: true, preview: res.preview });
        return { text: '⚠️ 需要你确认：' + (res.preview.action || '危险操作') + '（' + (res.preview.task || res.preview.project || '') + '）。确认后才会执行。', steps, pending: { token: res.token, preview: res.preview }, mode: 'text' };
      }
      steps.push({ tool: call.name, args: call.arguments, result: res.ok ? res.result : { error: res.error } });
      let obs = res.ok ? JSON.stringify(res.result) : ('执行失败：' + res.error);
      if (obs.length > 4000) obs = obs.slice(0, 4000) + '…（结果已截断）';
      tMessages.push({ role: 'assistant', content });
      userMsg = '工具结果：' + obs + '\n（如需继续调用工具，输出 TOOL: {...}；已有答案则输出 ANSWER: ...）';
    }
    // 循环耗尽：同样兜底
    return { text: buildTextFallback(steps) || '处理步骤已达上限，请换个更简单的问题。', steps, mode: 'text' };
  }

  /* ---------------- 数据兜底（当模型 content 为空时用工具结果直出） ---------------- */
  // 把已收集的步骤里"成功的只读工具"结果拼成结构化自然语言，避免前端看到"AI 未返回内容"。
  function buildTextFallback(steps) {
    if (!Array.isArray(steps) || !steps.length) return '';
    const lines = [];
    let queried = false;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (!s || !s.tool || !s.result) continue;
      if (s.tool === 'list_projects' && s.result.projects) {
        queried = true;
        const ps = s.result.projects;
        if (!ps.length) { lines.push('你当前没有项目'); break; }
        lines.push('**你共有 ' + ps.length + ' 个项目：**');
        ps.forEach(p => lines.push('- ' + p.name + '（' + (p.total || 0) + ' 任务 / 完成 ' + (p.done || 0) + ' / 进度 ' + (p.progress || 0) + '% / 逾期 ' + (p.overdue || 0) + '）'));
        break;
      }
      if (s.tool === 'get_overview') {
        queried = true;
        const r = s.result;
        lines.push('**全局概览**（' + (r.today || '') + '）：');
        lines.push('- 项目 ' + (r.projectCount || 0) + ' 个，任务共 ' + (r.taskTotal || 0) + '（已完成 ' + (r.taskDone || 0) + '，进度 ' + (r.progress || 0) + '%）');
        if (r.overdueCount) lines.push('- 逾期任务 ' + r.overdueCount + ' 个：' + (r.overdue || []).slice(0, 5).map(t => (t.title || '') + '（' + (t.project || '') + '）').join('；'));
        if (r.thisWeekCount) lines.push('- 本周到期 ' + r.thisWeekCount + ' 个');
        if (r.nextWeekCount) lines.push('- 下周到期 ' + r.nextWeekCount + ' 个');
        break;
      }
      if (s.tool === 'get_project' && s.result.name) {
        queried = true;
        const p = s.result;
        lines.push('**项目「' + p.name + '」**：' + (p.total || 0) + ' 任务 / 完成 ' + (p.done || 0) + ' / 进度 ' + (p.progress || 0) + '% / 逾期 ' + (p.overdue || 0));
        (p.tasks || []).slice(0, 10).forEach(t => lines.push('- ' + (t.done ? '✓ ' : '○ ') + (t.title || '') + '（' + (t.assignee || '未指派') + ' / ' + (t.dueDate || '无截止') + '）'));
        break;
      }
      if (s.tool === 'search_tasks' && Array.isArray(s.result.tasks)) {
        queried = true;
        const ts = s.result.tasks;
        if (!ts.length) { lines.push('没有匹配到任务'); break; }
        lines.push('**匹配到 ' + ts.length + ' 个任务：**');
        ts.slice(0, 15).forEach(t => lines.push('- ' + (t.done ? '✓ ' : '○ ') + (t.title || '') + '（' + (t.project || '') + ' / ' + (t.assignee || '') + ' / 截止 ' + (t.dueDate || '-') + '）'));
        break;
      }
    }
    if (!queried) return ''; // 写操作 / 无可兜底数据 → 不生成文本
    return lines.join('\n');
  }

  return {
    TOOLS, WRITE_TOOLS, DANGER_TOOLS, MAX_STEPS,
    executeTool, runAgent, takePending, buildSystem, buildTextFallback,
    extractToolCall, extractAnswer, resolveProject, projBrief, taskBrief,
    _pending: pending // 仅测试用
  };
};
