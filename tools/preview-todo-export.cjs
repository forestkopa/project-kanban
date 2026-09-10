// 待办导出格式预览生成器：不启动服务，直接用 lib/xlsx-export.js 的 todoSheet() 造一份样例，
// 供改完导出排版后肉眼比对（含逾期行 / 顺延行 / 无开始日期行，覆盖全部分支）。
// 用法：node tools/preview-todo-export.cjs  →  输出到 %USERPROFILE%\Downloads\kanban\待办格式样例.xlsx
const fs = require('fs');
const XLSXS = require('xlsx-js-style');
const { todoSheet } = require('../lib/xlsx-export.js');

const projects = [
  {
    name: 'UC0305J 降本替代方案',
    tasks: [
      { title: '模具 T0 试模问题点汇总与对策', estimateDays: 3, startDate: '2026-08-31', dueDate: '2026-09-04' }, // 逾期 → 排最前并标红
      { title: '供应商报价核对（三家比价）', estimateDays: 2, startDate: '2026-09-08', dueDate: '2026-09-11' },
      { title: '试产准备会（跨部门）', estimateDays: 1, startDate: '2026-09-09', dueDate: '2026-09-12' }
    ]
  },
  { name: '多项目看板 v1.5.4', tasks: [{ title: '导出排版回归 + 打包发布', estimateDays: 1, startDate: '2026-09-11', dueDate: '2026-09-12' }] },
  {
    name: 'CSPM-4 知识文档',
    tasks: [
      { title: '第 3 章 云资产盘点 重写', estimateDays: 2, startDate: '2026-09-07', dueDate: '2026-09-09' },
      { title: '真题卷 OCR 校对（无开始日期）', estimateDays: 1, startDate: '', dueDate: '2026-09-13' }
    ]
  }
];

const nwProjects = [
  {
    name: 'UC0305J 降本替代方案',
    tasks: [
      { title: '模具 T0 试模问题点汇总与对策', estimateDays: 3, startDate: '2026-08-31', dueDate: '2026-09-11', carryover: true, overdue: true },
      { title: '试产准备会（跨部门）', estimateDays: 1, startDate: '2026-09-15', dueDate: '2026-09-15' }
    ]
  },
  { name: '多项目看板 v1.5.4', tasks: [{ title: '服务器在线升级复核', estimateDays: 1, startDate: '2026-09-16', dueDate: '2026-09-18' }] }
];

const wb = XLSXS.utils.book_new();
const s1 = todoSheet(projects, '2026-09-07', '2026-09-13', 'week');
XLSXS.utils.book_append_sheet(wb, s1.ws, '本周待办（含逾期）');
const s2 = todoSheet(nwProjects, '2026-09-14', '2026-09-20', 'nextweek');
XLSXS.utils.book_append_sheet(wb, s2.ws, '下周待办（含顺延）');

const buf = XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
const out = 'C:/Users/Administrator/Downloads/kanban/待办格式样例.xlsx';
fs.writeFileSync(out, buf);
console.log('OK', out, buf.length, 'bytes');
