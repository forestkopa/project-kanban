// AI Agent 单测：工具权限隔离 / 危险操作二次确认 / 双协议（function calling + 文本降级）
// 用 mock db 注入，不依赖真实 SQLite，也不启动 server。
const createAgent = require('../lib/ai-agent.js');
const FE = require('../lib/formula-engine.js');
const { isoDate, addDays, recalcProject } = FE;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------------- mock 数据层 ---------------- */
const trash = [];
function mkDb(seed) {
  const store = new Map();
  seed.forEach(p => store.set(p.id, { proj: JSON.parse(JSON.stringify(p)), owner: p.owner }));
  return {
    listProjects(userId, canAll) {
      return [...store.values()].filter(x => canAll || x.owner === userId)
        .map(x => JSON.parse(JSON.stringify(x.proj)));
    },
    getProject(pid, userId, canAll) {
      const x = store.get(pid); if (!x) return null;
      if (!canAll && x.owner !== userId) return null;
      return JSON.parse(JSON.stringify(x.proj));
    },
    saveProject(proj, userId) {
      const ex = store.get(proj.id);
      store.set(proj.id, { proj: JSON.parse(JSON.stringify(proj)), owner: ex ? ex.owner : userId });
    },
    deleteProject(pid, userId, isAdmin) {
      const x = store.get(pid); if (!x) return false;
      if (!isAdmin && x.owner !== userId) return false;
      store.delete(pid); return true;
    },
    trashPush(userId, type, id, snap, meta) { trash.push({ userId, type, id, meta }); return 'tr_' + (trash.length); }
  };
}
let seq = 0;
function uid() { return 'id_' + (++seq); }
// 简化排期（与 server.js 语义一致：按阶段顺序累加工期）
function scheduleTasks(phases, tasks, startStr) {
  let cur = new Date(startStr);
  (phases || []).forEach(ph => {
    (tasks || []).filter(t => t.phaseId === ph.id).forEach(t => {
      t.startDate = isoDate(cur);
      const d = Math.max(0, Number(t.estimateDays) || 0);
      t.dueDate = isoDate(addDays(new Date(t.startDate), Math.max(0, d - 1)));
      cur = addDays(new Date(t.dueDate), 1);
    });
  });
}
function canAllRole(r) { return ['admin', 'manager', 'viewer'].includes(r); }
function isManagerRole(r) { return ['admin', 'manager'].includes(r); }

function mkAgent(db, opts) {
  const o = opts || {};
  let ro = !!o.readonly;
  return {
    agent: createAgent({
      db, uid, isoDate, addDays, recalcProject, scheduleTasks,
      PHASE_COLORS: ['#8b5cf6', '#0a84ff', '#30d158'],
      canAllRole, isManagerRole,
      chat: o.chat || (async () => ({ content: '默认回答' })),
      isReadOnly: () => ro
    }),
    setRO: v => { ro = !!v; }
  };
}

/* ---------------- 种子数据 ---------------- */
// 相对日期工具：D(-3)=今天往前 3 天的 'YYYY-MM-DD'。
// 注意：截止日一律用相对日期，避免硬编码日期随时间漂移导致"逾期数"断言某天突然失败（2026-09-09 踩过）。
// addDays 返回 Date 对象，必须再套 isoDate() 才是字符串。
const _T0 = new Date();
const D = n => isoDate(addDays(_T0, n));

function seedData() {
  return [
    {
      id: 'pA', owner: 'uA', name: '智能音箱项目', status: 'active', startDate: '2026-09-01',
      phases: [{ id: 'p1', name: '需求立项' }, { id: 'p2', name: '设计开发' }],
      tasks: [
        { id: 't1', title: '需求评审', phaseId: 'p1', assignee: '张工', estimateDays: 3, done: true, startDate: '2026-09-01', dueDate: '2026-09-03' },
        { id: 't2', title: '结构打样', phaseId: 'p2', assignee: '李工', estimateDays: 5, done: false, startDate: D(-2), dueDate: D(3) }, // 进行中·未到期
        { id: 't3', title: '固件联调', phaseId: 'p2', assignee: '张工', estimateDays: 2, done: false, startDate: D(-5), dueDate: D(-3) } // 故意设为过去 → 逾期（唯一逾期项）
      ]
    },
    { id: 'pB', owner: 'uB', name: '门锁项目', status: 'active', startDate: '2026-09-01', phases: [{ id: 'p1', name: '需求立项' }], tasks: [{ id: 't9', title: '别人家的任务', phaseId: 'p1', assignee: '王工', estimateDays: 1, done: false, startDate: D(-8), dueDate: D(-7) }] }
  ];
}

