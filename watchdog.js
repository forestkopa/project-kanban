// =========================================================
// 看板崩溃守护（watchdog）—— 本机模式（生产切换回本机）
// 每 15 秒探测：本地服务 + cloudflared 隧道，挂了自动拉起。
// 双实例：5180 = 演示版(--demo, 脱敏数据) ；5181 = 正式版(真实数据)
// 公网隧道：本机跑 cloudflared Named Tunnel（kanban.forestkopa.top → 5180）
//   曾切到 NAS 部署（deploy/README-NAS.md），因 NAS 暂不支持 Ubuntu VM，
//   恢复本机负责隧道；NAS Docker 方案就绪后可按 deploy/ 迁移。
// =========================================================
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const INTERVAL = 15000;
// cloudflared 可执行文件：默认本机路径；服务器部署可用环境变量 CLOUDFLARED_PATH 覆盖（见 tools/deploy-server.ps1）
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || 'C:/Users/Administrator/.cloudflared/cloudflared.exe';
const TUNNEL_CONFIG = path.join(ROOT, 'config.yml');
const TUNNEL_URL = 'https://kanban.forestkopa.top';

// 监控的代码路径（任一 mtime 更新 → 自动重启对应 server，无需手动杀进程）
const WATCH_PATHS = [SERVER, path.join(ROOT, 'db.js'), path.join(ROOT, 'lib'), path.join(ROOT, 'public')];
function newestMtime() {
  let max = 0;
  const scan = p => {
    let st; try { st = fs.statSync(p); } catch (e) { return; }
    if (st.mtimeMs > max) max = st.mtimeMs;
    if (st.isDirectory()) {
      let es; try { es = fs.readdirSync(p); } catch (e) { return; }
      es.forEach(n => scan(path.join(p, n)));
    }
  };
  WATCH_PATHS.forEach(scan);
  return max;
}

// 守护的实例：演示版(--demo 免令牌脱敏数据) + 正式版(真实数据需令牌)
// snap = 该实例当前运行代码的文件快照；child = 当前 server 子进程句柄；pid = 端口监听进程 PID（接管场景）
const SERVERS = [
  { port: 5180, args: ['--demo'], env: {}, name: '演示版(开发调试)', snap: 0, child: null, pid: null },
  { port: 5181, args: [], env: { PORT: '5181' }, name: '正式版(开发调试)', snap: 0, child: null, pid: null }
];

function isUp(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, r => { r.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 端口对应的监听进程 PID（接管运行中实例时用于自动重启）
function pidOfPort(port) {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000 }).stdout || '';
    const line = out.split('\n').find(l => l.includes(':' + port) && l.includes('LISTENING'));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    return parts[parts.length - 1] || null;
  } catch (e) { return null; }
}

function log(msg) { console.log(new Date().toISOString() + ' [watchdog] ' + msg); }

async function ensureServer() {
  const snap = newestMtime();
  for (const s of SERVERS) {
    if (await isUp(s.port)) {
      // 接管运行中实例时记录其 PID（watchdog 自身重启后也能自动重启它）
      if (!s.pid) s.pid = pidOfPort(s.port);
      // 端口活着：检测到代码更新 → 杀掉当前进程，下一轮自动用新代码拉起
      if (s.snap && snap > s.snap) {
        log(s.name + ' 检测到代码更新（端口 ' + s.port + '），自动重启');
        s.snap = snap;
        if (s.child && !s.child.killed) { try { s.child.kill(); } catch (e) {} }
        if (s.pid) { try { spawnSync('taskkill', ['/F', '/PID', String(s.pid)], { timeout: 5000, stdio: 'ignore' }); } catch (e) {} }
        s.child = null; s.pid = null;
      } else if (!s.snap) {
        // 首次接管：只记录快照，不杀健康进程
        s.snap = snap;
        log(s.name + ' 接管运行中实例（端口 ' + s.port + '），记录代码快照');
      }
      continue;
    }
    // 端口未响应：拉起新代码
    log(s.name + ' 未响应（端口 ' + s.port + '），重新拉起 server.js ' + s.args.join(' '));
    s.snap = snap; s.pid = null;
    try {
      const child = spawn(NODE, [SERVER, ...s.args], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, ...s.env } });
      child.unref();
      child.on('exit', () => { if (s.child && s.child === child) { s.child = null; s.pid = null; } });
      s.child = child; s.pid = child.pid;
    } catch (e) { log('拉起失败: ' + e.message); }
  }
}

