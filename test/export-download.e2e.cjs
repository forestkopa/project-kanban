// 导出下载端到端测试（v1.5.4）：真实隔离实例上验证「计划导出」必须带 token
// 目的：锁死历史 bug —— 前端用裸 <a href> 直链下载（不带 X-Auth-Token）→ 真实版 401 → 点了不下载。
// 这里从服务端契约侧验证：无 token 必 401；带 token 必 200 且返回合法 xlsx（PK 头）+ 文件名响应头。
const { startRealInstance, req } = require('./_harness.cjs');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

async function main() {
  console.log('\n=== 导出下载 e2e（真实隔离实例）===');
  const inst = await startRealInstance();
  try {
    // 建一个带任务的项目，保证导出有内容
    const created = await req(inst.base, 'POST', '/api/projects', {
      name: '__export_test__', type: 'C端', level: 'B', startDate: '2026-09-01',
      phases: [{ id: 'p1', name: '需求立项' }],
      tasks: [{ id: 't1', title: '导出验证任务', phaseId: 'p1', done: false, startDate: '2026-09-01', dueDate: '2026-09-10', estimateDays: 3 }]
    }, inst.token);
    ok('创建测试项目 → 201', created.status === 201 && created.json && created.json.id, created.json);
    const pid = created.json && created.json.id;
    if (!pid) throw new Error('无项目 id，后续断言无法进行');

    // 1) 无 token：必须 401（这正是前端裸直链踩到的坑）
    const noTok = await fetch(inst.base + `/api/projects/${pid}/export?type=latest`);
    ok('无 token 导出 → 401（前端必须带 token）', noTok.status === 401, noTok.status);

    // 2) 带 token：200 + xlsx 二进制 + 文件名头
    const withTok = await fetch(inst.base + `/api/projects/${pid}/export?type=latest`, { headers: { 'X-Auth-Token': inst.token } });
    ok('带 token 导出 → 200', withTok.status === 200, withTok.status);
    const buf = Buffer.from(await withTok.arrayBuffer());
    ok('导出内容是合法 xlsx（PK 头）', buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b, { size: buf.length, head: buf.slice(0, 2).toString() });
    const cd = withTok.headers.get('content-disposition') || '';
    ok('响应带 Content-Disposition 附件头', /attachment/.test(cd) && /filename/.test(cd), cd);
    ok('文件名含 UTF-8 中文名（filename*=UTF-8）', /filename\*=UTF-8''/.test(cd), cd);

    // 3) 三种导出类型都可用（初版 / 差异 / 最新）
    for (const t of ['initial', 'diff', 'latest']) {
      const r = await fetch(inst.base + `/api/projects/${pid}/export?type=${t}`, { headers: { 'X-Auth-Token': inst.token } });
      const b = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
      ok(`导出类型 ${t} → 200 且为 xlsx`, r.status === 200 && b.length > 2 && b[0] === 0x50 && b[1] === 0x4b, { status: r.status, size: b.length });
    }

    // 4) 参考模版导出同样需要 token
    const tplNo = await fetch(inst.base + '/api/templates/reference-xlsx?tplId=x');
    ok('参考模版导出无 token → 401', tplNo.status === 401, tplNo.status);
  } catch (e) {
    ok('导出 e2e 执行未抛异常', false, String((e && e.message) || e));
  } finally {
    inst.stop();
  }

  console.log(`\n断言: ${pass + fail} | 通过: ${pass} | 失败: ${fail}`);
  if (fail) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
  console.log('✓ 导出下载 e2e 全部通过');
}
main();
