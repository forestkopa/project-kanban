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
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT
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
      start_date TEXT, due_date TEXT,
      excel_row INTEGER, start_f TEXT, due_f TEXT,
      start_rule_json TEXT, due_rule_json TEXT,
      recurrence TEXT DEFAULT '',
      seq INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trash (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT,
      title TEXT,
      payload_json TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, sort);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_trash_user ON trash(user_id, deleted_at);
  `);
  // 兼容旧库：幂等补列（新建表已含，重复执行的报错按「列已存在」忽略）
  try { db.exec('ALTER TABLE tokens ADD COLUMN expires_at TEXT'); } catch (e) { /* 列已存在 */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN recurrence TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }
  purgeTrash(30); // 回收站保留 30 天，启动即清理过期项
  cleanupExpiredTokens(); // 启动即清理过期 token
}

/* ---------------- 密码与用户 ---------------- */
// scrypt 参数（2026-08-25 两轮评审提升）：N=2^17, r=8, p=1, keylen=64；哈希串带参数前缀以便升级，旧格式(salt:hash)按默认参数兼容校验
// 注意：N=131072 需要约 134MB 内存，必须显式 maxmem，否则 Node 默认 32MB 上限直接抛 RangeError（memory limit exceeded）
const SCRYPT_N = 131072, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64, SCRYPT_MAXMEM = 256 * 1024 * 1024;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toString('hex');
  return SCRYPT_N + ':' + SCRYPT_R + ':' + SCRYPT_P + ':' + salt + ':' + h;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split(':');
  let N, r, p, salt, h;
  if (parts.length === 5) { [N, r, p, salt, h] = parts; }            // 新格式：N:r:p:salt:hash
  else if (parts.length === 2) { [salt, h] = parts; N = 16384; r = 8; p = 1; } // 旧格式：默认参数
  else return false;
  if (!salt || !h) return false;
  try {
    const t = crypto.scryptSync(pw, salt, h.length / 2, { N: +N || 16384, r: +r || 8, p: +p || 1, maxmem: SCRYPT_MAXMEM }).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(t, 'hex'), Buffer.from(h, 'hex'));
  } catch (e) { return false; }
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
// 管理员修改用户角色（role 白名单由调用方校验）
function updateUserRole(userId, role) {
  const r = db.prepare('UPDATE users SET role=? WHERE id=?').run(role, userId);
  return r.changes > 0;
}
// 删除用户：有项目则拒绝（避免级联误删数据）；无项目直接删（tokens 级联清除）
function deleteUser(userId) {
  const u = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(userId);
  if (!u) return { ok: false, reason: '用户不存在' };
  const cnt = db.prepare('SELECT COUNT(*) c FROM projects WHERE owner_id=?').get(userId).c;
  if (cnt > 0) return { ok: false, reason: '该用户有 ' + cnt + ' 个项目，请先删除或转移项目后再删除用户' };
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
  return { ok: true };
}
function getUserByName(name) { return db.prepare('SELECT * FROM users WHERE name=?').get(name); }
function getUserById(id) { return db.prepare('SELECT id,name,role FROM users WHERE id=?').get(id); }
function verifyUser(name, password) {
  const u = getUserByName(name);
  if (!u || !verifyPassword(password, u.pass_hash)) return null;
  return { id: u.id, name: u.name, role: u.role, mustChange: password === DEFAULT_PASSWORD };
}
// 该用户是否仍在使用初始密码（P1-8：服务端强制改密的判定依据，不依赖前端）
function usesDefaultPassword(userId) {
  const u = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(userId);
  if (!u) return false;
  return verifyPassword(DEFAULT_PASSWORD, u.pass_hash);
}
// 自助改密：校验旧密码后更新（返回错误原因或 null）
function changePassword(userId, oldPw, newPw) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return '用户不存在';
  if (!verifyPassword(oldPw, u.pass_hash)) return '旧密码错误';
  if (String(newPw || '').length < 6) return '新密码至少 6 位';
  if (newPw === DEFAULT_PASSWORD) return '新密码不能与初始密码相同';
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
  const days = Math.max(1, parseInt(process.env.KB_TOKEN_TTL_DAYS || '30', 10) || 30); // 默认 30 天过期
  const exp = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('DELETE FROM tokens WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO tokens (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, userId, new Date().toISOString(), exp);
  return token;
}
function tokenUserId(token) {
  const r = db.prepare('SELECT user_id, expires_at FROM tokens WHERE token=?').get(String(token || ''));
  if (!r) return null;
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM tokens WHERE token=?').run(String(token)); // 过期即清理
    return null;
  }
  return r.user_id;
}
function cleanupExpiredTokens() {
  try { db.prepare('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(new Date().toISOString()); } catch (e) { console.error('清理过期 token 失败:', (e && e.message) || e); }
}

/* ---------------- 项目（单项目粒度保存） ---------------- */
// rowToProj 支持预加载的 phases/tasks（列表场景批量查一次，避免 N+1：每项目 2 条 SQL → 全列表 2 条）
function rowToProj(r, prePhases, preTasks) {
  const phases = (prePhases !== undefined ? prePhases : db.prepare('SELECT * FROM phases WHERE project_id=? ORDER BY seq').all(r.id))
    .map(p => ({ id: p.id, name: p.name, color: p.color }));
  const tasks = (preTasks !== undefined ? preTasks : db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY seq').all(r.id)).map(t => ({
    id: t.id, title: t.title, phaseId: t.phase_id, note: t.note, estimateDays: t.estimate_days,
    assignee: t.assignee, done: !!t.done,
    startDate: t.start_date, dueDate: t.due_date,
    excelRow: t.excel_row ?? undefined, startF: t.start_f ?? undefined, dueF: t.due_f ?? undefined,
    startRule: t.start_rule_json ? JSON.parse(t.start_rule_json) : undefined,
    dueRule: t.due_rule_json ? JSON.parse(t.due_rule_json) : undefined,
    recurrence: t.recurrence || ''
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
  // 所有权只随创建设定：已有项目保持原 owner（修复：编辑他人项目时曾把 owner 覆盖为编辑者）
  const existing = db.prepare('SELECT owner_id FROM projects WHERE id=?').get(proj.id);
  const ownerId = existing ? existing.owner_id : userId;
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
      .run(proj.id, ownerId, proj.name || '未命名项目', proj.templateId || null, proj.icon || '', proj.color || '#0a84ff',
        proj.type || 'C端', proj.level || 'B', proj.productType || '', proj.cert || '', proj.status || 'active',
        proj.completedAt ?? null, JSON.stringify(proj.engineers || {}), proj.startDate || null, proj.startCell || null,
        proj.baseline ? JSON.stringify(proj.baseline) : null, proj.sort || 0, proj.createdAt || new Date().toISOString());
    db.prepare('DELETE FROM phases WHERE project_id=?').run(proj.id);
    db.prepare('DELETE FROM tasks WHERE project_id=?').run(proj.id);
    (proj.phases || []).forEach((ph, i) => db.prepare('INSERT INTO phases (project_id,id,name,color,seq) VALUES (?,?,?,?,?)')
      .run(proj.id, ph.id, ph.name || ('阶段' + (i + 1)), ph.color || '#0a84ff', i));
    const insT = db.prepare(`INSERT INTO tasks (id,project_id,title,phase_id,note,estimate_days,assignee,done,start_date,due_date,excel_row,start_f,due_f,start_rule_json,due_rule_json,recurrence,seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    (proj.tasks || []).forEach((t, i) => insT.run(
      t.id, proj.id, t.title || '', t.phaseId || null, t.note || '', t.estimateDays || 0, t.assignee || '',
      t.done ? 1 : 0, t.startDate || null, t.dueDate || null,
      t.excelRow ?? null, t.startF || null, t.dueF || null,
      t.startRule ? JSON.stringify(t.startRule) : null, t.dueRule ? JSON.stringify(t.dueRule) : null,
      t.recurrence || '', i));
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
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = db.prepare(`SELECT * FROM phases WHERE project_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`).all(...ids);
  const tk = db.prepare(`SELECT * FROM tasks WHERE project_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`).all(...ids);
  const phMap = {}, tkMap = {};
  ph.forEach(p => (phMap[p.project_id] = phMap[p.project_id] || []).push(p));
  tk.forEach(t => (tkMap[t.project_id] = tkMap[t.project_id] || []).push(t));
  return rows.map(r => rowToProj(r, phMap[r.id] || [], tkMap[r.id] || []));
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

/* ---------------- 回收站（P0-4）：删除即快照，可恢复，保留 N 天 ----------------
   设计：不在 projects/tasks 上加 deleted_at 软删列。原因是 saveProject 采用
   「事务内整表重写该项目的 phases/tasks」策略，软删行会在下一次保存时被清空。
   改为把被删对象的完整 JSON 快照落到独立 trash 表，恢复时再写回，互不干扰。 */
function trashPush(userId, kind, refId, payload, meta) {
  const id = 'tr_' + crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO trash (id,user_id,kind,ref_id,project_id,project_name,title,payload_json,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, kind, refId, (meta && meta.projectId) || null, (meta && meta.projectName) || null,
      (meta && meta.title) || '', JSON.stringify(payload), new Date().toISOString());
  return id;
}
function trashList(userId, isAdmin) {
  const rows = isAdmin
    ? db.prepare('SELECT id,user_id,kind,ref_id,project_id,project_name,title,deleted_at FROM trash ORDER BY deleted_at DESC LIMIT 200').all()
    : db.prepare('SELECT id,user_id,kind,ref_id,project_id,project_name,title,deleted_at FROM trash WHERE user_id=? ORDER BY deleted_at DESC LIMIT 200').all(userId);
  return rows.map(r => ({ id: r.id, kind: r.kind, refId: r.ref_id, projectId: r.project_id, projectName: r.project_name, title: r.title, deletedAt: r.deleted_at }));
}
function trashGet(id, userId, isAdmin) {
  const r = isAdmin
    ? db.prepare('SELECT * FROM trash WHERE id=?').get(id)
    : db.prepare('SELECT * FROM trash WHERE id=? AND user_id=?').get(id, userId);
  if (!r) return null;
  return { id: r.id, userId: r.user_id, kind: r.kind, refId: r.ref_id, projectId: r.project_id, projectName: r.project_name, title: r.title, payload: JSON.parse(r.payload_json), deletedAt: r.deleted_at };
}
function trashDrop(id, userId, isAdmin) {
  const r = isAdmin
    ? db.prepare('DELETE FROM trash WHERE id=?').run(id)
    : db.prepare('DELETE FROM trash WHERE id=? AND user_id=?').run(id, userId);
  return r.changes > 0;
}
// 保留 days 天，过期条目物理删除
function purgeTrash(days) {
  try {
    const cut = new Date(Date.now() - (days || 30) * 86400000).toISOString();
    const r = db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cut);
    return r.changes;
  } catch (e) { console.error('清理回收站失败:', (e && e.message) || e); return 0; }
}

