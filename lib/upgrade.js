/* 自动升级模块：从 GitHub Release 下载 update.zip → 备份 → 解压覆盖 → 重启看板服务
 * 设计：两阶段（prepare 比对+发一次性 token / confirm 启动后台任务）；后台任务分阶段推送进度
 *       前端可轮询 /api/admin/upgrade/status 拉快照（taskId 索引），不再依赖长连接或 SSE。
 *       token 持久化到 data/upgrade-tokens.json（kanban-watchdog 重启不会丢）。
 * 匿名下载：release asset 走 github.com CDN（非 api.github.com），不受 60/h API 限额约束。
 * 安全：仅在 admin 鉴权 + 有效 token 下执行；重启用 detached 进程，避免"自己杀自己"导致请求中断。
 *
 * v1.5.1 加固（修复「提示完成但版本没变」）：
 *   1) 升级锁 data/upgrade.lock —— 解压期间 watchdog.js 跳过 mtime 自动重启。
 *      原缺陷：解压逐文件覆盖 server.js/public/ → 文件 mtime 变化 → watchdog 15s 内判定
 *      「代码更新」并 taskkill 掉正在执行升级的 server 进程 → 解压半途中断，
 *      而任务状态只存在内存，重启后丢失 → 前端看到「任务不存在/已结束」误以为完成，版本未变。
 *   2) 解压后强制校验 package.json 版本号是否等于目标版本，不符直接判失败（不再静默"完成"）。
 *   3) 任务状态持久化到 data/upgrade-task.json —— 进程被重启后前端仍能拉到最终结果。
 *   4) 全过程写日志 logs/upgrade-YYYY-MM-DD.log（原 watchdog 以 stdio:'ignore' 拉起，无日志可查）。
 *   5) 解压优先用系统内置 tar.exe（bsdtar，支持 zip 且不受 260 字符路径限制），失败回退 Expand-Archive。
 *   6) 下载超时 180s → 600s 并支持重试 2 次（公司宽带下 40MB 包曾超时）。
 *
 * v1.5.5 加固（修复「在线升级期间服务假死数分钟 → 前端只能显示『服务重启中…』」）：
 *   生产实测（本机等价复现，2026-09-10）：下载 10s、备份 3s、**解压 97s**，
 *   而解压全程事件循环被 spawnSync 冻死 → 端口 100% 无响应 → 前端轮询连续超时，
 *   只能报「服务重启中…(Ns)」；同时 watchdog 每 15s 判「端口未响应」而重复 spawn 服务实例（实测连拉 8 次），
 *   隧道健康检查又把源站 502 误判为「隧道挂了」→ taskkill cloudflared + 90s 冷却 → 公网故障被放大到数分钟。
 *   修复：
 *   1) extractZip / backupDir 改**异步 spawn**（不再 spawnSync）：事件循环全程不冻结，升级期间看板照常响应。
 *   2) 解压上报**真实进度**（-v 逐行计数 / zip EOCD 条目总数），前端能看到 88%→95% 在动而不是干等。
 *   3) 升级包不再携带 node_modules（22.5MB / 1139 文件 → 约 2MB / 92 文件），解压从 97s 降到秒级；
 *      解压后做依赖自检，缺依赖明确报错而不是重启后 500。
 *   4) 硬超时（备份 5min / 解压 5min），卡死不无限期占着升级锁。
 *   5) 解压后显式顶高 server.js 的 mtime：bsdtar 默认还原包内时间戳，可能早于 watchdog 快照 → 热重载不触发。
 *   6) 升级锁带**心跳**（30s 刷新一次）：进程若在升级中被杀，残留锁会被 watchdog 判为过期并忽略，自愈不失效。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = 'forestkopa/project-kanban';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SERVICE = 'kanban-watchdog';
const TOKEN_TTL = 5 * 60 * 1000; // 5 分钟
const TASK_TTL = 10 * 60 * 1000; // 任务状态保留 10 分钟（完成后保留供前端拉取最终结果）
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟（40MB 包在弱网下的兜底）
const BACKUP_TIMEOUT_MS = 5 * 60 * 1000;     // 备份上限（robocopy 卡住时不能无限期占着升级锁）
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;    // 解压上限（去掉 node_modules 后正常只需秒级）

const pending = new Map();   // token -> { exp, tag, assetUrl } （内存缓存；启动时从磁盘加载）
const tasks = new Map();     // taskId -> { phase, progress, message, error, finished, startedAt, finishedAt, tag, backup, downloaded }

/* ---------------- 日志（升级过程唯一可观测入口） ---------------- */
function upgradeLog(root, msg) {
  try {
    const dir = path.join(root, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const f = path.join(dir, 'upgrade-' + new Date().toISOString().slice(0, 10) + '.log');
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响升级主流程 */ }
}

/* ---------------- 升级锁：解压期间禁止 watchdog 自动重启 ---------------- */
function lockFile(root) { return path.join(root, 'data', 'upgrade.lock'); }
let lockKeepAlive = null; // 锁心跳定时器（升级全程 30s 刷新一次时间戳）
// 心跳（v1.5.5）：锁文件内容 = 最近一次刷新时间戳。watchdog 读到过期时间戳就忽略该锁，
// 这样「升级进程被杀 → 锁残留」不会再永久禁用热重载/自愈。
function touchLock(root) {
  try { fs.writeFileSync(lockFile(root), String(Date.now()), 'utf8'); return true; }
  catch (e) { return false; }
}
function setLock(root, on) {
  try {
    if (on) {
      fs.writeFileSync(lockFile(root), String(Date.now()), 'utf8');
      if (!lockKeepAlive) {
        lockKeepAlive = setInterval(() => touchLock(root), 30000);
        if (lockKeepAlive.unref) lockKeepAlive.unref();
      }
      return true;
    }
    if (lockKeepAlive) { clearInterval(lockKeepAlive); lockKeepAlive = null; }
    // 解锁：先写"已释放"标记（时间戳 0 = 过期，watchdog 读作无锁），再尝试删除。
    // 为什么不能只靠删除：Windows 上删除可能被杀软/权限/安全策略拦截（本机实测 unlinkSync
    // 会被安全钩子直接拦下），一旦删不掉，残留锁会让热重载与自愈"看起来失效"。
    // 写标记必然成功，删除只是顺手清理。
    try { fs.writeFileSync(lockFile(root), '0', 'utf8'); } catch (e) {}
    try { if (fs.existsSync(lockFile(root))) fs.unlinkSync(lockFile(root)); }
    catch (e) { upgradeLog(root, '锁文件删除失败（已写为过期标记，watchdog 会忽略它）: ' + (e && e.message)); }
    return true;
  } catch (e) { upgradeLog(root, '锁操作失败(' + (on ? '加锁' : '解锁') + '): ' + (e && e.message)); return false; }
}
// 锁是否生效（与 watchdog.js#upgradeLocked 同一套判定：时间戳 0 / 超过 STALE 都算过期）
const LOCK_STALE_MS = 3 * 60 * 1000;
function isLocked(root) {
  try {
    const raw = fs.readFileSync(lockFile(root), 'utf8').trim();
    const ts = Number(raw);
    if (!ts) return false;
    return Date.now() - ts <= LOCK_STALE_MS;
  } catch (e) { return false; }
}

/* ---------------- 任务状态持久化（重启后可被前端拉到） ---------------- */
function taskFile(root) { return path.join(root, 'data', 'upgrade-task.json'); }
function persistTask(root, taskId, snap) {
  try {
    const tmp = taskFile(root) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ taskId, snap, savedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, taskFile(root));
  } catch (e) { upgradeLog(root, '任务状态持久化失败: ' + (e && e.message)); }
}
function readPersistedTask(root, taskId) {
  try {
    const raw = JSON.parse(fs.readFileSync(taskFile(root), 'utf8'));
    if (!raw || !raw.snap) return null;
    if (taskId && raw.taskId !== taskId) return null;
    if (Date.now() - (raw.savedAt || 0) > TASK_TTL) return null;
    return raw.snap;
  } catch (e) { return null; }
}

