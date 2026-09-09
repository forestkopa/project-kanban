// AI 对话记录 db 层单测：会话 CRUD、owner 隔离、增量消息、meta(steps)、长度截断、级联删除
// 数据层行为与前端"新增对话记录，可选择可删除"直接对应。
const os = require('os');
const path = require('path');
const dbm = require('../db.js');

const DBF = path.join(os.tmpdir(), 'ai-sess-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.db');
dbm.init(DBF);

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + msg); }
  else { failed++; console.error('  \x1b[31mFAIL\x1b[0m ' + msg); }
}

// 两个用户验证 owner 隔离
const alice = dbm.createUser('alice_sess', 'pw1', 'member');
const bob = dbm.createUser('bob_sess', 'pw2', 'member');

// 1. 创建会话 + 列表
const s1 = dbm.aiCreateSession(alice.id, '第一个对话');
check(!!(s1 && s1.id && s1.title === '第一个对话'), '创建会话返回 id+title');
let list = dbm.aiListSessions(alice.id);
check(list.length === 1 && list[0].msgCount === 0, '列表含新会话 msgCount=0');
check(dbm.aiListSessions(bob.id).length === 0, '他人列表为空（不串数据）');

// 2. 增量追加消息
let r = dbm.aiAppendMessages(alice.id, s1.id, [{ role: 'user', content: '我有几个项目？' }, { role: 'ai', content: '你有 3 个项目。' }]);
check(r && r.added === 2, '追加 user+ai 两条 added=2');
r = dbm.aiAppendMessages(alice.id, s1.id, [{ role: 'ai', content: '### 汇总\n- a\n- b' }]);
check(r && r.added === 1, '再次追加 1 条 added=1');
list = dbm.aiListSessions(alice.id);
check(list[0].msgCount === 3, '列表 msgCount=3（两条+一条）');
check(list[0].title === '第一个对话', '列表标题正确');

// 3. 消息读取顺序 + meta 结构
let msgs = dbm.aiListMessages(alice.id, s1.id);
check(msgs && msgs.length === 3 && msgs[0].role === 'user' && msgs[0].content === '我有几个项目？', '消息按序读取且首条为 user');
check(typeof msgs[0].meta === 'object', '每条消息 meta 为对象（空= {}）');

// 4. meta.steps 存取（前端折叠工具步骤回放依赖）
dbm.aiAppendMessages(alice.id, s1.id, [{ role: 'ai', content: '已改 1 项', meta: { steps: [{ tool: 'update_task', committed: true }] } }]);
msgs = dbm.aiListMessages(alice.id, s1.id);
check(msgs[3].meta && msgs[3].meta.steps && msgs[3].meta.steps[0].tool === 'update_task', 'meta.steps 存取正确（供历史回放）');

// 5. 越权隔离：bob 读/改/删 alice 会话全被拒
check(dbm.aiListMessages(bob.id, s1.id) === null, '他人读消息 → null（404 由路由层返回）');
check(dbm.aiAppendMessages(bob.id, s1.id, [{ role: 'user', content: 'x' }]) === null, '他人追加消息 → null');
check(dbm.aiDeleteSession(bob.id, s1.id) === false, '他人删除 → false');
check(dbm.aiRenameSession(bob.id, s1.id, 'hack') === false, '他人改名 → false');

// 6. 本人改名 + 列表同步
check(dbm.aiRenameSession(alice.id, s1.id, '新标题') === true, '本人改名成功');
list = dbm.aiListSessions(alice.id);
check(list[0].title === '新标题', '改名在列表中生效');
check(dbm.aiRenameSession(alice.id, s1.id, '   ') === false, '空白标题拒绝改名');

// 7. 长度上限：单条消息截断到 20000（防脏数据撑爆库）
dbm.aiAppendMessages(alice.id, s1.id, [{ role: 'ai', content: 'X'.repeat(50000) }]);
msgs = dbm.aiListMessages(alice.id, s1.id);
check(msgs[msgs.length - 1].content.length === 20000, '超长消息截断到 20000 字符');

// 8. 空白 user 消息不入库（用户只按了发送但没内容）
const s2 = dbm.aiCreateSession(alice.id, '空消息会话');
const r2 = dbm.aiAppendMessages(alice.id, s2.id, [{ role: 'user', content: '   ' }, { role: 'ai', content: 'ok' }]);
check(r2.added === 1, '空白 user 消息跳过、ai 消息入库');

// 9. 会话删除级联清消息
check(dbm.aiDeleteSession(alice.id, s1.id) === true, '本人删除成功');
check(dbm.aiListMessages(alice.id, s1.id) === null, '删除后读消息 → null（级联）');
check(dbm.aiListSessions(alice.id).length === 1, '删除后仅剩另一会话');
check(dbm.aiListSessions(bob.id).length === 0, '删除全程未污染他人数据');

console.log(`\nAI 对话记录 db 层: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