/* ---------------- 按人聚合报告（2026-08-25 口径调整：按负责人 assignee 归属，空/未匹配负责人回退项目 owner） ---------------- */
function reportByUser() {
  const users = db.prepare("SELECT id,name,role FROM users WHERE name != 'guest' ORDER BY created_at").all();
  const projs = db.prepare('SELECT id, owner_id FROM projects').all();
  const tasks = db.prepare('SELECT project_id, phase_id, done, due_date, assignee FROM tasks').all();
  const phases = db.prepare('SELECT id, name FROM phases').all();
  const ownerOf = new Map(projs.map(p => [p.id, p.owner_id]));
  const phaseName = new Map(phases.map(p => [p.id, p.name]));
  const nameId = new Map();
  users.forEach(u => nameId.set(String(u.name).toLowerCase(), u.id));
  const stats = new Map(users.map(u => [u.id, { uid: u.id, uname: u.name, role: u.role, proj: 0, task: 0, done: 0, overdue: 0, phases: {} }]));
  projs.forEach(p => { const s = stats.get(p.owner_id); if (s) s.proj++; });
  const n = new Date();
  const todayStr = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  tasks.forEach(t => {
    const a = String(t.assignee || '').trim();
    let uid = a ? nameId.get(a.toLowerCase()) : null;   // 负责人匹配用户
    if (!uid) uid = ownerOf.get(t.project_id);          // 空/未匹配 → 项目 owner 兜底
    const s = stats.get(uid); if (!s) return;
    s.task++;
    if (t.done) s.done++;
    else if (t.due_date && t.due_date < todayStr) s.overdue++;
    const pn = phaseName.get(t.phase_id) || '未分组';
    const ps = s.phases[pn] || (s.phases[pn] = { total: 0, done: 0 });
    ps.total++; if (t.done) ps.done++;
  });
  return users.map(u => {
    const s = stats.get(u.id);
    return { user: { id: u.id, name: u.name, role: u.role }, projects: s.proj, tasks: s.task, done: s.done, overdue: s.overdue, rate: s.task ? Math.round(s.done / s.task * 100) : 0, phases: s.phases };
  }).sort((a, b) => (b.projects - a.projects) || a.user.name.localeCompare(b.user.name, 'zh'));
}