// token 持久化文件：data/upgrade-tokens.json（atomic write：tmp + rename，避免部分写入）
function tokensFile(root) { return path.join(root, 'data', 'upgrade-tokens.json'); }
function loadTokens(root) {
  try {
    const raw = fs.readFileSync(tokensFile(root), 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [tok, v] of Object.entries(obj)) {
      if (v && v.exp > now) pending.set(tok, v);
    }
  } catch (e) { /* 文件不存在/损坏：忽略，空 Map 起步 */ }
}
function saveTokens(root) {
  try {
    fs.mkdirSync(path.dirname(tokensFile(root)), { recursive: true });
    const obj = {};
    const now = Date.now();
    for (const [tok, v] of pending) { if (v.exp > now) obj[tok] = v; }
    const tmp = tokensFile(root) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, tokensFile(root));
  } catch (e) { console.warn('[upgrade] 持久化 token 失败:', e.message); }
}
function pruneExpiredTokens(root) {
  const now = Date.now();
  let changed = false;
  for (const [tok, v] of pending) {
    if (!v || v.exp <= now) { pending.delete(tok); changed = true; }
  }
  if (changed) saveTokens(root);
}

function localVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}
// 版本比较：数字段逐位比，'-' 之后的后缀做决胜（与前端 public/app.js cmpVer 保持一致）。
// 回归点：旧实现只按 '.' 拆，'1.4.7-hotfix3' 与 '1.4.7-hotfix4' 被判相等 → 页脚自相矛盾。
function cmpVer(a, b) {
  const parse = v => {
    const s = String(v == null ? '' : v);
    const i = s.indexOf('-');
    const main = i >= 0 ? s.slice(0, i) : s;
    const suffix = i >= 0 ? s.slice(i + 1) : '';
    const nums = main.split('.').map(x => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; });
    return { nums, suffix };
  };
  const pa = parse(a), pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.suffix !== pb.suffix) return pa.suffix < pb.suffix ? -1 : 1;
  return 0;
}

