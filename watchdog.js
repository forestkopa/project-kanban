// =========================================================
// 看板崩溃守护（watchdog）
// 每 15 秒探测本地服务：挂了自动拉起 server.js；
// 同时保证 Cloudflare Named Tunnel 进程存活（固定地址见 FIXED_TUNNEL_URL）。
// 由任务计划程序在登录时启动：node watchdog.js
// 双实例：5180 = 演示版(--demo, 公网隧道指向它)；5181 = 正式版(真实数据, 本机使用)
// 隧道已固化：统一用 Named Tunnel（kanban.forestkopa.top），不再使用 trycloudflare 快速隧道
// =========================================================
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const CLOUDFLARED = 'C:/Users/Administrator/.workbuddy/binaries/cloudflared/cloudflared.exe';
const URL_FILE = path.join(ROOT, 'data', 'tunnel-url.txt');
const INTERVAL = 15000;

// Named Tunnel 配置与固定公网地址（不再使用 trycloudflare 随机地址）
const TUNNEL_CONFIG = path.join(ROOT, 'config.yml');
const FIXED_TUNNEL_URL = 'https://kanban.forestkopa.top';

// 守护的实例：演示版(--demo 免令牌脱敏数据) + 正式版(真实数据需令牌)
const SERVERS = [
  { port: 5180, args: ['--demo'], env: {}, name: '演示版(公网评委)' },
  { port: 5181, args: [], env: { PORT: '5181' }, name: '正式版(本机日常)' }
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

function cloudflaredRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH', { encoding: 'utf8', timeout: 5000 });
    return out.includes('cloudflared.exe');
  } catch (e) { return false; }
}

// 固化：只守护 Named Tunnel（固定地址 kanban.forestkopa.top），不再起 trycloudflare 快速隧道
function ensureTunnel() {
  if (cloudflaredRunning()) return;
  log('cloudflared 未运行，重新拉起 Named Tunnel（固定地址 ' + FIXED_TUNNEL_URL + '）');
  try {
    const c = spawn(CLOUDFLARED, ['tunnel', '--config', TUNNEL_CONFIG, 'run'], { cwd: ROOT, detached: true, stdio: 'ignore' });
    c.unref();
    // 固定地址，无需动态抓取，直接写入
    try { fs.writeFileSync(URL_FILE, FIXED_TUNNEL_URL, 'utf8'); } catch (e) {}
  } catch (e) { log('隧道拉起失败: ' + e.message); }
}

log('守护已启动（每 ' + INTERVAL / 1000 + ' 秒检测一次，双实例：5180 演示 / 5181 正式；隧道：Named Tunnel ' + FIXED_TUNNEL_URL + '）');
setInterval(() => { ensureServer(); ensureTunnel(); }, INTERVAL);
ensureServer();
ensureTunnel();
