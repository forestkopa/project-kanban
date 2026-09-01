/* 自动升级模块：从 GitHub Release 下载 update.zip → 备份 → 解压覆盖 → 重启看板服务
 * 设计：两阶段（prepare 比对+发一次性 token / confirm 启动后台任务）；后台任务分阶段推送进度
 *       前端可轮询 /api/admin/upgrade/status 拉快照（taskId 索引），不再依赖长连接或 SSE。
 * 匿名下载：release asset 走 github.com CDN（非 api.github.com），不受 60/h API 限额约束。
 * 安全：仅在 admin 鉴权 + 有效 token 下执行；重启用 detached 进程，避免"自己杀自己"导致请求中断。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = 'forestkopa/project-kanban';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SERVICE = 'kanban-watchdog';
const TOKEN_TTL = 5 * 60 * 1000; // 5 分钟
const TASK_TTL = 10 * 60 * 1000; // 任务状态保留 10 分钟（完成后保留供前端拉取最终结果）

const pending = new Map();   // token -> { exp, tag, assetUrl }
const tasks = new Map();     // taskId -> { phase, progress, message, error, finished, startedAt, finishedAt, tag, backup, downloaded }

function localVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}
function cmpVer(a, b) {
  const pa = ('' + a).split('.').map(x => parseInt(x, 10) || 0);
  const pb = ('' + b).split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function getLatestRelease() {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 10000);
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
  const need = cmpVer(rel.version, local) > 0;
  let token = null;
  if (need) {
    token = require('crypto').randomBytes(16).toString('hex');
    pending.set(token, { exp: Date.now() + TOKEN_TTL, tag: rel.tag, assetUrl: rel.assetUrl });
    setTimeout(() => pending.delete(token), TOKEN_TTL).unref?.();
  }
  return {
    need, local, latest: rel.version, tag: rel.tag, url: rel.url,
    assetUrl: rel.assetUrl, assetSize: rel.assetSize, token
  };
}

function consumeToken(token) {
  if (!token) return null;
  const e = pending.get(token);
  if (!e) return null;
  pending.delete(token);
  if (e.exp < Date.now()) return null;
  return e;
}

// 任务快照：给前端轮询用（只暴露必要字段，不含内部路径）
function getTaskStatus(taskId) {
  const t = tasks.get(taskId);
  if (!t) return null;
  return {
    taskId,
    phase: t.phase,       // idle | download | backup | extract | restart | done | error
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
}

function setTask(taskId, patch) {
  const cur = tasks.get(taskId) || {};
  tasks.set(taskId, { ...cur, ...patch });
  // 完成后保留 TASK_TTL，让前端重连能拉到最终结果
  if (patch.finished) {
    setTimeout(() => tasks.delete(taskId), TASK_TTL).unref?.();
  }
}

// 流式下载 + 进度回调（边下边写盘，节省内存，可推送 percent）
async function downloadFileWithProgress(url, dest, onProgress) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 180000);
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

function backupDir(root) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(root, 'data-backup-upgrade-' + ts);
  fs.mkdirSync(bak, { recursive: true });
  const xd = ['node_modules', '.git', '.workbuddy', 'backups', 'data-backup-*', 'upgrade-tmp-*'];
  const xf = ['*.log', '*.tmp', '*.zip', '*.patch'];
  const args = [JSON.stringify(root), JSON.stringify(bak), '/E', '/XD', ...xd.map(JSON.stringify), '/XF', ...xf.map(JSON.stringify), '/NFL', '/NDL', '/NJH', '/NJS'];
  try {
    cp.execSync('robocopy ' + args.join(' '), { windowsHide: true });
  } catch (e) {
    if (e.status === undefined || e.status > 7) throw new Error('备份失败: ' + (e.message || e.status));
  }
  return bak;
}

function extractZip(zipPath, root) {
  const ps = `Expand-Archive -Path "${zipPath}" -DestinationPath "${root}" -Force`;
  cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(ps), { windowsHide: true });
}

function scheduleRestart() {
  const dry = process.env.KANBAN_UPGRADE_DRYRUN === '1';
  const ps = 'Start-Sleep -Seconds 3; Restart-Service ' + SERVICE + ' -Force';
  if (dry) { console.log('[upgrade] DRYRUN: 跳过真实重启 ' + SERVICE); return; }
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
}

// 启动后台升级任务（立即返回 taskId）；前端轮询 /api/admin/upgrade/status?taskId=xxx 拉进度
function startUpgrade(root, token) {
  const info = consumeToken(token);
  if (!info) throw new Error('token 无效或已过期，请重新点击「一键升级」');
  const taskId = require('crypto').randomBytes(12).toString('hex');
  const startedAt = Date.now();
  setTask(taskId, {
    phase: 'idle', progress: 0, message: '已启动，等待下载…',
    error: null, finished: false,
    startedAt, finishedAt: null,
    tag: info.tag, downloaded: 0, backup: null
  });
  // detached 后台任务（不 await，立即返回 taskId 给前端）
  (async () => {
    const tmp = path.join(root, 'upgrade-tmp-' + taskId + '.zip');
    try {
      // 阶段 1：下载（0% → 70%；下载占总耗时最大，给最大权重）
      setTask(taskId, { phase: 'download', progress: 0, message: '正在下载 update.zip…' });
      const size = await downloadFileWithProgress(info.assetUrl, tmp, (recv, total) => {
        const pct = total > 0 ? Math.min(70, Math.floor((recv / total) * 70)) : 0;
        const mb = (recv / 1048576).toFixed(1);
        const tot = total > 0 ? ' / ' + (total / 1048576).toFixed(1) + ' MB' : '';
        setTask(taskId, { phase: 'download', progress: pct, message: '正在下载 update.zip… ' + mb + ' MB' + tot, downloaded: recv });
      });
      setTask(taskId, { progress: 70, message: '下载完成，准备备份…' });
      // 阶段 2：备份（70% → 85%）
      setTask(taskId, { phase: 'backup', progress: 72, message: '正在备份当前版本（data/）…' });
      const bak = backupDir(root);
      setTask(taskId, { progress: 85, message: '备份完成 → ' + path.basename(bak), backup: path.basename(bak) });
      // 阶段 3：解压（85% → 98%）
      setTask(taskId, { phase: 'extract', progress: 88, message: '正在解压并覆盖文件…' });
      extractZip(tmp, root);
      setTask(taskId, { progress: 98, message: '解压完成，准备重启服务…' });
      // 阶段 4：触发重启（98% → 100%）
      setTask(taskId, { phase: 'restart', progress: 99, message: '正在重启看板服务（约 10-30 秒）…' });
      scheduleRestart();
      setTask(taskId, { phase: 'done', progress: 100, message: '升级完成，看板服务正在重启 → ' + info.tag, finished: true, finishedAt: Date.now() });
    } catch (e) {
      setTask(taskId, { phase: 'error', progress: 0, message: '升级失败：' + (e && e.message || e), error: String(e && e.message || e), finished: true, finishedAt: Date.now() });
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { console.warn('[upgrade] 临时文件清理失败:', e && e.message); }
    }
  })().catch(e => console.error('[upgrade] 后台任务异常:', e));
  return { ok: true, taskId, tag: info.tag };
}

// 兼容旧 API：直接同步跑完（保留给测试或老代码；线上前端应走 startUpgrade + 轮询）
async function applyUpgrade(root, token) {
  const info = consumeToken(token);
  if (!info) throw new Error('token 无效或已过期，请重新点击「一键升级」');
  const tmp = path.join(root, 'upgrade-tmp-' + Date.now() + '.zip');
  try {
    const size = await downloadFile(info.assetUrl, tmp);
    const bak = backupDir(root);
    extractZip(tmp, root);
    scheduleRestart();
    return { ok: true, downloaded: size, backup: path.basename(bak), restarting: true, tag: info.tag };
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { console.warn('[upgrade] 临时文件清理失败（不影响升级）:', e && e.message); }
  }
}

module.exports = { prepareUpgrade, startUpgrade, getTaskStatus, applyUpgrade, localVersion, getLatestRelease };