async function getLatestRelease() {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 15000);
  const gh = await fetch(RELEASE_API, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'kanban-upgrade' },
    signal: ac.signal
  });
  clearTimeout(to);
  if (!gh.ok) throw new Error('GitHub HTTP ' + gh.status + (gh.status === 403 ? '（可能被限流，稍后重试）' : ''));
  const j = await gh.json();
  const asset = (j.assets || []).find(a => /update\.zip$/i.test(a.name));
  if (!asset) throw new Error('该 Release 未包含 update.zip');
  return {
    tag: j.tag_name,
    version: (j.tag_name || '').replace(/^v/, ''),
    url: j.html_url,
    assetUrl: asset.browser_download_url,
    assetSize: asset.size
  };
}

async function prepareUpgrade(root) {
  const local = localVersion(root);
  let rel;
  if (process.env.KANBAN_UPGRADE_ASSET_URL) {
    rel = { tag: 'v0.0.0-local', version: '999.0.0', url: '', assetUrl: process.env.KANBAN_UPGRADE_ASSET_URL, assetSize: 0 };
  } else {
    rel = await getLatestRelease();
  }
  upgradeLog(root, `prepare: local=${local} latest=${rel.version} need=${cmpVer(rel.version, local) > 0} asset=${rel.assetUrl}`);
  const need = cmpVer(rel.version, local) > 0;
  let token = null;
  if (need) {
    token = require('crypto').randomBytes(16).toString('hex');
    pending.set(token, { exp: Date.now() + TOKEN_TTL, tag: rel.tag, assetUrl: rel.assetUrl, version: rel.version });
    saveTokens(root);  // 持久化（watchdog 重启也不丢）
    setTimeout(() => { pending.delete(token); saveTokens(root); }, TOKEN_TTL).unref?.();
  }
  return {
    need, local, latest: rel.version, tag: rel.tag, url: rel.url,
    assetUrl: rel.assetUrl, assetSize: rel.assetSize, token
  };
}

function consumeToken(root, tok) {
  if (!tok) return null;
  // 先从磁盘重读（应对 watchdog 刚重启、内存 Map 被清的情况）
  if (!pending.size) loadTokens(root);
  pruneExpiredTokens(root);
  const e = pending.get(tok);
  if (!e) return null;
  pending.delete(tok);
  saveTokens(root);
  if (e.exp < Date.now()) return null;
  return e;
}

