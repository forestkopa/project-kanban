// test/db-report.test.js —— 报告按负责人(assignee)聚合口径测试（Node 内置 node:test + 内存 SQLite）
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

let aliceId, bobId;

before(() => {
  db.init(':memory:');
  const a = db.createUser('alice', 'pass1234', 'member');
  const b = db.createUser('bob', 'pass1234', 'member');
  aliceId = a.id; bobId = b.id;
  // 项目1：owner=alice，任务 assignee=alice → alice
  db.saveProject({
    id: 'p1', name: '项目A', owner_id: aliceId, phases: [{ id: 'ph1', name: '阶段1', color: '#0a84ff' }],
    tasks: [{ id: 't1', title: '任务1', phaseId: 'ph1', assignee: 'alice', done: 1, estimateDays: 2, startDate: '2026-08-01', dueDate: '2026-08-05' }]
  }, aliceId);
  // 项目2：owner=bob，任务 assignee=alice → 按负责人归属 alice；另一任务无负责人 → 回退 owner bob
  db.saveProject({
    id: 'p2', name: '项目B', owner_id: bobId, phases: [{ id: 'ph1', name: '阶段1', color: '#0a84ff' }],
    tasks: [
      { id: 't2', title: '任务2', phaseId: 'ph1', assignee: 'alice', done: 0, estimateDays: 3, startDate: '2026-08-01', dueDate: '2026-08-10' },
      { id: 't3', title: '任务3', phaseId: 'ph1', assignee: '', done: 0, estimateDays: 1, startDate: '2026-08-01', dueDate: '2026-08-03' }
    ]
  }, bobId);
});

describe('报告聚合口径（2026-08-25：按 assignee，空回退 owner）', () => {
  it('alice 按负责人得到 2 个任务（含 bob 项目中的任务2）', () => {
    const rep = db.reportByUser();
    const alice = rep.find(r => r.user.name === 'alice');
    assert.ok(alice);
    assert.equal(alice.projects, 1); // 只有项目1归她拥有
    assert.equal(alice.tasks, 2);    // t1 + t2（t2 按 assignee 归属）
    assert.equal(alice.done, 1);
  });
  it('bob 拥有项目2 且无负责人任务回退 owner', () => {
    const rep = db.reportByUser();
    const bob = rep.find(r => r.user.name === 'bob');
    assert.ok(bob);
    assert.equal(bob.projects, 1);
    assert.equal(bob.tasks, 1);      // 仅 t3（无负责人 → owner）
  });
  it('响应结构与 rate 计算正确', () => {
    const rep = db.reportByUser();
    rep.forEach(r => {
      assert.deepEqual(Object.keys(r).sort(), ['done', 'overdue', 'phases', 'projects', 'rate', 'tasks', 'user']);
      assert.equal(r.rate, r.tasks ? Math.round(r.done / r.tasks * 100) : 0);
    });
  });
});
