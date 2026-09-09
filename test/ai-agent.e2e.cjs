// AI Agent 端到端：起隔离实例 + mock LLM（OpenAI 兼容桩），验证端点接线 / 鉴权 / 工具真实落库 / 删除二次确认
const { startRealInstance, req } = require('./_harness.cjs');
const http = require('http');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// mock LLM：按 mode 决定首次返回哪个 tool_call；见到"工具结果"或最终轮则给文本
function startMockLLM(getMode) {
  const srv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', d => b += d);
    rq.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      const msgs = j.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const isFirst = last.role === 'user' && !/操作结果|工具结果/.test(String(last.content || ''));
      let out;
      if (isFirst) {
        const m = getMode();
        if (m === 'list') out = { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_projects', arguments: '{}' } }] };
        else if (m === 'update') out = { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'update_task', arguments: JSON.stringify({ project_ref: '测试项目', task_ref: '需求评审', done: true }) } }] };
        else if (m === 'delete') out = { content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'delete_project', arguments: JSON.stringify({ project_ref: '测试项目' }) } }] };
        else out = { content: '直接回答' };
      } else out = { content: '好的，已处理完成。' };
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ choices: [{ message: out }] }));
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, close: () => srv.close() })));
}

(async () => {
  const inst = await startRealInstance();
  const { base, token } = inst;
  let mode = 'list';
  const llm = await startMockLLM(() => mode);

  try {
    // 配置 AI 指向 mock（本地模式，无需 Key）
    const cfg = await req(base, 'POST', '/api/ai/config', { base_url: 'http://127.0.0.1:' + llm.port + '/v1', model: 'mock-model', local: true }, token);
    ok('AI 配置写入成功', cfg.status === 200 && cfg.json.configured === true, cfg.json);

    // 造数据
    const pr = await req(base, 'POST', '/api/projects', {
      name: '测试项目',
      phases: [{ id: 'p1', name: '需求立项' }],
      tasks: [{ title: '需求评审', phaseId: 'p1', estimateDays: 2 }, { title: '结构设计', phaseId: 'p1', estimateDays: 3 }]
    }, token);
    ok('测试项目创建成功', pr.status === 201 && pr.json.id, pr.status);
    const pid = pr.json.id;

    // 1) 工具清单
    const tools = await req(base, 'GET', '/api/ai/agent/tools', null, token);
    ok('工具清单返回 10 个', tools.status === 200 && tools.json.tools.length === 10, tools.json && tools.json.tools && tools.json.tools.length);
    const delTool = (tools.json.tools || []).find(t => t.name === 'delete_project');
    ok('delete_project 标记为危险', delTool && delTool.danger === true, delTool);
    const readTool = (tools.json.tools || []).find(t => t.name === 'list_projects');
    ok('list_projects 非写入类', readTool && readTool.write === false);

    // 2) 未登录拒绝
    const noAuth = await req(base, 'POST', '/api/ai/agent', { message: '有几个项目' });
    ok('未登录调用 agent 返回 401', noAuth.status === 401, noAuth.status);

    // 3) 只读查询
    mode = 'list';
    const r1 = await req(base, 'POST', '/api/ai/agent', { message: '我有几个项目？' }, token);
    ok('查询类调用成功', r1.status === 200 && r1.json.ok === true, r1.json);
    ok('返回执行步骤 list_projects', r1.json.steps && r1.json.steps[0] && r1.json.steps[0].tool === 'list_projects', r1.json.steps);
    ok('返回最终文本', /已处理完成/.test(r1.json.text || ''), r1.json.text);
    ok('查询结果含测试项目', JSON.stringify(r1.json.steps[0].result).includes('测试项目'), r1.json.steps[0].result);

    // 4) 写入类：真实落库
    mode = 'update';
    const r2 = await req(base, 'POST', '/api/ai/agent', { message: '把测试项目的需求评审标为完成' }, token);
    ok('写入类调用成功', r2.status === 200, r2.json);
    const after = await req(base, 'GET', '/api/projects/' + pid, null, token);
    const t1 = (after.json.tasks || []).find(t => t.title === '需求评审');
    ok('任务状态真实变更为已完成', t1 && t1.done === true, t1);

    // 5) 删除类：先返回待确认，未落地
    mode = 'delete';
    const r3 = await req(base, 'POST', '/api/ai/agent', { message: '删掉测试项目' }, token);
    ok('删除类返回待确认', r3.status === 200 && r3.json.pending && r3.json.pending.token, r3.json);
    ok('待确认提示文案正确', /需要你确认/.test(r3.json.text || ''), r3.json.text);
    const stillThere = await req(base, 'GET', '/api/projects/' + pid, null, token);
    ok('待确认时项目仍在', stillThere.status === 200, stillThere.status);

    // 6) 取消：项目保留
    const r4 = await req(base, 'POST', '/api/ai/agent', { cancelledToken: r3.json.pending.token }, token);
    ok('取消返回未改动提示', /已取消/.test(r4.json.text || ''), r4.json.text);
    ok('取消后项目仍在', (await req(base, 'GET', '/api/projects/' + pid, null, token)).status === 200);

    // 7) 确认：真正删除并进回收站
    mode = 'delete';
    const r5 = await req(base, 'POST', '/api/ai/agent', { message: '删掉测试项目' }, token);
    const r6 = await req(base, 'POST', '/api/ai/agent', { confirmToken: r5.json.pending.token }, token);
    ok('确认执行成功', r6.status === 200 && r6.json.changed === true, r6.json);
    const gone = await req(base, 'GET', '/api/projects/' + pid, null, token);
    ok('确认后项目已删除', gone.status === 404, gone.status);
    const trash = await req(base, 'GET', '/api/trash', null, token);
    ok('删除进入回收站（可恢复）', trash.status === 200 && (trash.json.items || trash.json || []).length > 0, Object.keys(trash.json || {}));

    // 8) 未配置 AI 时给出明确提示
    await req(base, 'POST', '/api/ai/config', { local: false, clear_key: true }, token);
    const r7 = await req(base, 'POST', '/api/ai/agent', { message: '在吗' }, token);
    ok('未配置 AI 返回 400 提示', r7.status === 400 && /AI 未配置/.test(r7.json.error || ''), r7.json);
  } finally {
    llm.close();
    inst.stop();
  }

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) { console.log('失败项：' + fails.join('; ')); process.exit(1); }
})().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