// 任务快照：给前端轮询用（只暴露必要字段，不含内部路径）
// 内存没有（进程被重启）时回落到磁盘快照 —— 修复「重启后查不到任务 → 前端误判结束」
function getTaskStatus(taskId, root) {
  const t = tasks.get(taskId);
  if (t) return {
    taskId,
    phase: t.phase,       // idle | download | backup | extract | verify | restart | done | error
    progress: t.progress, // 0-100
    message: t.message,
    error: t.error || null,
    finished: !!t.finished,
    tag: t.tag,
    downloaded: t.downloaded || 0,
    backup: t.backup || null,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt || null
  };
  const disk = root ? readPersistedTask(root, taskId) : null;
  if (disk) return disk;
  return null;
}

function setTask(taskId, patch, root) {
  const cur = tasks.get(taskId) || {};
  const next = { ...cur, ...patch };
  tasks.set(taskId, next);
  if (root) persistTask(root, taskId, getTaskStatus(taskId));
  // 完成后保留 TASK_TTL，让前端重连能拉到最终结果
  if (patch.finished) {
    setTimeout(() => tasks.delete(taskId), TASK_TTL).unref?.();
  }
}

// 流式下载 + 进度回调（边下边写盘，节省内存，可推送 percent）
async function downloadFileWithProgress(url, dest, onProgress) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  const r = await fetch(url, { headers: { 'User-Agent': 'kanban-upgrade' }, signal: ac.signal });
  clearTimeout(to);
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status + (r.status === 403 ? '（GitHub 匿名限流，建议稍后重试或手动升级）' : ''));
  const total = Number(r.headers.get('content-length')) || 0;
  const ws = fs.createWriteStream(dest);
  let received = 0;
  const reader = r.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(Buffer.from(value));
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
  } finally {
    // 等 flush 落盘再返回——否则紧接着的 statSync 可能读到未写完的大小
    await new Promise(res => ws.end(res));
    try { reader.releaseLock(); } catch (e) {}
  }
  // v1.5.3：完整性校验——收到的字节数与 content-length 不符即判失败（触发上层重试）。
  // 原缺陷：CDN 返回 200 但 body 截断时静默当成功，坏 zip 流进解压环节 → tar/Expand-Archive 双双失败。
  if (total > 0 && received !== total) {
    throw new Error('下载不完整：收到 ' + received + 'B ≠ 声明 ' + total + 'B');
  }
  return received;
}

// 带重试的下载：弱网/公司宽带下 40MB 包容易中断，重试 2 次。
// v1.5.3：expectSize（GitHub API 声明的 asset 大小）与 zip 魔数双重校验，坏包进不了解压环节。
async function downloadWithRetry(root, url, dest, onProgress, expectSize) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const size = await downloadFileWithProgress(url, dest, onProgress);
      const st = (function () { try { return fs.statSync(dest).size; } catch (e) { return 0; } })();
      upgradeLog(root, `download ok: ${(st / 1048576).toFixed(1)}MB (第 ${i} 次尝试)`);
      if (st < 1024) throw new Error('下载文件过小（' + st + ' B），疑似失败');
      if (expectSize && st !== expectSize) throw new Error('下载大小与 Release 声明不符：' + st + 'B ≠ ' + expectSize + 'B');
      const fd = fs.openSync(dest, 'r');
      const head = Buffer.alloc(2);
      try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
      if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('下载内容不是 zip（头 ' + head.toString('hex') + '），疑似网关错误页');
      return size;
    } catch (e) {
      lastErr = e;
      upgradeLog(root, `download fail #${i}: ${e && e.message}`);
      if (onProgress) onProgress(0, 0);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('下载失败（已重试 3 次）：' + (lastErr && lastErr.message));
}

/* ---------------- 异步子进程执行器（v1.5.5 核心） ----------------
 * 为什么不能用 spawnSync：它是**同步阻塞**的，整个事件循环（含 HTTP 端口）会被冻住。
 * 生产实测解压 97s 期间服务 100% 无响应，前端只能显示「服务重启中…」，用户以为升级卡死。
 * 这里统一用异步 spawn：升级期间看板照常响应，进度也能通过 stdout 上报。
 */
