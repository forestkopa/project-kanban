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

const ROOT = __dirname;
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const INTERVAL = 15000;
const CLOUDFLARED = 'C:/Users/Administrator/.cloudflared/cloudflared.exe';
const TUNNEL_CONFIG = path.join(ROOT, 'config.yml');
const TUNNEL_URL = 'https://kanban.forestkopa.top';

// 守护的实例：演示版(--demo 免令牌脱敏数据) + 正式版(真实数据需令牌)
const SERVERS = [
  { port: 5180, args: ['--demo'], env: {}, name: '演示版(开发调试)' },
  { port: 5181, args: [], env: { PORT: '5181' }, name: '正式版(开发调试)' }
];

function isUp(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, r => { r.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function log(msg) { console.log(new Date().toISOString() + ' [watchdog] ' + msg); }

async function ensureServer() {
  for (const s of SERVERS) {
    if (await isUp(s.port)) continue;
    log(s.name + ' 未响应（端口 ' + s.port + '），重新拉起 server.js ' + s.args.join(' '));
    try { spawn(NODE, [SERVER, ...s.args], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, ...s.env } }).unref(); }
    catch (e) { log('拉起失败: ' + e.message); }
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
