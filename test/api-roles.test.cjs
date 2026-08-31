// 角色分级强制测试（隔离真实模式实例）：验证 member 看不到/不能动他人项目，但能管自己
// 使用 test/_harness.cjs 自起独立临时库实例，不触碰项目 data/ 与运行中的 5180/5181
const { startRealInstance, req } = require('./_harness.cjs');
let pass = 0, fail = 0; const fails = [];
function ok(n, c, e) {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + n); }
  else { fail++; fails.push(n); console.log('  \x1b[31mFAIL\x1b[0m ' + n + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); }
}
async function main() {
  const inst = await startRealInstance();
  try {
    const REAL = inst.base;
    const token = inst.token; // admin 令牌（已在 harness 内改密，可写）

    console.log('\n=== C. 角色分级强制（隔离真实实例，live）===');
    const uname = '__t_member_' + Date.now();
    const cu = await req(REAL, 'POST', '/api/users', { name: uname, password: 'P@ssw0rd', role: 'member' }, token);
    ok('admin 创建 member 用户 → 200/201', cu.status === 200 || cu.status === 201, cu.json);
    const lg = await req(REAL, 'POST', '/api/login', { name: uname, password: 'P@ssw0rd' });
    ok('member 登录 → 200 且拿到 token', lg.status === 200 && lg.json && lg.json.token, lg.json);
    const mtok = lg.json.token;

    const alist = await req(REAL, 'GET', '/api/projects', null, token);
    const otherIds = (alist.json || []).map(p => p.id);
    const mlist = await req(REAL, 'GET', '/api/projects', null, mtok);
    ok('member 列表为数组', mlist.status === 200 && Array.isArray(mlist.json), mlist.json);
    ok('member 看不到任何他人项目(列表与 admin 全量无交集)', mlist.json.every(p => !otherIds.includes(p.id)), { member: mlist.json.length, adminTotal: otherIds.length });

    if (otherIds.length) {
      const ord = await req(REAL, 'PUT', '/api/projects/order', { ids: otherIds }, mtok);
      ok('member 重排他人项目 → 400(越权被拒)', ord.status === 400, ord.json);
    } else ok('member 重排他人项目 → 跳过(无他人项目)', true);

    const mk = await req(REAL, 'POST', '/api/projects', { name: '__t_proj__', phases: [{ id: 'p1', name: 'a' }], tasks: [] }, mtok);
    ok('member 可建自己项目 → 201', mk.status === 201, mk.json);
    if (mk.json && mk.json.id) {
      const del = await req(REAL, 'DELETE', '/api/projects/' + mk.json.id, null, mtok);
      ok('member 删自己项目 → 200/204', del.status === 200 || del.status === 204, del.status);
    }

    // 清理测试用户
    const ulist = await req(REAL, 'GET', '/api/users', null, token);
    const u = (ulist.json || []).find(x => x.name === uname);
    if (u) { const du = await req(REAL, 'DELETE', '/api/users/' + u.id, null, token); ok('清理测试 member 用户', du.status === 200 || du.status === 204, du.status); }
  } finally {
    inst.stop();
  }

  console.log('\n========== 角色强制测试结果 ==========');
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail) { console.log('失败项: ' + fails.join(' | ')); process.exit(1); }
  console.log('全部通过 ✅');
}
main().catch(e => { console.error('测试异常:', e); process.exit(2); });