function runChild(cmd, args, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    let child;
    try { child = cp.spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolve({ status: -1, err: e, stdout: '', stderr: String((e && e.message) || e), timedOut: false }); }
    let stdout = '', stderr = '', done = false, timer = null;
    const cap = s => (s.length > 20000 ? s.slice(-20000) : s);
    const finish = r => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    if (child.stdout) child.stdout.on('data', d => {
      stdout = cap(stdout + d);
      if (opts.onLine) String(d).split(/\r?\n/).forEach(l => { if (l.trim()) opts.onLine(l.trim()); });
    });
    if (child.stderr) child.stderr.on('data', d => {
      stderr = cap(stderr + d);
      if (opts.onErrLine) String(d).split(/\r?\n/).forEach(l => { if (l.trim()) opts.onErrLine(l.trim()); });
    });
    child.on('error', e => finish({ status: -1, err: e, stdout, stderr: stderr + '\n' + ((e && e.message) || e), timedOut: false }));
    child.on('close', status => finish({ status, stdout, stderr, timedOut: false }));
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
        finish({ status: -2, stdout, stderr: stderr + '\n[超过 ' + Math.round(opts.timeoutMs / 1000) + 's 上限，已终止]', timedOut: true });
      }, opts.timeoutMs);
      if (timer.unref) timer.unref();
    }
  });
}

// 备份当前版本（异步 robocopy）。v1.5.5：改 async 消除事件循环冻结，
// 并显式限制重试次数（robocopy 默认 /R:1000000 /W:30 —— 碰上被占用的文件会"卡住几十分钟"）。
// 注意：备份**不含 node_modules**（升级包也不再携带依赖，故回滚无需还原依赖目录）。
async function backupDir(root) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(root, 'data-backup-upgrade-' + ts);
  fs.mkdirSync(bak, { recursive: true });
  const xd = ['node_modules', '.git', '.workbuddy', 'backups', 'data-backup-*', 'upgrade-tmp-*', 'upgrade-new-*', 'logs'];
  const xf = ['*.log', '*.tmp', '*.zip', '*.patch'];
  const args = [root, bak, '/E', '/R:2', '/W:1', '/XD', ...xd, '/XF', ...xf, '/NFL', '/NDL', '/NJH', '/NJS'];
  const r = await runChild('robocopy', args, { timeoutMs: BACKUP_TIMEOUT_MS });
  if (r.timedOut) throw new Error('备份超过 ' + (BACKUP_TIMEOUT_MS / 60000) + ' 分钟未完成（robocopy 可能被占用文件拖住），已终止');
  if (r.status === -1) throw new Error('备份失败: ' + stderrTail(r.stderr));
  if (r.status !== undefined && r.status > 7) throw new Error('备份失败(exit=' + r.status + '): ' + stderrTail(r.stderr));
  return bak;
}

// stderr 尾部提取：解压失败时用户必须能看到真实报错（此前只截 e.message，stderr 全丢）
function stderrTail(buf) {
  const s = buf ? String(buf).trim() : '';
  return s ? s.split('\n').filter(l => l.trim()).slice(-4).join(' | ').slice(0, 400) : '(无输出)';
}

