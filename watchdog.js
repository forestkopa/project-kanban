// =========================================================
// 看板崩溃守护（watchdog）—— 本机开发调试版
// 每 15 秒探测本地服务：挂了自动拉起 server.js。
// 双实例：5180 = 演示版(--demo, 脱敏数据) ；5181 = 正式版(真实数据)
//
// 注意：本机已不再是生产环境（生产 = 极空间 NAS + systemd）。
//   - 公网隧道由 NAS 上的 cloudflared.service 负责，本机不再起隧道
//     （避免两条 cloudflared 抢同一条 Named Tunnel）
//   - 本机仅用于开发调试；日常访问请用 https://kanban.forestkopa.top
//   - NAS 部署文件见 deploy/ 目录（README-NAS.md 有完整步骤）
// =========================================================
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const INTERVAL = 15000;

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

log('守护已启动（本机开发调试版，每 ' + INTERVAL / 1000 + ' 秒检测；隧道由 NAS 负责，公网地址 https://kanban.forestkopa.top）');
setInterval(ensureServer, INTERVAL);
ensureServer();