/* ---------------- 引导：建默认用户 + 存量 JSON 迁移 ---------------- */
function ensureAdminAndMigrate(seedFilePath) {
  let admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
  if (!admin) {
    const created = createUser('admin', DEFAULT_PASSWORD, 'admin'); // 初始密码 000000
    admin = { id: created.id, name: created.name, role: created.role };
    console.log('[初始化] 已创建管理员 admin（请登录后立即修改默认密码）');
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
  if (!seedFilePath) return 0;
  const marker = 'migrated:' + path.basename(seedFilePath);
  // 显式迁移标记（2026-08-25 两轮评审）：避免"用户已有项目 → 存量 JSON 永不导入"的漏迁
  if (db.prepare('SELECT v FROM meta WHERE k=?').get(marker)) return 0;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(seedFilePath, 'utf8')); } catch (e) { return 0; }
  if (!Array.isArray(arr)) return 0;
  // 已有项目则视为已完成迁移（幂等：重启不重复导入），并记录标记
  const existing = db.prepare('SELECT COUNT(*) c FROM projects WHERE owner_id=?').get(ownerId);
  if (existing.c > 0) { db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run(marker, 'done'); return 0; }
  let n = 0;
  arr.forEach(p => {
    if (p && p.tasks && p.id) {
      if (!p.baseline) p.baseline = (p.tasks || []).map(t => ({ ...t })); // 迁移时补齐初版快照
      try { saveProject(p, ownerId); n++; } catch (e) { console.error('[迁移] 项目导入失败:', p.name, e.message); }
    }
  });
  if (n) { db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run(marker, 'done'); console.log('[迁移] 已从 JSON 导入 ' + n + ' 个项目到 SQLite（归属 ' + ownerId + '）'); }
  return n;
}

module.exports = { init, createUser, listUsers, updateUserRole, deleteUser, getUserByName, getUserById, verifyUser, usesDefaultPassword, changePassword, resetPassword, issueToken, tokenUserId, cleanupExpiredTokens, saveProject, listProjects, getProject, deleteProject, setOrder, reportByUser,
  trashPush, trashList, trashGet, trashDrop, purgeTrash, ensureAdminAndMigrate, ensureDemoUser, ensureGuestUser, migrateJson, randomPassword };
