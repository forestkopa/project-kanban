// =========================================================
// db.js —— SQLite 数据层（Node 内置 node:sqlite，零外部依赖）
// 表：users / tokens / projects / phases / tasks
// 设计要点：
//  1) 项目以"单项目粒度"保存（事务内重写该项目 phases/tasks），
//     多用户并发编辑不同项目互不覆盖；
//  2) 项目对象往返组回 server.js 原有结构 {phases,tasks,baseline,...}，
//     现有 API / 前端无需感知存储变化；
//  3) baseline 为任务快照 JSON 列，engineers 同。
// =========================================================
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let db = null;
let DB_FILE = '';

function init(file) {
  DB_FILE = file;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      template_id TEXT, icon TEXT, color TEXT,
      type TEXT DEFAULT 'C端', level TEXT DEFAULT 'B',
      product_type TEXT DEFAULT '', cert TEXT DEFAULT '',
      status TEXT DEFAULT 'active', completed_at TEXT,
      engineers_json TEXT DEFAULT '{}',
      start_date TEXT, start_cell TEXT,
      baseline_json TEXT,
      sort INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phases (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#0a84ff',
      seq INTEGER DEFAULT 0,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      phase_id TEXT,
      note TEXT DEFAULT '',
      estimate_days INTEGER DEFAULT 0,
      assignee TEXT DEFAULT '',
      done INTEGER DEFAULT 0,
      is_milestone INTEGER DEFAULT 0,
      start_date TEXT, due_date TEXT,
      excel_row INTEGER, start_f TEXT, due_f TEXT,
      start_rule_json TEXT, due_rule_json TEXT,
      seq INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, sort);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  `);
}

/* ---------------- 密码与用户 ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const t = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(t, 'hex'), Buffer.from(h, 'hex'));
}
function randomPassword(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < (len || 12); i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
const DEFAULT_PASSWORD = '000000'; // 默认初始密码（admin / 新建用户 / guest 游客）
function createUser(name, password, role) {
  const id = 'u_' + crypto.randomBytes(8).toString('hex');
  const plain = password || DEFAULT_PASSWORD;
  db.prepare('INSERT INTO users (id,name,role,pass_hash,created_at) VALUES (?,?,?,?,?)')
    .run(id, name, role || 'member', hashPassword(plain), new Date().toISOString());
  return { id, name, role: role || 'member' };
}
function listUsers() { return db.prepare('SELECT id,name,role,created_at FROM users ORDER BY created_at').all(); }
function getUserByName(name) { return db.prepare('SELECT * FROM users WHERE name=?').get(name); }
function getUserById(id) { return db.prepare('SELECT id,name,role FROM users WHERE id=?').get(id); }
function verifyUser(name, password) {
  const u = getUserByName(name);
  if (!u || !verifyPassword(password, u.pass_hash)) return null;
  return { id: u.id, name: u.name, role: u.role };
}
// 自助改密：校验旧密码后更新（返回错误原因或 null）
function changePassword(userId, oldPw, newPw) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return '用户不存在';
  if (!verifyPassword(oldPw, u.pass_hash)) return '旧密码错误';
  if (String(newPw || '').length < 6) return '新密码至少 6 位';
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(newPw), userId);
  return null;
}
// 管理员重置任意用户密码（不校验旧密码）
function resetPassword(userId, newPw) {
  if (String(newPw || '').length < 6) return '密码至少 6 位';
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(newPw), userId);
  return null;
}

/* ---------------- token（每用户单 token） ---------------- */
function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM tokens WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO tokens (token,user_id,created_at) VALUES (?,?,?)').run(token, userId, new Date().toISOString());
  return token;
}
function tokenUserId(token) {
  const r = db.prepare('SELECT user_id FROM tokens WHERE token=?').get(String(token || ''));
  return r ? r.user_id : null;
}

/* ---------------- 项目（单项目粒度保存） ---------------- */
function rowToProj(r) {
  const phases = db.prepare('SELECT * FROM phases WHERE project_id=? ORDER BY seq').all(r.id)
    .map(p => ({ id: p.id, name: p.name, color: p.color }));
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY seq').all(r.id).map(t => ({
    id: t.id, title: t.title, phaseId: t.phase_id, note: t.note, estimateDays: t.estimate_days,
    assignee: t.assignee, done: !!t.done, isMilestone: !!t.is_milestone,
    startDate: t.start_date, dueDate: t.due_date,
    excelRow: t.excel_row ?? undefined, startF: t.start_f ?? undefined, dueF: t.due_f ?? undefined,
    startRule: t.start_rule_json ? JSON.parse(t.start_rule_json) : undefined,
    dueRule: t.due_rule_json ? JSON.parse(t.due_rule_json) : undefined
  }));
  return {
    id: r.id, name: r.name, templateId: r.template_id, icon: r.icon, color: r.color,
    type: r.type, level: r.level, productType: r.product_type, cert: r.cert,
    status: r.status, completedAt: r.completed_at,
    engineers: r.engineers_json ? JSON.parse(r.engineers_json) : {},
    startDate: r.start_date, startCell: r.start_cell, createdAt: r.created_at, sort: r.sort,
    phases, tasks, baseline: r.baseline_json ? JSON.parse(r.baseline_json) : null
  };
}
function saveProject(proj, userId) {
  if (!proj || !proj.id) throw new Error('项目无效');
  if (!userId) throw new Error('缺少归属用户');
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO projects (id,owner_id,name,template_id,icon,color,type,level,product_type,cert,status,completed_at,engineers_json,start_date,start_cell,baseline_json,sort,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id=excluded.owner_id, name=excluded.name, template_id=excluded.template_id, icon=excluded.icon,
        color=excluded.color, type=excluded.type, level=excluded.level, product_type=excluded.product_type,
        cert=excluded.cert, status=excluded.status, completed_at=excluded.completed_at,
        engineers_json=excluded.engineers_json, start_date=excluded.start_date, start_cell=excluded.start_cell,
        baseline_json=excluded.baseline_json, sort=excluded.sort, created_at=excluded.created_at`)
      .run(proj.id, userId, proj.name || '未命名项目', proj.templateId || null, proj.icon || '', proj.color || '#0a84ff',
        proj.type || 'C端', proj.level || 'B', proj.productType || '', proj.cert || '', proj.status || 'active',
        proj.completedAt ?? null, JSON.stringify(proj.engineers || {}), proj.startDate || null, proj.startCell || null,
        proj.baseline ? JSON.stringify(proj.baseline) : null, proj.sort || 0, proj.createdAt || new Date().toISOString());
    db.prepare('DELETE FROM phases WHERE project_id=?').run(proj.id);
    db.prepare('DELETE FROM tasks WHERE project_id=?').run(proj.id);
    (proj.phases || []).forEach((ph, i) => db.prepare('INSERT INTO phases (project_id,id,name,color,seq) VALUES (?,?,?,?,?)')
      .run(proj.id, ph.id, ph.name || ('阶段' + (i + 1)), ph.color || '#0a84ff', i));
    const insT = db.prepare(`INSERT INTO tasks (id,project_id,title,phase_id,note,estimate_days,assignee,done,is_milestone,start_date,due_date,excel_row,start_f,due_f,start_rule_json,due_rule_json,seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    (proj.tasks || []).forEach((t, i) => insT.run(
      t.id, proj.id, t.title || '', t.phaseId || null, t.note || '', t.estimateDays || 0, t.assignee || '',
      t.done ? 1 : 0, t.isMilestone ? 1 : 0, t.startDate || null, t.dueDate || null,
      t.excelRow ?? null, t.startF || null, t.dueF || null,
      t.startRule ? JSON.stringify(t.startRule) : null, t.dueRule ? JSON.stringify(t.dueRule) : null, i));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return proj;
}
function listProjects(userId, isAdmin) {
  const rows = (isAdmin || !userId)
    ? db.prepare('SELECT * FROM projects ORDER BY sort, created_at').all()
    : db.prepare('SELECT * FROM projects WHERE owner_id=? ORDER BY sort, created_at').all(userId);
  return rows.map(rowToProj);
}
function getProject(id, userId, isAdmin) {
  const row = isAdmin
    ? db.prepare('SELECT * FROM projects WHERE id=?').get(id)
    : db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(id, userId);
  return row ? rowToProj(row) : null;
}
function deleteProject(id, userId, isAdmin) {
  const r = isAdmin
    ? db.prepare('DELETE FROM projects WHERE id=?').run(id)
    : db.prepare('DELETE FROM projects WHERE id=? AND owner_id=?').run(id, userId);
  return r.changes > 0;
}
function setOrder(ids, userId, isAdmin) {
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => {
      if (isAdmin) db.prepare('UPDATE projects SET sort=? WHERE id=?').run(i, id);
      else db.prepare('UPDATE projects SET sort=? WHERE id=? AND owner_id=?').run(i, id, userId);
    });
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

/* ---------------- 按人聚合报告 ---------------- */
function reportByUser() {
  const rows = db.prepare(`
    SELECT u.id uid, u.name uname, u.role,
      COUNT(DISTINCT p.id) proj_cnt,
      COUNT(t.id) task_cnt,
      COALESCE(SUM(t.done),0) done_cnt,
      COALESCE(SUM(CASE WHEN t.done=0 AND t.due_date IS NOT NULL AND t.due_date < date('now','localtime') THEN 1 ELSE 0 END),0) overdue_cnt
    FROM users u
    LEFT JOIN projects p ON p.owner_id=u.id
    LEFT JOIN tasks t ON t.project_id=p.id
    GROUP BY u.id ORDER BY proj_cnt DESC, uname
  `).all();
  const phRows = db.prepare(`
    SELECT u.name uname, ph.name pname, COUNT(t.id) total, COALESCE(SUM(t.done),0) done
    FROM users u
    JOIN projects p ON p.owner_id=u.id
    JOIN phases ph ON ph.project_id=p.id
    LEFT JOIN tasks t ON t.project_id=p.id AND t.phase_id=ph.id
    GROUP BY u.id, ph.id ORDER BY u.name, ph.seq
  `).all();
  const byUser = {};
  phRows.forEach(r => {
    if (!byUser[r.uname]) byUser[r.uname] = {};
    byUser[r.uname][r.pname] = { total: r.total, done: r.done };
  });
  return rows.map(r => ({
    user: { id: r.uid, name: r.uname, role: r.role },
    projects: r.proj_cnt, tasks: r.task_cnt, done: r.done_cnt, overdue: r.overdue_cnt,
    rate: r.task_cnt ? Math.round(r.done_cnt / r.task_cnt * 100) : 0,
    phases: byUser[r.uname] || {}
  }));
}

/* ---------------- 引导：建默认用户 + 存量 JSON 迁移 ---------------- */
function ensureAdminAndMigrate(seedFilePath) {
  let admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
  if (!admin) {
    const created = createUser('admin', DEFAULT_PASSWORD, 'admin'); // 初始密码 000000
    admin = { id: created.id, name: created.name, role: created.role };
    console.log('[初始化] 已创建管理员 admin，初始密码 000000（登录后请在「修改密码」中更改）');
  }
  migrateJson(seedFilePath, admin.id);
  return admin;
}
function ensureGuestUser() {
  // 游客只读账号（viewer），登录页"以游客身份登录"使用
  let guest = db.prepare("SELECT * FROM users WHERE name='guest' LIMIT 1").get();
  if (!guest) {
    const created = createUser('guest', DEFAULT_PASSWORD, 'viewer');
    guest = { id: created.id, name: created.name, role: created.role };
  }
  return guest;
}
function ensureDemoUser(seedFilePath) {
  let demo = db.prepare("SELECT * FROM users WHERE name='demo' LIMIT 1").get();
  if (!demo) {
    const created = createUser('demo', randomPassword(), 'user');
    demo = { id: created.id, name: created.name, role: created.role };
  }
  migrateJson(seedFilePath, demo.id);
  return demo;
}
function migrateJson(seedFilePath, ownerId) {
  if (!seedFilePath || !fs.existsSync(seedFilePath)) return 0;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(seedFilePath, 'utf8')); } catch (e) { return 0; }
  if (!Array.isArray(arr)) return 0;
  // 已有项目则跳过（幂等：重启不重复导入）
  const existing = db.prepare('SELECT COUNT(*) c FROM projects WHERE owner_id=?').get(ownerId);
  if (existing.c > 0) return 0;
  let n = 0;
  arr.forEach(p => {
    if (p && p.tasks && p.id) {
      if (!p.baseline) p.baseline = (p.tasks || []).map(t => ({ ...t })); // 迁移时补齐初版快照
      try { saveProject(p, ownerId); n++; } catch (e) { console.error('[迁移] 项目导入失败:', p.name, e.message); }
    }
  });
  if (n) console.log('[迁移] 已从 JSON 导入 ' + n + ' 个项目到 SQLite（归属 ' + ownerId + '）');
  return n;
}

module.exports = { init, DEFAULT_PASSWORD, createUser, listUsers, getUserByName, getUserById, verifyUser, changePassword, resetPassword, issueToken, tokenUserId, saveProject, listProjects, getProject, deleteProject, setOrder, reportByUser, ensureAdminAndMigrate, ensureDemoUser, ensureGuestUser, migrateJson, randomPassword };
