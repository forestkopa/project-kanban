// AI 对话记录 API 集成测试（真实 HTTP 实例，隔离临时库）：
// 会话 CRUD / 消息追加 / owner 隔离 / viewer 只读闸门 / 404 处理
const { startRealInstance, req, TEST_PW } = require('./_harness.cjs');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const inst = await startRealInstance();
  try {
    const { base, token } = inst;
    // 建一个 member 验证隔离
    const u = await req(base, 'POST', '/api/users', { name: 'ai_sess_member', password: 'Mb@2026x', role: 'member' }, token);
    ok('创建 member 用户 → 200/201', u.status === 200 || u.status === 201, u.json);
    const lg = await req(base, 'POST', '/api/login', { name: 'ai_sess_member', password: 'Mb@2026x' });
    const memberTok = lg.json && lg.json.token;
    ok('member 登录成功', lg.status === 200 && !!memberTok, lg.json);

    // 空列表
    let r = await req(base, 'GET', '/api/ai/sessions', null, token);
    ok('GET /api/ai/sessions → 200 sessions 数组', r.status === 200 && Array.isArray(r.json.sessions), r.json);

    // admin 建会话 + 追加 + 列表
    const c = await req(base, 'POST', '/api/ai/sessions', { title: '我的第一个对话' }, token);
    ok('POST /api/ai/sessions → 返回 id', c.status === 200 && !!c.json.id, c.json);
    const sid = c.json.id;
    const ap = await req(base, 'POST', `/api/ai/sessions/${sid}/messages`, { messages: [{ role: 'user', content: '我有几个项目？' }, { role: 'ai', content: '你有 3 个项目。', meta: { steps: [{ tool: 'list_projects' }] } }] }, token);
    ok('追加消息 → added=2', ap.status === 200 && ap.json.added === 2, ap.json);

    r = await req(base, 'GET', `/api/ai/sessions/${sid}/messages`, null, token);
    ok('读消息 → 2 条且 meta.steps 在', r.status === 200 && r.json.messages.length === 2 && r.json.messages[1].meta.steps, r.json && r.json.messages && r.json.messages[1]);

    r = await req(base, 'GET', '/api/ai/sessions', null, token);
    ok('列表含会话 msgCount=2', r.status === 200 && r.json.sessions.length === 1 && r.json.sessions[0].msgCount === 2, r.json);

    // 改名
    const rn = await req(base, 'PUT', `/api/ai/sessions/${sid}`, { title: '改名后的对话' }, token);
    ok('PUT 改名 → ok', rn.status === 200 && rn.json.ok === true, rn.json);
    r = await req(base, 'GET', '/api/ai/sessions', null, token);
    ok('列表中标题已更新', r.json.sessions[0].title === '改名后的对话', r.json.sessions[0]);

    // owner 隔离：member 看不到 admin 会话，越权读/删/改被拒
    r = await req(base, 'GET', '/api/ai/sessions', null, memberTok);
    ok('member 会话列表为空（不见他人）', r.status === 200 && r.json.sessions.length === 0, r.json);
    r = await req(base, 'GET', `/api/ai/sessions/${sid}/messages`, null, memberTok);
    ok('member 读他人会话消息 → 404', r.status === 404, r.status);
    r = await req(base, 'DELETE', `/api/ai/sessions/${sid}`, null, memberTok);
    ok('member 删他人会话 → 404', r.status === 404, r.status);
    r = await req(base, 'POST', `/api/ai/sessions/${sid}/messages`, { messages: [{ role: 'user', content: '入侵' }] }, memberTok);
    ok('member 追加他人消息 → 404', r.status === 404, r.status);

    // 未登录 → 401
    r = await req(base, 'GET', '/api/ai/sessions');
    ok('未登录访问 → 401', r.status === 401, r.status);

    // viewer 只读闸门：POST 建会话应 403（viewer 一切写操作禁）
    const gv = await req(base, 'POST', '/api/users', { name: 'ai_viewer', password: 'Vw@2026x', role: 'viewer' }, token);
    ok('创建 viewer → 200/201', gv.status === 200 || gv.status === 201, gv.json);
    const vl = await req(base, 'POST', '/api/login', { name: 'ai_viewer', password: 'Vw@2026x' });
    const vTok = vl.json && vl.json.token;
    r = await req(base, 'POST', '/api/ai/sessions', { title: 'viewer 想写' }, vTok);
    ok('viewer 写会话 → 403（只读闸门）', r.status === 403, r.status);
    r = await req(base, 'GET', '/api/ai/sessions', null, vTok);
    ok('viewer 读会话列表 → 200', r.status === 200, r.status);
    // 2026-09-08 修复：AI 总结是纯只读文本生成，不应被 viewer 只读闸门 403 误伤（月报页总结按钮对访客可见）
    r = await req(base, 'POST', '/api/ai/summarize', { projects: [], mode: 'monthly' }, vTok);
    ok('viewer 调 AI 总结不被只读闸门拦（400=未配置/缺数据，非 403）', r.status === 400 && !/只读访客/.test((r.json && r.json.error) || ''), r.status + ' ' + (r.json && r.json.error));

    // 删除会话 → 列表空
    const del = await req(base, 'DELETE', `/api/ai/sessions/${sid}`, null, token);
    ok('admin 删除会话 → ok', del.status === 200 && del.json.ok === true, del.json);
    r = await req(base, 'GET', `/api/ai/sessions/${sid}/messages`, null, token);
    ok('删除后再读消息 → 404', r.status === 404, r.status);
    r = await req(base, 'GET', '/api/ai/sessions', null, token);
    ok('删除后列表为空', r.status === 200 && r.json.sessions.length === 0, r.json);

    // 非法路径
    r = await req(base, 'GET', '/api/ai/sessions/notexist/messages', null, token);
    ok('不存在会话读消息 → 404', r.status === 404, r.status);
  } catch (e) {
    fail++; console.log('  \x1b[31mERROR\x1b[0m ' + (e && e.stack || e));
  } finally {
    inst.stop();
  }
  console.log(`\nAI 对话记录 API: ${pass} 通过, ${fail} 失败`);
  if (fails.length) console.log('失败项：' + fails.join(', '));
  process.exit(fail ? 1 : 0);
})();
