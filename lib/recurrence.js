// 重复任务日期逻辑（P0-4），原 server.js 内联块抽取为纯函数，便于单测（回归防护）
// 2026-08-31：抽到 lib/，server.js 改为 require 调用
const crypto = require('crypto');

const RECUR = ['', 'daily', 'weekly', 'biweekly', 'monthly'];
const RECUR_NAME = { daily: '每天', weekly: '每周', biweekly: '每两周', monthly: '每月' };

// 把 YYYY-MM-DD 按周期前推；monthly 用「同月同日、月末自动收敛」避免 3/31 → 4/31 溢出
function shiftByRecurrence(iso, rec) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return null;
  let y = +m[1], mo = +m[2], d = +m[3];
  if (rec === 'monthly') {
    mo += 1; if (mo > 12) { mo = 1; y += 1; }
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // 目标月最后一天
    if (d > last) d = last;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const days = rec === 'daily' ? 1 : rec === 'weekly' ? 7 : rec === 'biweekly' ? 14 : 0;
  if (!days) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// 由已完成的重复任务派生下一期（继承标题/阶段/负责人/工期，日期整体顺延，公式规则不继承避免级联冲突）
function spawnNextRecurrence(t) {
  const rec = t.recurrence;
  const nextDue = shiftByRecurrence(t.dueDate || t.startDate, rec);
  if (!nextDue) return null;
  const nextStart = t.startDate ? shiftByRecurrence(t.startDate, rec) : null;
  return {
    id: 't_' + crypto.randomBytes(6).toString('hex'),
    title: t.title,
    phaseId: t.phaseId,
    note: t.note || '',
    estimateDays: t.estimateDays || 0,
    assignee: t.assignee || '',
    done: false,
    isMilestone: !!t.isMilestone,
    startDate: nextStart || undefined,
    dueDate: t.dueDate ? nextDue : undefined,
    recurrence: rec
  };
}

module.exports = { RECUR, RECUR_NAME, shiftByRecurrence, spawnNextRecurrence };