// 解压：优先系统内置 tar.exe（bsdtar，支持 zip、无 260 字符路径限制），失败回退 Expand-Archive。
// v1.5.3 修复（生产首测「解压失败（两种方式均失败）」）：
//   1) execSync 字符串拼接存在 cmd/引号转义地狱（JSON.stringify 的 \" 与 \\\\ 过 cmd 后语义不清）
//      → tar 改 spawnSync 数组参数（路径原样传递，零转义）；PowerShell 改 -EncodedCommand（UTF-16LE base64）。
//   2) 失败信息必须带 stderr（此前「Command failed: tar.exe -xf ...」把真实原因全吞了）。
//   3) 入口先验 PK 魔数：损坏/不完整 zip 直接报「下载文件无效」，不浪费两种解压尝试。
// v1.5.5 修复（生产「升级期间服务假死数分钟 → 前端只能显示服务重启中…」）：
//   4) spawnSync →**异步 spawn**：同步解压把事件循环（含 HTTP 端口）整个冻住，实测 97s 完全无响应。
//   5) tar 带 -v 逐行统计 + onProgress 上报**真实进度**（前端能看到 88%→95% 在动而不是干等）。
//   6) 硬超时 EXTRACT_TIMEOUT_MS：解压卡死不再无限期占着升级锁。
async function extractZip(zipPath, root, onProgress) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(zipPath, 'r');
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    throw new Error('下载的文件不是有效 zip（文件头 ' + head.toString('hex') + '）。疑似下载不完整或被网关劫持，请重试升级。');
  }
  const errs = [];
  const total = zipEntryCount(zipPath);
  let n = 0;
  const onLine = () => { n++; if (onProgress) onProgress(n, total); };
  // 方案 A：tar.exe（Windows 10 17063+ 内置 bsdtar，支持 zip）—— 数组参数，路径零转义。
  // 关键：必须用 System32 绝对路径！若 PATH 里排在前面的 tar 是 GNU/MSYS tar（装 Git 后常见），
  //       它不支持 zip 格式，解 zip 必失败 → 这正是生产「两种方式均失败」的头号嫌疑。
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarExe = fs.existsSync(sysTar) ? sysTar : 'tar.exe';
  // -v 的逐条输出在不同 tar 实现下走 stdout 或 stderr，两个流都计入（进度仅用于显示，多算无妨）
  let r = await runChild(tarExe, ['-xvf', zipPath, '-C', root], { onLine, onErrLine: onLine, timeoutMs: EXTRACT_TIMEOUT_MS });
  if (r.status === 0 && !r.err) return 'tar';
  errs.push('tar(exit=' + r.status + (r.err ? ' ' + r.err.code : '') + '): ' + stderrTail(r.stderr));
  // 方案 B：PowerShell Expand-Archive（PS 5.1 兜底）—— -EncodedCommand 彻底绕开引号转义
  const ps = '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + root + '" -Force';
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  if (onProgress) onProgress(0, total);
  r = await runChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeoutMs: EXTRACT_TIMEOUT_MS });
  if (r.status === 0 && !r.err) return 'expand';
  errs.push('Expand-Archive(exit=' + r.status + (r.err ? ' ' + r.err.code : '') + '): ' + stderrTail(r.stderr));
  throw new Error('解压失败（两种方式均失败）：' + errs.join(' | '));
}

// zip 条目总数（读中央目录尾部 EOCD 记录），用于把解压进度换算成百分比
function zipEntryCount(zipPath) {
  try {
    const fd = fs.openSync(zipPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65557);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
    }
  } catch (e) {}
  return 0;
}

// 解压后把入口文件 mtime 顶到当前时间（v1.5.5）：
// bsdtar 解压会还原包内时间戳，若包内时间早于 watchdog 记录的快照，watchdog 的「代码更新」
// 判定就永远不触发 → 新代码不生效但版本号已变（历史「提示完成但版本没变」的另一种形态）。
function bumpMtime(root) {
  const now = new Date();
  ['server.js', 'db.js', 'watchdog.js'].forEach(f => {
    const p = path.join(root, f);
    try { if (fs.existsSync(p)) fs.utimesSync(p, now, now); } catch (e) {}
  });
}

// 依赖自检（v1.5.5）：升级包不再携带 node_modules（22.5MB / 1139 文件 → 约 2MB / 92 文件），
// 若未来版本新增依赖而目标机没装，必须**明确报错**，而不是重启后 500。
function missingDeps(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    return deps.filter(d => !fs.existsSync(path.join(root, 'node_modules', d, 'package.json')));
  } catch (e) { return []; }
}

// 解压后校验：package.json 版本号必须已变为目标版本。
// 这是「提示完成但版本没变」的最后一道闸：不符直接判失败并给出可操作提示。
function verifyExtract(root, expectVersion) {
  const now = localVersion(root);
  if (!expectVersion || expectVersion === '999.0.0') return { ok: true, version: now, skipped: true };
  if (now !== expectVersion) {
    throw new Error('解压后版本号仍为 ' + now + '（目标 ' + expectVersion + '），文件未被覆盖。' +
      '常见原因：文件被占用或权限不足。请改用离线升级：powershell -ExecutionPolicy Bypass -File tools\\local-upgrade.ps1 -Zip "<update.zip路径>"');
  }
  return { ok: true, version: now };
}

