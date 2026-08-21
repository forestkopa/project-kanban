// =========================================================
// 看板崩溃守护（watchdog）
// 每 15 秒探测本地服务：挂了自动拉起 server.js；
// 同时保证 Cloudflare 隧道进程存活（新链接写入 data/tunnel-url.txt）。
// 由任务计划程序在登录时启动：node watchdog.js
// 双实例：5180 = 演示版(--demo, 公网隧道指向它)；5181 = 正式版(真实数据, 本机使用)
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
const TUNNEL_PORT = 5180;

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

function ensureTunnel() {
  if (cloudflaredRunning()) return;
  log('cloudflared 未运行，重新建立隧道（指向 5180 演示版）');
  try {
    const c = spawn(CLOUDFLARED, ['tunnel', '--url', 'http://localhost:' + TUNNEL_PORT, '--no-autoupdate'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    c.unref();
    c.stdout.on('data', d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { try { fs.writeFileSync(URL_FILE, m[0], 'utf8'); log('隧道地址: ' + m[0]); } catch (e) {} }
    });
  } catch (e) { log('隧道拉起失败: ' + e.message); }
}

log('守护已启动（每 ' + INTERVAL / 1000 + ' 秒检测一次，双实例：5180 演示 / 5181 正式）');
setInterval(() => { ensureServer(); ensureTunnel(); }, INTERVAL);
ensureServer();
ensureTunnel();
