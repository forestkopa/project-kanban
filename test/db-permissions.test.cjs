// 数据层权限单元测试（in-memory SQLite，无需起服务）
// 验证「统一数据流」模型：admin/manager/viewer 全量可见+可重排；member 仅自己
const path = require('path');
const db = require(path.join(__dirname, '..', 'db.js'));
const assert = require('assert');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; fails.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name); }
}

db.init(':memory:');

// 种子用户：四角色
const admin = db.createUser('t_admin', '000000', 'admin');
const manager = db.createUser('t_manager', '000000', 'manager');
const member = db.createUser('t_member', '000000', 'member');
const viewer = db.createUser('t_viewer', '000000', 'viewer');

function mkProj(id, ownerId, name) {
  return { id, name, owner_id: ownerId, type: 'C端', level: 'B', status: 'active', phases: [], tasks: [] };
}
db.saveProject(mkProj('p_a1', admin.id, 'A1'), admin.id);
db.saveProject(mkProj('p_a2', admin.id, 'A2'), admin.id);
db.saveProject(mkProj('p_m1', member.id, 'M1'), member.id);

console.log('\n[1] 列表可见性（listProjects）');
ok('admin/manager/viewer(isAdmin=true) 看到全部 3 个', db.listProjects(null, true).length === 3);
ok('admin 以 isAdmin=false 仅看自己 2 个', db.listProjects(admin.id, false).length === 2);
ok('member 仅看自己 1 个', (() => { const r = db.listProjects(member.id, false); return r.length === 1 && r[0].id === 'p_m1'; })());
ok('viewer 以 isAdmin=false 看自己 0 个', db.listProjects(viewer.id, false).length === 0);

console.log('\n[2] 单项目访问（getProject）');
ok('admin(isAdmin) 可取 member 项目', !!db.getProject('p_m1', admin.id, true));
ok('manager(isAdmin) 可取 member 项目', !!db.getProject('p_m1', manager.id, true));
ok('member 可取自己项目', !!db.getProject('p_m1', member.id, false));
ok('member 不可取 admin 项目(返回 null)', db.getProject('p_a1', member.id, false) === null);

console.log('\n[3] 排序写权限（setOrder）—— 核心修复点');
db.setOrder(['p_m1', 'p_a2', 'p_a1'], 'anyone', true);
const full = db.listProjects(null, true);
ok('isAdmin=true 重排全列表生效(成员项目置顶)', full[0].id === 'p_m1' && full.length === 3);
// member 只应改自己项目的 sort，admin 项目 sort 不变
const beforeAdminSort = db.listProjects(admin.id, false).find(p => p.id === 'p_a1').sort;
db.setOrder(['p_a1', 'p_m1', 'p_a2'], member.id, false); // 仅 member 自己可动
const afterMemberOwn = db.listProjects(member.id, false);
ok('member setOrder 仅作用于自己项目(自己项目仍在列表)', afterMemberOwn.length === 1);
const afterAdminSort = db.listProjects(admin.id, false).find(p => p.id === 'p_a1').sort;
ok('member setOrder 不改变 admin 项目 sort(越权被隔离)', beforeAdminSort === afterAdminSort);

console.log('\n[4] 删除权限（deleteProject）');
ok('member 删除他人项目被拒(返回 false)', db.deleteProject('p_a2', member.id, false) === false);
ok('admin(isAdmin) 删除成功(返回 true)', db.deleteProject('p_a2', admin.id, true) === true);
ok('删除后剩余 2 个', db.listProjects(null, true).length === 2);

console.log('\n[5] 按人聚合报告（reportByUser）');
const rep = db.reportByUser();
ok('报告含 admin 与 member 两行', rep.some(r => r.user.name === 't_admin') && rep.some(r => r.user.name === 't_member'));
ok('admin 行 projects>=1', (rep.find(r => r.user.name === 't_admin') || {}).projects >= 1);

console.log('\n========== 数据层测试结果 ==========');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail) { console.log('失败项: ' + fails.join(' | ')); process.exit(1); }
console.log('全部通过 ✅');