// 重启：先解锁（让 watchdog 的 mtime 自动重载生效），再兜底 Restart-Service。
// 说明：不能用 Restart-Service 作为唯一路径 —— 进程树被 NSSM 杀掉时，detached 脚本可能一并终止，
//       且服务账号非管理员时 Restart-Service 会静默失败。watchdog 的 mtime 重载是最可靠的主路径。
function scheduleRestart(root) {
  setLock(root, false);
  upgradeLog(root, 'restart: 已解锁，等待 watchdog 自动重载（兜底 8s 后 Restart-Service）');
  const dry = process.env.KANBAN_UPGRADE_DRYRUN === '1';
  if (dry) { console.log('[upgrade] DRYRUN: 跳过真实重启 ' + SERVICE); return; }
  const ps = 'Start-Sleep -Seconds 8; try { Restart-Service ' + SERVICE + ' -Force -ErrorAction Stop } catch { }';
  try {
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
  } catch (e) {
    upgradeLog(root, 'restart: 兜底重启进程拉起失败（watchdog 主路径仍可生效）: ' + (e && e.message));
  }
}

// 启动后台升级任务（立即返回 taskId）；前端轮询 /api/admin/upgrade/status?taskId=xxx 拉进度
function startUpgrade(root, token) {
  const info = consumeToken(root, token);
  if (!info) throw new Error('token 无效或已过期，请重新点击「一键升级」');
  const taskId = require('crypto').randomBytes(12).toString('hex');
  const startedAt = Date.now();
  setTask(taskId, {
    phase: 'idle', progress: 0, message: '已启动，等待下载…',
    error: null, finished: false,
    startedAt, finishedAt: null,
    tag: info.tag, downloaded: 0, backup: null
  }, root);
  upgradeLog(root, `startUpgrade: taskId=${taskId.slice(0, 8)} tag=${info.tag} target=${info.version || '?'}`);
  // detached 后台任务（不 await，立即返回 taskId 给前端）
  (async () => {
    const tmp = path.join(root, 'upgrade-tmp-' + taskId + '.zip');
    let locked = false;
    try {
      // 阶段 1：下载（0% → 70%；下载占总耗时最大，给最大权重）
      setTask(taskId, { phase: 'download', progress: 0, message: '正在下载 update.zip…' }, root);
      await downloadWithRetry(root, info.assetUrl, tmp, (recv, total) => {
        const pct = total > 0 ? Math.min(70, Math.floor((recv / total) * 70)) : 0;
        const mb = (recv / 1048576).toFixed(1);
        const tot = total > 0 ? ' / ' + (total / 1048576).toFixed(1) + ' MB' : '';
        setTask(taskId, { phase: 'download', progress: pct, message: '正在下载 update.zip… ' + mb + ' MB' + tot, downloaded: recv }, root);
      }, info.assetSize || 0);
      setTask(taskId, { progress: 70, message: '下载完成，准备备份…' }, root);
      // 阶段 2：备份（70% → 85%）
      setTask(taskId, { phase: 'backup', progress: 72, message: '正在备份当前版本…' }, root);
      const bak = await backupDir(root);
      upgradeLog(root, `backup -> ${path.basename(bak)}`);
      setTask(taskId, { progress: 85, message: '备份完成 → ' + path.basename(bak), backup: path.basename(bak) }, root);
      // 阶段 3：解压（85% → 95%）—— 加锁，禁止 watchdog 在覆盖途中自杀
      setTask(taskId, { phase: 'extract', progress: 88, message: '正在解压并覆盖文件…' }, root);
      locked = setLock(root, true);
      upgradeLog(root, `extract: lock=${locked}`);
      const t0x = Date.now();
      let lastPct = -1;
      const how = await extractZip(tmp, root, (done, total) => {
        // 解压期间持续刷新锁心跳 + 上报真实进度（节流到"百分比变化才写状态"）
        touchLock(root);
        const pct = total > 0 ? 88 + Math.min(6, Math.floor((done / total) * 7)) : 88;
        if (pct !== lastPct) {
          lastPct = pct;
          setTask(taskId, { phase: 'extract', progress: pct, message: '正在解压覆盖文件… ' + done + (total ? ' / ' + total : '') + ' 项' }, root);
        }
      });
      bumpMtime(root); // 顶高入口文件 mtime，确保 watchdog 一定会热重载
      upgradeLog(root, `extract done via ${how}（${((Date.now() - t0x) / 1000).toFixed(1)}s）`);
      // 阶段 4：校验（95% → 98%）—— 版本号没变就是失败，绝不让前端误以为成功
      setTask(taskId, { phase: 'verify', progress: 95, message: '正在校验新版本…' }, root);
      const v = verifyExtract(root, info.version);
      upgradeLog(root, `verify ok: version=${v.version}`);
      // 阶段 4.5：依赖自检（升级包不含 node_modules → 新增依赖必须显式报错，不能留到重启后 500）
      const miss = missingDeps(root);
      if (miss.length) {
        throw new Error('升级包已覆盖（v' + v.version + '），但目标机缺少运行依赖：' + miss.join(', ') +
          '。请在该机执行 `npm install --omit=dev` 后重启服务（或改用带依赖的包：tools/build_update_zip.py --with-deps）。');
      }
      setTask(taskId, { progress: 98, message: '校验通过（v' + v.version + '），准备重启服务…' }, root);
      // 阶段 5：先落盘最终结果 → 再解锁重启（顺序不能反：解锁后进程可能立刻被 watchdog 杀掉）
      setTask(taskId, {
        phase: 'done', progress: 100,
        message: '升级完成，看板服务正在重启 → ' + info.tag,
        finished: true, finishedAt: Date.now()
      }, root);
      // 显式解锁（scheduleRestart 内也会兜底解锁一次）：解锁后 watchdog 才会热重载新代码
      setLock(root, false);
      scheduleRestart(root);
    } catch (e) {
      const msg = String((e && e.message) || e);
      upgradeLog(root, `ERROR: ${msg}`);
      setTask(taskId, {
        phase: 'error', progress: 0, message: '升级失败：' + msg,
        error: msg, finished: true, finishedAt: Date.now()
      }, root);
      if (locked) setLock(root, false); // 失败也必须解锁，否则 watchdog 的自动重载被永久禁用
    } finally {
      try {
        if (fs.existsSync(tmp)) {
          // v1.5.3：失败时保留 zip 现场（改名归档，便于人工诊断"两种解压都失败"类问题）；成功则删除
          const t = tasks.get(taskId);
          if (t && t.phase === 'error') {
            const keep = path.join(root, 'upgrade-failed-' + new Date().toISOString().replace(/[:.]/g, '-') + '.zip');
            try { fs.renameSync(tmp, keep); upgradeLog(root, '已保留失败现场 zip: ' + keep); }
            catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
          } else {
            fs.unlinkSync(tmp);
          }
        }
      } catch (e) { upgradeLog(root, '临时文件清理失败: ' + (e && e.message)); }
    }
  })().catch(e => {
    console.error('[upgrade] 后台任务异常:', e);
    upgradeLog(root, '后台任务异常: ' + ((e && e.message) || e));
  });
  return { ok: true, taskId, tag: info.tag };
}

