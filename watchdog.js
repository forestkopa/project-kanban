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

// 升级锁（路径与 lib/upgrade.js 的 lockFile() 保持一致）：
// 一键升级解压覆盖期间会创建该文件。此时若继续按 mtime 判定「代码更新」并 taskkill server，
// 会把正在执行升级的进程杀掉 → 解压半途中断、任务状态随内存丢失 → 「提示完成但版本没变」。
// 有锁时：跳过代码热重载（端口挂了仍正常拉起），升级结束后由 upgrade.js 解锁。
//
// v1.5.5：锁带**心跳**——升级任务每推进一阶段 / 每解压一批文件就刷新锁内时间戳。
// 原缺陷：进程若在升级中途被强杀，锁文件残留 → 热重载被永久禁用（新代码永不生效、服务崩了也不自愈）。
// 现在读到超过 LOCK_STALE_MS 没刷新的锁即视为**过期残留**，直接忽略，自愈不受影响。
const LOCK_STALE_MS = 3 * 60 * 1000;
function upgradeLocked() {
  try {
    const p = path.join(ROOT, 'data', 'upgrade.lock');
    const st = fs.statSync(p);
    const raw = fs.readFileSync(p, 'utf8').trim();
    const ts = Number(raw) || st.mtimeMs;
    if (Date.now() - ts > LOCK_STALE_MS) return false; // 过期残留锁：不阻断自愈/热重载
    return true;
  } catch (e) { return false; }
}

// 忙碌判定阈值（v1.5.5）：端口仍在 LISTEN 但 HTTP 不响应 = 进程还活着、只是被冻住或正在启动，
// 不是「崩了」。生产实测：升级同步解压期间端口无响应 97s，原逻辑每 15s 就 spawn 一个新实例
// （实测连拉 8 次，全部在 EADDRINUSE 里空转退出），既救不了场还刷满日志。
const BUSY_GRACE_TICKS = 4;         // 无锁：连续 4 轮（≈60s）不响应 → 判定僵死，强制重启
const BUSY_GRACE_TICKS_LOCKED = 60; // 升级中：给足 ≈15 分钟（备份/解压各有 5 分钟硬超时兜底）

async function ensureServer() {
  const snap = newestMtime();
  const locked = upgradeLocked();
  for (const s of SERVERS) {
    if (await isUp(s.port)) {
      s.busyTicks = 0; // 端口响应正常：清空忙碌计数
      // 接管运行中实例时记录其 PID（watchdog 自身重启后也能自动重启它）
      if (!s.pid) s.pid = pidOfPort(s.port);
      if (locked) {
        // 升级进行中：只记录快照（若无）不重启，避免打断解压
        if (!s.snap) { s.snap = snap; log(s.name + ' 升级锁生效，接管实例（暂不热重载）'); }
        continue;
      }
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
    // 端口未响应：先区分「进程还活着只是忙」与「真崩了」（v1.5.5）
    // 端口仍在 LISTEN 说明进程存活（只是事件循环被占住/正在启动）→ 重复 spawn 只会撞 EADDRINUSE。
    const listenPid = pidOfPort(s.port);
    s.busyTicks = (s.busyTicks || 0) + 1;
    if (listenPid) {
      s.pid = listenPid;
      const grace = locked ? BUSY_GRACE_TICKS_LOCKED : BUSY_GRACE_TICKS;
      if (s.busyTicks <= grace) {
        if (s.busyTicks === 1) log(s.name + ' 端口 ' + s.port + ' 仍在监听（PID ' + listenPid + '）但暂不响应，判定为忙碌（升级/启动中），不重复拉起');
        continue;
      }
      log(s.name + ' 端口 ' + s.port + ' 连续 ' + s.busyTicks + ' 轮（≈' + Math.round(s.busyTicks * INTERVAL / 1000) + 's）无响应，判定为僵死，强制重启 PID ' + listenPid);
      try { spawnSync('taskkill', ['/F', '/PID', String(listenPid)], { timeout: 5000, stdio: 'ignore' }); } catch (e) {}
      s.pid = null;
    }
    // 端口未响应且无存活监听进程（或已强制清理僵死进程）：拉起新代码
    log(s.name + ' 未响应（端口 ' + s.port + '），重新拉起 server.js ' + s.args.join(' '));
    s.snap = snap; s.pid = null; s.busyTicks = 0;
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

// v1.5.5：把「隧道真断」与「源站拖累」分开——只看 statusCode<500 会把源站 502 误判成隧道故障。
// 生产实测：升级期间源站被同步解压冻住 → 公网 502 → 旧逻辑 taskkill cloudflared + 90s 冷却，
// 把一次 10-30 秒的正常中断放大成 9 分钟公网不可达（用户以为升级把服务搞挂了）。
function originProbe(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout: 2500 }, r => { r.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
// 本机源站是否有实例在正常响应（注意 typeof 守卫：单元测试只截取本代码块，SERVERS 不在作用域内）
async function anyOriginUp() {
  const list = (typeof SERVERS !== 'undefined' && SERVERS) || [];
  for (const s of list) { if (await originProbe(s.port)) return true; }
  return false;
}
// 升级进行中不重启隧道（typeof 守卫同因：单测截取的代码块里 upgradeLocked 不在作用域）
function tunnelBlockedByUpgrade() {
  return typeof upgradeLocked === 'function' ? upgradeLocked() : false;
}
let originDownLogged = false;

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
    tunnelFailCount = 0; originDownLogged = false;
    return;
  }
  // 首次失败：隔 2s 复查一次，降低偶发丢包误判
  await sleep(TUNNEL_RECHECK_DELAY);
  if (await isTunnelUp()) { log('公网复查通过，判定为偶发抖动，不重启'); tunnelFailCount = 0; originDownLogged = false; return; }

  // v1.5.5 闸门 1：升级进行中 → 公网 5xx 属预期（源站在覆盖文件/重启），重启隧道只会有害
  if (tunnelBlockedByUpgrade()) {
    tunnelFailCount = 0;
    if (!originDownLogged) { log('公网不可达，但升级进行中：判定为源站升级窗口，不重启隧道'); originDownLogged = true; }
    return;
  }
  // v1.5.5 闸门 2：本机源站自己都不响应 → 问题在源站（服务未起/正在重启），重启隧道无法解决
  if (!(await anyOriginUp())) {
    tunnelFailCount = 0;
    if (!originDownLogged) { log('公网不可达，且本机源站也无响应：问题在源站而非隧道，不重启隧道（避免 90s 冷却把中断放大）'); originDownLogged = true; }
    return;
  }
  originDownLogged = false;

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