(async () => {
  /* ================= 1. 工具集定义 ================= */
  const db0 = mkDb(seedData());
  const A0 = mkAgent(db0);
  const ag0 = A0.agent;
  ok('工具共 10 个', ag0.TOOLS.length === 10, ag0.TOOLS.length);
  ok('写工具 6 个', ag0.WRITE_TOOLS.size === 6, [...ag0.WRITE_TOOLS]);
  ok('危险工具为 delete_task/delete_project', ag0.DANGER_TOOLS.has('delete_task') && ag0.DANGER_TOOLS.has('delete_project'));
  ok('每个工具都有 description', ag0.TOOLS.every(t => t.function.description && t.function.name));

  /* ================= 2. 权限隔离（核心红线） ================= */
  const ctxA = { userId: 'uA', role: 'member', name: '高攀' };
  const r1 = ag0.executeTool('list_projects', {}, ctxA);
  ok('member 只见自己的项目', r1.ok && r1.result.count === 1 && r1.result.projects[0].name === '智能音箱项目', r1.result && r1.result.projects);

  const ctxAdmin = { userId: 'uAdmin', role: 'admin', name: '管理员' };
  const r2 = ag0.executeTool('list_projects', {}, ctxAdmin);
  ok('admin 可见全部项目', r2.ok && r2.result.count === 2, r2.result && r2.result.count);

  const r3 = ag0.executeTool('get_project', { project_ref: '门锁项目' }, ctxA);
  ok('member 越权访问他人项目被拒', !r3.ok && /未找到项目/.test(r3.error), r3.error);

  const r4 = ag0.executeTool('update_task', { project_ref: '门锁项目', task_ref: '别人家的任务', done: true }, ctxA);
  ok('member 越权改他人任务被拒', !r4.ok, r4.error);

  const r5 = ag0.executeTool('get_project', { project_ref: '门锁项目' }, ctxAdmin);
  ok('admin 可查看他人项目', r5.ok && r5.result.name === '门锁项目', r5.error);

  /* ================= 3. 只读查询工具 ================= */
  const ov = ag0.executeTool('get_overview', {}, ctxA);
  ok('get_overview 统计逾期任务', ov.ok && ov.result.overdueCount === 1, ov.result && ov.result.overdueCount);
  const gp = ag0.executeTool('get_project', { project_ref: '音箱' }, ctxA);
  ok('get_project 支持名称模糊匹配', gp.ok && gp.result.name === '智能音箱项目', gp.error);
  ok('get_project 返回阶段与任务', gp.ok && gp.result.tasks.length === 3 && gp.result.phases.length === 2);
  ok('任务标记 overdue 正确', gp.ok && gp.result.tasks.find(t => t.id === 't3').overdue === true);

  const st = ag0.executeTool('search_tasks', { assignee: '张工' }, ctxA);
  ok('search_tasks 按负责人筛选', st.ok && st.result.count === 2, st.result && st.result.count);
  const st2 = ag0.executeTool('search_tasks', { done: false }, ctxA);
  ok('search_tasks 按未完成筛选', st2.ok && st2.result.count === 2, st2.result && st2.result.count);
  const st3 = ag0.executeTool('search_tasks', { overdue_only: true }, ctxA);
  ok('search_tasks 只看逾期', st3.ok && st3.result.count === 1, st3.result && st3.result.count);

  /* ================= 4. 写入工具 ================= */
  const db1 = mkDb(seedData());
  const A1 = mkAgent(db1); const ag1 = A1.agent;
  const up = ag1.executeTool('update_task', { project_ref: '音箱', task_ref: '结构打样', assignee: '赵工', done: true }, ctxA);
  ok('update_task 修改成功', up.ok && up.result.changed === true, up.error || up.result);
  ok('update_task 变更项含负责人与完成', up.ok && up.result.changes.includes('负责人') && up.result.changes.join().includes('完成'), up.result && up.result.changes);
  const after = db1.getProject('pA', 'uA', false);
  const t2 = after.tasks.find(t => t.id === 't2');
  ok('update_task 已落库（负责人=赵工）', t2.assignee === '赵工', t2.assignee);
  ok('update_task 已落库（done=true）', t2.done === true);

  const add = ag1.executeTool('add_task', { project_ref: 'pA', title: '包装设计', phase: '设计开发', assignee: '孙工', estimate_days: 4 }, ctxA);
  ok('add_task 新增成功', add.ok && add.result.created === true, add.error);
  ok('add_task 后任务数 +1', db1.getProject('pA', 'uA', false).tasks.length === 4);

  const cp = ag1.executeTool('create_project', {
    name: '智能门锁降本项目', start_date: '2026-09-10',
    tasks: [
      { title: '立项评审', phase: '需求立项', estimate_days: 2, assignee: '张工' },
      { title: '结构降本', phase: '设计开发', estimate_days: 5, assignee: '李工' }
    ]
  }, ctxA);
  ok('create_project 创建成功', cp.ok && cp.result.created === true && cp.result.taskCount === 2, cp.error || cp.result);
  const newProj = db1.listProjects('uA', false).find(p => p.name === '智能门锁降本项目');
  ok('create_project 已落库', !!newProj);
  ok('create_project 自动排期（首个任务 startDate=项目开始日）', newProj && newProj.tasks[0].startDate === '2026-09-10', newProj && newProj.tasks[0].startDate);
  ok('create_project 阶段已生成', newProj && newProj.phases.length === 2, newProj && newProj.phases.map(p => p.name));

  /* ================= 5. 只读模式拦截写入 ================= */
  A1.setRO(true);
  const roRes = ag1.executeTool('add_task', { project_ref: 'pA', title: '不该被创建' }, ctxA);
  ok('只读模式拒绝写入', !roRes.ok && /只读模式/.test(roRes.error), roRes.error);
  const roRead = ag1.executeTool('list_projects', {}, ctxA);
  ok('只读模式仍允许查询', roRead.ok);
  A1.setRO(false);

  /* ================= 5b. viewer（只读访客）角色拦截写入 ================= */
  const dbV = mkDb(seedData());
  const AV = mkAgent(dbV); const agV = AV.agent;
  const ctxViewer = { userId: 'uA', role: 'viewer', name: '访客' };
  const vw1 = agV.executeTool('update_task', { project_ref: '音箱', task_ref: '结构打样', done: true }, ctxViewer);
  ok('viewer 写入被拒', !vw1.ok && /只读访客/.test(vw1.error), vw1.error);
  const vw2 = agV.executeTool('delete_project', { project_ref: '音箱' }, ctxViewer);
  ok('viewer 危险操作同样被拒', !vw2.ok && /只读访客/.test(vw2.error), vw2.error);
  const vw3 = agV.executeTool('list_projects', {}, ctxViewer);
  ok('viewer 仍可查询（canAll 全量只读）', vw3.ok && vw3.result.count === 2, vw3.error);
  const vw4 = agV.executeTool('get_overview', {}, ctxViewer);
  ok('viewer 仍可看全局概览', vw4.ok, vw4.error);
  ok('viewer 写入未落库', dbV.getProject('pA', 'uA', false).tasks.find(t => t.id === 't2').done === false, '任务仍为未完成');

  /* ================= 6. 危险操作需二次确认 ================= */
  const db2 = mkDb(seedData());
  const A2 = mkAgent(db2); const ag2 = A2.agent;
  const del = ag2.executeTool('delete_task', { project_ref: '音箱', task_ref: '结构打样' }, ctxA);
  ok('delete_task 返回待确认', del.ok && del.needConfirm === true && !!del.token, del);
  ok('delete_task 预览含项目与任务', del.needConfirm && del.preview.project === '智能音箱项目' && del.preview.task === '结构打样', del.preview);
  ok('待确认时数据未被改动', db2.getProject('pA', 'uA', false).tasks.length === 3);

  const delP = ag2.executeTool('delete_project', { project_ref: '音箱' }, ctxA);
  ok('delete_project 返回待确认', delP.ok && delP.needConfirm === true && !!delP.token, delP);
  ok('待确认时项目仍在', !!db2.getProject('pA', 'uA', false));

  // 确认执行
  trash.length = 0;
  const conf = await ag2.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, confirmToken: del.token, chat: null });
  ok('确认后任务被删除', db2.getProject('pA', 'uA', false).tasks.length === 2, db2.getProject('pA', 'uA', false).tasks.length);
  ok('删除进回收站（可恢复）', trash.length === 1 && trash[0].type === 'task', trash);
  ok('确认执行后返回变更标记', conf.changed === true);

  // 取消
  const cancel = await ag2.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, cancelledToken: delP.token });
  ok('取消后项目未被删', !!db2.getProject('pA', 'uA', false));
  ok('取消返回未改动提示', /已取消/.test(cancel.text), cancel.text);

  // 跨用户确认应被拒
  const A3 = mkAgent(mkDb(seedData())); const ag3 = A3.agent;
  const del2 = ag3.executeTool('delete_project', { project_ref: '音箱' }, ctxA);
  const wrongUser = await ag3.runAgent({ cfg: {}, user: { id: 'uB', role: 'member', name: '别人' }, confirmToken: del2.token });
  ok('他人确认 token 被拒', /不匹配/.test(wrongUser.text), wrongUser.text);

  // 过期/无效 token
  const bogus = await ag3.runAgent({ cfg: {}, user: { id: 'uA', role: 'member' }, confirmToken: 'cf_不存在' });
  ok('无效 token 提示失效', /失效|已处理/.test(bogus.text), bogus.text);

  /* ================= 7. 文本降级协议解析 ================= */
  ok('extractToolCall 解析 TOOL 行', !!ag3.extractToolCall('思考：先查项目\nTOOL: {"tool":"list_projects","args":{}}\n'));
  const parsed = ag3.extractToolCall('TOOL: {"tool":"update_task","args":{"project_ref":"音箱","done":true}}');
  ok('extractToolCall 解析参数', parsed && parsed.name === 'update_task' && parsed.arguments.done === true, parsed);
  ok('无 TOOL 行返回 null', ag3.extractToolCall('这是一句普通回答') === null);
  ok('非法 JSON 返回 null', ag3.extractToolCall('TOOL: {不是json}') === null);
  ok('extractAnswer 提取最终答复', ag3.extractAnswer('ANSWER: 共有 2 个项目') === '共有 2 个项目');
  ok('buildSystem 文本模式含协议说明', /TOOL:/.test(ag3.buildSystem({ name: 'x', role: 'member' }, true)));
  ok('buildSystem 原生模式不含协议说明', !/TOOL:/.test(ag3.buildSystem({ name: 'x', role: 'member' }, false)));

  /* ================= 8. runAgent 原生 function calling 路径 ================= */
  const db4 = mkDb(seedData());
  let call = 0;
  const chatNative = async (cfg, msgs, opts) => {
    call++;
    if (call === 1) {
      ok('首次调用带 tools 参数', opts && opts.tools && opts.tools.length === 10);
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'list_projects', arguments: '{}' } }] };
    }
    // 第二次：模型看到工具结果后给出最终答复
    const hasToolMsg = msgs.some(m => m.role === 'tool');
    ok('工具结果已回喂模型', hasToolMsg);
    return { content: '你有 1 个项目：智能音箱项目（进度 33%）' };
  };
  const A4 = mkAgent(db4, { chat: chatNative }); const ag4 = A4.agent;
  const out4 = await ag4.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, message: '我有几个项目？' });
  ok('原生路径返回最终文本', /智能音箱项目/.test(out4.text), out4.text);
  ok('原生路径记录 1 个工具步骤', out4.steps.length === 1 && out4.steps[0].tool === 'list_projects', out4.steps);

  /* ================= 9. runAgent 文本降级路径 ================= */
  const db5 = mkDb(seedData());
  let tcall = 0;
  const chatText = async (cfg, msgs, opts) => {
    tcall++;
    if (tcall === 1) return { content: '我先查一下项目列表\nTOOL: {"tool":"list_projects","args":{}}' };
    return { content: 'ANSWER: 你有 1 个项目：智能音箱项目' };
  };
  const A5 = mkAgent(db5, { chat: chatText }); const ag5 = A5.agent;
  const out5 = await ag5.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, message: '我有几个项目？' });
  ok('降级路径返回最终答复', /智能音箱项目/.test(out5.text), out5.text);
  ok('降级路径执行了工具', out5.steps.length === 1 && out5.steps[0].tool === 'list_projects', out5.steps);
  ok('降级路径标记为 text 模式', out5.mode === 'text', out5.mode);

  /* ================= 10. 降级路径下的危险操作 ================= */
  const db6 = mkDb(seedData());
  let dcall = 0;
  const chatDanger = async () => {
    dcall++;
    return { content: 'TOOL: {"tool":"delete_project","args":{"project_ref":"音箱"}}' };
  };
  const A6 = mkAgent(db6, { chat: chatDanger }); const ag6 = A6.agent;
  const out6 = await ag6.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, message: '删掉音箱项目' });
  ok('降级路径删除需确认', !!out6.pending && !!out6.pending.token, out6);
  ok('降级路径提示需确认', /需要你确认/.test(out6.text), out6.text);
  ok('降级路径未真删', !!db6.getProject('pA', 'uA', false));

  /* ================= 11. 循环上限保护 ================= */
  const db7 = mkDb(seedData());
  let lcall = 0;
  // 第二轮后模型给空 content → 期望走兜底逻辑展示工具结果（升级：以前直接返"步骤已达上限"）
  const chatLoop = async () => {
    lcall++;
    if (lcall === 1) return { content: 'TOOL: {"tool":"list_projects","args":{}}' };
    return { content: '', reasoning: '' };
  };
  const A7 = mkAgent(db7, { chat: chatLoop }); const ag7 = A7.agent;
  const out7 = await ag7.runAgent({ cfg: {}, user: { id: 'uA', role: 'member' }, message: '一直查' });
  ok('循环达上限后安全退出', out7.steps.length <= ag7.MAX_STEPS && (/步骤已达上限|智能音箱项目/.test(out7.text)), out7.text);
  ok('循环不超过 MAX_STEPS', out7.steps.length <= ag7.MAX_STEPS, out7.steps.length);

  /* ================= 12. 本地小模型场景：content="" + reasoning 有内容（minicpm5-2b 实测表现） ================= */
  const db8 = mkDb(seedData());
  const chatLM = async () => ({ content: '', reasoning: '好的用户问有几个项目。让我调用 list_projects 工具。\nTOOL: {"tool":"list_projects","args":{}}\n', finish_reason: 'length' });
  const A8 = mkAgent(db8, { chat: chatLM }); const ag8 = A8.agent;
  const out8 = await ag8.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, message: '我有几个项目？' });
  ok('本地小模型：content 空但 reasoning 有内容也能走降级', /智能音箱项目/.test(out8.text), out8.text);
  ok('本地小模型：执行了 list_projects 工具', out8.steps.some(s => s.tool === 'list_projects'), out8.steps.map(s => s.tool));
  ok('本地小模型：模式标记为 text', out8.mode === 'text');

  /* ================= 13. 双空场景：content="" + reasoning="" 但工工具结果存在（finish_reason=length 截断） ================= */
  const db9 = mkDb(seedData());
  let ecall = 0;
  const chatEmpty = async () => {
    ecall++;
    if (ecall === 1) return { content: 'TOOL: {"tool":"list_projects","args":{}}', reasoning: '' };
    return { content: '', reasoning: '', finish_reason: 'length' };
  };
  const A9 = mkAgent(db9, { chat: chatEmpty }); const ag9 = A9.agent;
  const out9 = await ag9.runAgent({ cfg: {}, user: { id: 'uA', role: 'member', name: '高攀' }, message: '我有几个项目？' });
  ok('双空场景不抛"AI 未返回内容"原始错误', !/AI 未返回内容/.test(out9.text || ''), out9.text);
  ok('双空场景基于工具结果生成结构化兜底', /智能音箱项目/.test(out9.text), out9.text);
  ok('双空场景无 error 字段', !out9.error);

  /* ================= 14. 原生路径 content 空但工具调用成功（兜底链路） ================= */
  const db10 = mkDb(seedData());
  let ncall = 0;
  const chatNativeEmpty = async (cfg, msgs, opts) => {
    ncall++;
    if (ncall === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'list_projects', arguments: '{}' } }], reasoning: '调用工具' };
    return { content: '', reasoning: '', finish_reason: 'stop' }; // 模型第二轮依旧空
  };
  const A10 = mkAgent(db10, { chat: chatNativeEmpty }); const ag10 = A10.agent;
  const out10 = await ag10.runAgent({ cfg: {}, user: { id: 'uA', role: 'member' }, message: '我有几个项目？' });
  ok('原生路径 content 空时走兜底而非返回空', /智能音箱项目/.test(out10.text), out10.text);

  /* ================= 14b. 原生路径 messages 格式严格（LM Studio 拒收扩展字段） ================= */
  const db14 = mkDb(seedData());
  let mcall = 0;
  const capturedMsgs = [];
  const chatFormatCheck = async (cfg, msgs, opts) => {
    mcall++;
    capturedMsgs[mcall] = msgs.map(m => Object.keys(m).sort()); // 记录每轮推给 LLM 的消息字段
    if (mcall === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'list_projects', arguments: '{}' } }], reasoning: 'thinking', finish_reason: 'tool_calls', raw: { x: 1 } };
    return { content: '查询完毕：智能音箱项目' };
  };
  const A14 = mkAgent(db14, { chat: chatFormatCheck }); const ag14 = A14.agent;
  const out14 = await ag14.runAgent({ cfg: {}, user: { id: 'uA', role: 'member' }, message: '我有几个项目？' });
  // 第二轮 messages 必须不包含 reasoning/finish_reason/raw 等本地扩展字段（LM Studio 会拒收报 400）
  const lastRound = capturedMsgs[mcall];
  const hasLeak = lastRound && lastRound.some(keys => keys.some(k => ['reasoning', 'finish_reason', 'raw', 'message'].includes(k)));
  ok('原生路径 messages 不含 reasoning/finish_reason/raw 扩展字段（防 LM Studio 400）', !hasLeak, hasLeak ? 'leak=' + JSON.stringify(lastRound) : '');
  ok('原生路径 messages 至少有 assistant + tool', lastRound.some(k => k.includes('role') && k.includes('content')), lastRound);
  ok('原生路径第二轮 content 正常返回', /智能音箱项目/.test(out14.text), out14.text);

  /* ================= 15. get_overview 双空场景兜底 ================= */
  const db11 = mkDb(seedData());
  let gcall = 0;
  const chatOverview = async () => {
    gcall++;
    if (gcall === 1) return { content: 'TOOL: {"tool":"get_overview","args":{}}' };
    return { content: '', reasoning: '' };
  };
  const A11 = mkAgent(db11, { chat: chatOverview }); const ag11 = A11.agent;
  const out11 = await ag11.runAgent({ cfg: {}, user: { id: 'uA', role: 'member' }, message: '本周有什么到期？' });
  ok('get_overview 双空兜底含概览数据', /全局概览|本周|逾期/.test(out11.text), out11.text);

  /* ================= 16. buildTextFallback 单元测试 ================= */
  const A0_2 = mkAgent(mkDb(seedData())); const ag0_2 = A0_2.agent;
  ok('buildTextFallback 空 steps 返回空串', ag0_2.buildTextFallback([]) === '');
  ok('buildTextFallback list_projects 兜底含项目数据', /测试项目/.test(ag0_2.buildTextFallback([{ tool: 'list_projects', result: { projects: [{ name: '测试项目', total: 3, done: 1, progress: 33, overdue: 0 }] } }])));
  ok('buildTextFallback get_overview 兜底', /全局概览/.test(ag0_2.buildTextFallback([{ tool: 'get_overview', result: { today: '2026-09-08', projectCount: 1, taskTotal: 3, taskDone: 1, progress: 33, overdueCount: 0, thisWeekCount: 0, nextWeekCount: 0 } }])));
  ok('buildTextFallback search_tasks 兜底', /匹配到/.test(ag0_2.buildTextFallback([{ tool: 'search_tasks', result: { count: 1, tasks: [{ title: 'A', project: 'X', assignee: '', dueDate: '-' }] } }])));

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) { console.log('失败项：' + fails.join('; ')); process.exit(1); }
})();