/* ---- 隧道守护：公网健康探测（进程存在 ≠ 隧道健康，曾有僵死进程骗过检测） ----
 * 稳定性改造（2026-09-02）：原逻辑「单次探测失败 → 立即 taskkill + 重拉」过于激进，
 * 公司宽带偶发丢包即误判，且重连期间公网完全不可达，重连慢时更陷入「每 15s 重启」循环。
 * 新逻辑：双次确认 + 连续 N 次才重启 + 重启后冷却（给隧道握手时间）。
 */
const TUNNEL_FAIL_THRESHOLD = 3;   // 连续确认失败 N 次才真正重启（避免单次抖动误杀）
const TUNNEL_COOLDOWN = 90000;     // 重启后冷却 90s（隧道握手约 10-30s，冷却期内不重复探测/重启）
const TUNNEL_RECHECK_DELAY = 2000; // 首次失败后隔 2s 复查一次（双次确认）
let tunnelFailCount = 0;
let tunnelLastRestart = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isTunnelUp() {
  return new Promise(resolve => {
    const req = https.get(TUNNEL_URL, { timeout: 6000 }, r => { r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function ensureTunnel() {
  if (process.env.KANBAN_NO_TUNNEL) { log('开发机模式：跳过公网隧道接管（KANBAN_NO_TUNNEL=1）'); return; }
  // 冷却期：刚重启过，隧道正在握手，此期间不再探测也不再重启（避免反复 kill 导致长时间不可达）
  if (tunnelLastRestart && Date.now() - tunnelLastRestart < TUNNEL_COOLDOWN) return;

  if (await isTunnelUp()) {
    if (tunnelFailCount) log('公网已恢复，失败计数清零（' + tunnelFailCount + ' → 0）');
    tunnelFailCount = 0;
    return;
  }
  // 首次失败：隔 2s 复查一次，降低偶发丢包误判
  await sleep(TUNNEL_RECHECK_DELAY);
  if (await isTunnelUp()) { log('公网复查通过，判定为偶发抖动，不重启'); tunnelFailCount = 0; return; }

  tunnelFailCount++;
  if (tunnelFailCount < TUNNEL_FAIL_THRESHOLD) {
    log('公网不可达（连续确认失败 ' + tunnelFailCount + '/' + TUNNEL_FAIL_THRESHOLD + ' 次），暂不重启');
    return;
  }

  // 连续多次确认失败 → 判定隧道真挂了，执行重启
  tunnelFailCount = 0;
  tunnelLastRestart = Date.now();
  log('公网连续不可达，清理残留并重启 Named Tunnel（' + TUNNEL_URL + '）；后续 ' + (TUNNEL_COOLDOWN / 1000) + 's 冷却期内不再重启');
  try { spawnSync('taskkill', ['/F', '/IM', 'cloudflared.exe'], { timeout: 5000, stdio: 'ignore' }); } catch (e) {}
  try { spawn(CLOUDFLARED, ['tunnel', '--protocol', 'http2', '--config', TUNNEL_CONFIG, 'run'], { detached: true, stdio: 'ignore' }).unref(); }
  catch (e) { log('隧道拉起失败: ' + e.message); }
}

log('守护已启动（本机模式，每 ' + INTERVAL / 1000 + ' 秒检测；本机负责公网隧道 ' + TUNNEL_URL + '）');
// 错误边界（2026-08-25 两轮评审）：allSettled 吞掉未处理拒绝，周期回调不因单次异常崩溃
setInterval(() => {
  try { Promise.allSettled([ensureServer(), ensureTunnel()]); }
  catch (e) { log('守护周期异常: ' + e.message); }
}, INTERVAL);
Promise.allSettled([ensureServer(), ensureTunnel()]);
