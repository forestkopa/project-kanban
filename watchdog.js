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

/* ---- 隧道守护：公网健康探测（进程存在 ≠ 隧道健康，曾有僵死进程骗过检测） ---- */
function isTunnelUp() {
  return new Promise(resolve => {
    const req = https.get(TUNNEL_URL, { timeout: 6000 }, r => { r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function ensureTunnel() {
  if (await isTunnelUp()) return;
  log('公网不可达，清理残留并重启 Named Tunnel（' + TUNNEL_URL + '）');
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