// 兼容旧 API：直接同步跑完（保留给测试或老代码；线上前端应走 startUpgrade + 轮询）
async function applyUpgrade(root, token) {
  const info = consumeToken(root, token);
  if (!info) throw new Error('token 无效或已过期，请重新点击「一键升级」');
  const tmp = path.join(root, 'upgrade-tmp-' + Date.now() + '.zip');
  let locked = false;
  try {
    const size = await downloadWithRetry(root, info.assetUrl, tmp, null, info.assetSize || 0);
    const bak = await backupDir(root);
    locked = setLock(root, true);
    await extractZip(tmp, root);
    bumpMtime(root);
    verifyExtract(root, info.version);
    setLock(root, false);
    scheduleRestart(root);
    return { ok: true, downloaded: size, backup: path.basename(bak), restarting: true, tag: info.tag };
  } finally {
    if (locked) setLock(root, false);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { console.warn('[upgrade] 临时文件清理失败（不影响升级）:', e && e.message); }
  }
}

module.exports = {
  prepareUpgrade, startUpgrade, getTaskStatus, applyUpgrade,
  localVersion, getLatestRelease, cmpVer,
  extractZip, verifyExtract, missingDeps, bumpMtime, zipEntryCount, runChild,
  // 供 watchdog.js 复用同一套锁路径（避免两处硬编码不一致）
  isUpgradeLocked: isLocked, setUpgradeLock: setLock, touchUpgradeLock: touchLock
};
