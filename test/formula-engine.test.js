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

  // 回归（v1.5.6）：WORKDAY.INTL(x, 1) 的「1」是字面量天数，不能被 normDate 当日期解析。
  // 历史 bug：evalRule 的 lit 分支用 normDate(rule.v)，normDate(1) → new Date('1') → 2001-01-01，
  // 于是推进循环的步数变成 NaN、直接不执行 → 「+1 个工作日」被算成 +0，日期链整体少一天。
  it('lit 字面量天数不被当日期：WORKDAY.INTL(E2,1) 真的后移一个工作日', () => {
    const p = {
      name: 'lit', startDate: '2026-09-11',
      tasks: [
        { id: 'a', excelRow: 2, estimateDays: 6, startDate: '2026-09-11', dueDate: '2026-09-18' },
        {
          id: 'b', excelRow: 3, estimateDays: 4, startDate: '2026-09-18', dueDate: '2026-09-23',
          startRule: parseFormula('=WORKDAY.INTL(E2,1)'), dueRule: parseFormula('=WORKDAY.INTL(D3,F3-1)')
        }
      ]
    };
    assert.equal(recalcProject(p), true);
    assert.equal(p.tasks[1].startDate, '2026-09-21'); // 9/18 周五 → 下一工作日 9/21 周一
    assert.equal(p.tasks[1].dueDate, '2026-09-24');   // 9/21 起 (4-1) 个工作日
  });

  // 回归（v1.5.6）：拓扑推进方向。历史 bug 入度按「被引用次数」统计 → order 逆序 →
  // apply 从最后一个任务倒着算，每个任务读到的是前置的旧日期，改工期不往后级联。
  it('拓扑级联方向：改上游工期后，整条链的 start 都跟着后移', () => {
    const p = {
      name: 'chain', startDate: '2026-09-11',
      tasks: [
        { id: 'a', excelRow: 2, estimateDays: 6, startDate: '2026-09-11', dueDate: '2026-09-18', dueRule: parseFormula('=WORKDAY.INTL(D2,F2-1)') },
        { id: 'b', excelRow: 3, estimateDays: 4, startDate: '2026-09-18', dueDate: '2026-09-24', startRule: parseFormula('=WORKDAY.INTL(E2,1)'), dueRule: parseFormula('=WORKDAY.INTL(D3,F3-1)') },
        { id: 'c', excelRow: 4, estimateDays: 2, startDate: '2026-09-25', dueDate: '2026-09-28', startRule: parseFormula('=WORKDAY.INTL(E3,1)'), dueRule: parseFormula('=WORKDAY.INTL(D4,F4-1)') }
      ]
    };
    recalcProject(p);
    p.tasks[0].estimateDays = 11; // a 工期 +5 个工作日
    recalcProject(p);
    assert.equal(p.tasks[0].dueDate, '2026-09-25');   // 9/11 + 10 个工作日
    assert.equal(p.tasks[1].startDate, '2026-09-28'); // a 截止后的下一个工作日（读到的是**新**值）
    assert.equal(p.tasks[2].startDate, '2026-10-02'); // b 截止 10/1 后的下一个工作日（旧实现会停在旧值）
  });
});
