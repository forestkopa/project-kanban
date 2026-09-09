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
function setLock(root, on) {
  try {
    if (on) { fs.writeFileSync(lockFile(root), String(Date.now()), 'utf8'); return true; }
    if (fs.existsSync(lockFile(root))) fs.unlinkSync(lockFile(root));
    return true;
  } catch (e) { upgradeLog(root, '锁操作失败(' + (on ? '加锁' : '解锁') + '): ' + (e && e.message)); return false; }
}
function isLocked(root) {
  try { return fs.existsSync(lockFile(root)); } catch (e) { return false; }
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
    ws.end();
    try { reader.releaseLock(); } catch (e) {}
  }
  return received;
}

// 带重试的下载：弱网/公司宽带下 40MB 包容易中断，重试 2 次
async function downloadWithRetry(root, url, dest, onProgress) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const size = await downloadFileWithProgress(url, dest, onProgress);
      const st = (function () { try { return fs.statSync(dest).size; } catch (e) { return 0; } })();
      upgradeLog(root, `download ok: ${(st / 1048576).toFixed(1)}MB (第 ${i} 次尝试)`);
      if (st < 1024) throw new Error('下载文件过小（' + st + ' B），疑似失败');
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

function backupDir(root) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(root, 'data-backup-upgrade-' + ts);
  fs.mkdirSync(bak, { recursive: true });
  const xd = ['node_modules', '.git', '.workbuddy', 'backups', 'data-backup-*', 'upgrade-tmp-*', 'upgrade-new-*', 'logs'];
  const xf = ['*.log', '*.tmp', '*.zip', '*.patch'];
  const args = [JSON.stringify(root), JSON.stringify(bak), '/E', '/XD', ...xd.map(JSON.stringify), '/XF', ...xf.map(JSON.stringify), '/NFL', '/NDL', '/NJH', '/NJS'];
  try {
    cp.execSync('robocopy ' + args.join(' '), { windowsHide: true });
  } catch (e) {
    if (e.status === undefined || e.status > 7) throw new Error('备份失败: ' + (e.message || e.status));
  }
  return bak;
}

// 解压：优先系统内置 tar.exe（bsdtar，支持 zip、无 260 字符路径限制），失败回退 Expand-Archive。
// 两者任一成功即视为解压完成；都失败则抛错（由上层判 error，绝不静默"完成"）。
function extractZip(zipPath, root) {
  const errs = [];
  // 方案 A：tar.exe（Windows 10 17063+ 内置）
  try {
    cp.execSync('tar.exe -xf ' + JSON.stringify(zipPath) + ' -C ' + JSON.stringify(root),
      { windowsHide: true, stdio: 'pipe', timeout: 600000 });
    return 'tar';
  } catch (e) {
    errs.push('tar: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
  }
  // 方案 B：PowerShell Expand-Archive（PS 5.1 兜底）
  const ps = '$ErrorActionPreference="Stop"; Expand-Archive -Path ' + JSON.stringify(zipPath).replace(/\$/g, '`$') +
    ' -DestinationPath ' + JSON.stringify(root).replace(/\$/g, '`$') + ' -Force';
  try {
    cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(ps),
      { windowsHide: true, stdio: 'pipe', timeout: 600000 });
    return 'expand';
  } catch (e) {
    errs.push('Expand-Archive: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
  }
  throw new Error('解压失败（两种方式均失败）：' + errs.join(' | '));
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
      });
      setTask(taskId, { progress: 70, message: '下载完成，准备备份…' }, root);
      // 阶段 2：备份（70% → 85%）
      setTask(taskId, { phase: 'backup', progress: 72, message: '正在备份当前版本…' }, root);
      const bak = backupDir(root);
      upgradeLog(root, `backup -> ${path.basename(bak)}`);
      setTask(taskId, { progress: 85, message: '备份完成 → ' + path.basename(bak), backup: path.basename(bak) }, root);
      // 阶段 3：解压（85% → 95%）—— 加锁，禁止 watchdog 在覆盖途中自杀
      setTask(taskId, { phase: 'extract', progress: 88, message: '正在解压并覆盖文件…' }, root);
      locked = setLock(root, true);
      upgradeLog(root, `extract: lock=${locked}`);
      const how = extractZip(tmp, root);
      upgradeLog(root, `extract done via ${how}`);
      // 阶段 4：校验（95% → 98%）—— 版本号没变就是失败，绝不让前端误以为成功
      setTask(taskId, { phase: 'verify', progress: 95, message: '正在校验新版本…' }, root);
      const v = verifyExtract(root, info.version);
      upgradeLog(root, `verify ok: version=${v.version}`);
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
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { upgradeLog(root, '临时文件清理失败: ' + (e && e.message)); }
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
    const size = await downloadWithRetry(root, info.assetUrl, tmp, null);
    const bak = backupDir(root);
    locked = setLock(root, true);
    extractZip(tmp, root);
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
  // 供 watchdog.js 复用同一套锁路径（避免两处硬编码不一致）
  isUpgradeLocked: isLocked, setUpgradeLock: setLock
};
