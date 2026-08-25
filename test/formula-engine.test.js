// test/formula-engine.test.js —— 甘特公式引擎单元测试（Node 内置 node:test，零依赖）
// 公式引擎已抽取为独立模块 lib/formula-engine.js（2026-08-25），测试直接 require
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isoDate, addDays, parseFormula, recalcProject } = require('../lib/formula-engine.js');

describe('公式引擎：解析', () => {
  it('parseFormula 解析 =D3+5 → off/arith', () => {
    const r = parseFormula('=D3+5');
    assert.ok(r);
    assert.ok(['off', 'arith'].includes(r.t));
  });
  it('parseFormula 解析 =WORKDAY.INTL(D3,3,11) → wd', () => {
    const r = parseFormula('=WORKDAY.INTL(D3,3,11)');
    assert.equal(r && r.t, 'wd');
    assert.equal(r.weekend, 11);
  });
  it('parseFormula 兼容 =$D$19 绝对引用（单引用解析为 arith[ref D19]）', () => {
    const r = parseFormula('=$D$19');
    assert.ok(r);
    assert.equal(r.t, 'arith');
    assert.equal(r.parts[0].t, 'ref');
    assert.equal(r.parts[0].ref, 'D19');
  });
  it('parseFormula 空输入 → null', () => {
    assert.equal(parseFormula(null), null);
    assert.equal(parseFormula(''), null);
  });
});

describe('公式引擎：日期工具', () => {
  it('isoDate/addDays 基础', () => {
    assert.equal(isoDate(new Date(2026, 7, 25)), '2026-08-25');
    assert.equal(isoDate(addDays(new Date('2026-08-25'), 5)), '2026-08-30');
  });
});

describe('公式引擎：拓扑级联重算', () => {
  it('依赖链：被依赖任务先算（t2 start = t1.start）', () => {
    const p = {
      name: '链', startDate: '2026-08-25', startCell: 'B2',
      tasks: [
        { id: 't1', excelRow: 3, title: '任务1', startDate: '2026-08-25', dueRule: { t: 'off', base: { t: 'ref', ref: 'D3' }, days: 5 } },
        { id: 't2', excelRow: 4, title: '任务2', startRule: { t: 'ref', ref: 'D3' } }
      ]
    };
    assert.equal(recalcProject(p), true);
    assert.equal(p.tasks[0].dueDate, '2026-08-30');
    assert.equal(p.tasks[1].startDate, '2026-08-25'); // 依赖先算
  });

  it('成环：正常终止不死循环', () => {
    const p = {
      name: '环', startDate: '2026-08-25',
      tasks: [
        { id: 't4', excelRow: 6, startRule: { t: 'ref', ref: 'D7' } },
        { id: 't5', excelRow: 7, startRule: { t: 'ref', ref: 'D6' } }
      ]
    };
    const t0 = Date.now();
    const r = recalcProject(p);
    assert.equal(typeof r, 'boolean');
    assert.ok(Date.now() - t0 < 500);
  });

  it('空任务：直接返回 true', () => {
    assert.equal(recalcProject({ name: '空', tasks: [] }), true);
  });
});
