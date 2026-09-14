// 后端 API 集成测试：自起两个隔离实例（均为真实模式 + 独立临时库），零外部依赖
// A 段曾直连本机运行中 5180 → 实例没起/版本不一致/data 被污染就会误报假绿；demo 演示版下线后，
// 统一改为 startRealInstance() 自起临时库实例（KB_DATA_DIR 隔离），测试与本机运行状态彻底解耦。
const fs = require('fs');
const path = require('path');
const { startRealInstance, req } = require('./_harness.cjs');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

async function main() {
  console.log('\n=== A. 隔离实例（临时库 · admin 令牌视角）===');
  let instA = null, createdId = null, originalOrder = null;
  try {
    instA = await startRealInstance();
    const DEMO = instA.base;
    const J = (m, p, b) => req(DEMO, m, p, b, instA.token); // 带 admin 令牌的便捷请求（A 段全部经此，等价于原 demo 免登录）
    console.log('  [i] 隔离实例已启动: ' + DEMO + '（临时库，测试结束销毁）');
    try {
      const ro = await J('GET', '/api/readonly');
      ok('GET /api/readonly → 200 且 on 为布尔', ro.status === 200 && ro.json && typeof ro.json.on === 'boolean', ro.json);

      const opt = await J('GET', '/api/options');
      ok('GET /api/options → 200 且含 productTypes', opt.status === 200 && opt.json && opt.json.productTypes, opt.json);

      const tpl = await J('GET', '/api/templates');
      ok('GET /api/templates → 200 且为数组', tpl.status === 200 && Array.isArray(tpl.json), tpl.json);

      const list0 = await J('GET', '/api/projects');
      ok('GET /api/projects → 200 且为数组', list0.status === 200 && Array.isArray(list0.json), list0.json && list0.json.length);
      originalOrder = list0.json.map(p => p.id);

      const created = await J('POST', '/api/projects', { name: '__test_project__', type: 'C端', level: 'B', startDate: '2026-08-28', phases: [{ id: 'ph1', name: '需求立项' }], tasks: [] });
      ok('POST /api/projects → 201 且返回 id', created.status === 201 && created.json && created.json.id, created.json);
      createdId = created.json.id;

      const got = await J('GET', '/api/projects/' + createdId);
      ok('GET /api/projects/:id → 200', got.status === 200 && got.json && got.json.id === createdId, got.json);

      const upd = await J('PUT', '/api/projects/' + createdId, { name: '__test_project_2__' });
      ok('PUT /api/projects/:id → 200 且名称更新', upd.status === 200 && upd.json && upd.json.name === '__test_project_2__', upd.json);

      const phaseId = (got.json.phases && got.json.phases[0] && got.json.phases[0].id) || '';
      const tk = await J('POST', '/api/projects/' + createdId + '/tasks', { title: '__task__', phaseId, assignee: 'admin' });
      ok('POST /api/projects/:id/tasks → 201 且返回任务', tk.status === 201 && tk.json && tk.json.id, tk.json);
      const tid = tk.json.id;

      const tkUpd = await J('PUT', '/api/projects/' + createdId + '/tasks/' + tid, { done: true });
      ok('PUT 任务 done=true → 200', tkUpd.status === 200 && tkUpd.json && tkUpd.json.done === true, tkUpd.json);

      const tkDel = await J('DELETE', '/api/projects/' + createdId + '/tasks/' + tid);
      ok('DELETE 任务 → 200', tkDel.status === 200, tkDel.status);

      const rep = await J('GET', '/api/report');
      ok('GET /api/report → 200 且为数组(全量)', rep.status === 200 && Array.isArray(rep.json), rep.json);

      const users = await J('GET', '/api/users');
      ok('GET /api/users → 200 且为数组(admin 可见全量)', users.status === 200 && Array.isArray(users.json), users.json);

      // —— 核心修复点：排序端点（manager/admin/viewer canAll）——
      const reversed = [createdId, ...originalOrder.slice().reverse()];
      const ord1 = await J('PUT', '/api/projects/order', { ids: reversed });
      ok('PUT /api/projects/order（含新建项）→ 200', ord1.status === 200, ord1.json);
      const list1 = await J('GET', '/api/projects');
      ok('排序已持久化(新建项置顶)', list1.json[0].id === createdId, list1.json.map(p => p.id));
    } finally {
      // 临时库初始为空时 originalOrder=[]，还原无意义且端点会 400，故仅在非空时还原
      if (originalOrder && originalOrder.length) { const rb = await J('PUT', '/api/projects/order', { ids: originalOrder }); if (rb.status !== 200) console.log('  [warn] 还原排序失败', rb.status); }
      if (createdId) { const d = await J('DELETE', '/api/projects/' + createdId); if (d.status !== 204 && d.status !== 200) console.log('  [warn] 清理测试项目失败', d.status); }
    }
    const verifyList = await J('GET', '/api/projects');
    ok('测试项目已清理(列表不含测试项)', !createdId || !verifyList.json.some(p => p.id === createdId));
  } catch (e) {
    ok('A 实例启动/冒烟', false, String((e && e.message) || e));
  } finally {
    if (instA) instA.stop();
  }

  console.log('\n=== B. 真实版实例（隔离临时库：admin 写操作冒烟 + P1-8 闸门绕过验证）===');
  let inst = null;
  try {
    inst = await startRealInstance();
    const ro2 = await req(inst.base, 'GET', '/api/readonly', null, inst.token);
    ok('B 实例 GET /api/readonly → 200 且 on 为布尔', ro2.status === 200 && ro2.json && typeof ro2.json.on === 'boolean', ro2.json);
    const list2 = await req(inst.base, 'GET', '/api/projects', null, inst.token);
    ok('真实实例 GET /api/projects → 200 且为数组', list2.status === 200 && Array.isArray(list2.json), list2.json);

    // 新→改→排序→删 一轮写操作，验证改密后写操作不再被 MUST_CHANGE_PASSWORD 拦截
    const created = await req(inst.base, 'POST', '/api/projects',
      { name: '__test_real__', type: 'C端', level: 'B', startDate: '2026-08-28', phases: [{ id: 'p1', name: '需求立项' }], tasks: [] }, inst.token);
    ok('真实实例 POST /api/projects → 201 且返回 id', created.status === 201 && created.json && created.json.id, created.json);
    const cid = created.json && created.json.id;
    if (cid) {
      const upd = await req(inst.base, 'PUT', '/api/projects/' + cid, { name: '__test_real_2__' }, inst.token);
      ok('真实实例 PUT 项目 → 200 且名称更新', upd.status === 200 && upd.json && upd.json.name === '__test_real_2__', upd.json);
      const ordR = await req(inst.base, 'PUT', '/api/projects/order', { ids: [cid] }, inst.token);
      ok('真实实例 PUT /api/projects/order（admin 全量重排）→ 200', ordR.status === 200, ordR.json);
      const del = await req(inst.base, 'DELETE', '/api/projects/' + cid, null, inst.token);
      ok('真实实例 DELETE 项目 → 200/204', del.status === 200 || del.status === 204, del.status);
    }
  } catch (e) {
    ok('真实实例启动/冒烟', false, String(e && e.message));
  } finally {
    if (inst) inst.stop();
  }

  console.log('\n========== API 集成测试结果 ==========');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  if (fail) { console.log('失败项: ' + fails.join(' | ')); process.exit(1); }
  console.log('全部通过 ✅');
}
main().catch(e => { console.error('测试异常:', e); process.exit(2); });
