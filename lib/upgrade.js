/* 自动升级模块：从 GitHub Release 下载 update.zip → 备份 → 解压覆盖 → 重启看板服务
 * 设计：两阶段（prepare 比对+发一次性 token / confirm 执行），避免 CSRF 与误触。
 * 匿名下载：release asset 走 github.com CDN（非 api.github.com），不受 60/h API 限额约束。
 * 安全：仅在 admin 鉴权 + 有效 token 下执行；重启用 detached 进程，避免“自己杀自己”导致请求中断。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = 'forestkopa/project-kanban';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SERVICE = 'kanban-watchdog';
const TOKEN_TTL = 5 * 60 * 1000; // 5 分钟

const pending = new Map(); // token -> { exp, tag, assetUrl }

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
    // 测试 / 内网指定源：跳过 GitHub，强制需要升级
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

async function downloadFile(url, dest) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 180000);
  const r = await fetch(url, { headers: { 'User-Agent': 'kanban-upgrade' }, signal: ac.signal });
  clearTimeout(to);
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status + (r.status === 403 ? '（GitHub 匿名限流，建议稍后重试或手动升级）' : ''));
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
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
    // robocopy 退出码 0-7 均为成功；>7 才视为失败
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
  // detached + unref：让重启进程脱离当前 node（看板子进程），否则会被一起杀掉
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
}

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

module.exports = { prepareUpgrade, applyUpgrade, localVersion, getLatestRelease };
