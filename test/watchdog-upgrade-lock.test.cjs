// 升级锁 + 忙碌判定回归测试（watchdog.js ensureServer）
// 背景（v1.5.1 修复）：一键升级解压期间会逐文件覆盖 server.js / public / lib，
// 文件 mtime 随之变化 → watchdog 判定「代码更新」并 taskkill 掉【正在执行升级的 server 进程】
// → 解压半途中断 + 任务状态（内存）丢失 → 前端看到「任务结束」但版本没变。
// 修复：升级期间 data/upgrade.lock 存在时，watchdog 跳过代码热重载（端口挂了仍照常拉起）。
//
// v1.5.5 新增（生产实测复现，2026-09-10）：
//   ① 锁**心跳**：锁内时间戳超过 LOCK_STALE_MS 未刷新 = 过期残留锁（升级进程已被杀），
//      必须忽略它，否则自愈被永久禁用（服务崩了也不拉起、新代码永不生效）。
//   ② **忙碌判定**：端口仍在 LISTEN（进程活着）但不响应 ≠ 崩溃 —— 原逻辑每 15s 就 spawn 一个
//      新 server（生产实测升级期间连拉 8 次，全部撞 EADDRINUSE 空转退出）。现在：
//      监听进程存活 → 按宽限期跳过；持续超过宽限期（真僵死）→ 强制重启。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'watchdog.js');
const raw = fs.readFileSync(SRC, 'utf8');

const startMark = 'const WATCH_PATHS';
const endMark = '/* ---- 隧道守护';
const si = raw.indexOf(startMark);
const ei = raw.indexOf(endMark);
assert.ok(si >= 0 && ei > si, '未能定位 ensureServer 代码块（watchdog.js 结构变更？）');
let block = raw.slice(si, ei);

// 注入：端口存活可控、监听进程 PID 可控、进程操作记账、日志静默
block = block.replace(/function isUp\(port\)[\s\S]*?\n}/, 'function isUp(port) { return Promise.resolve(!!global.__portUp); }');
block = block.replace(/function pidOfPort\(port\)[\s\S]*?\n}/, 'function pidOfPort(port) { return global.__listenPid === undefined ? 4321 : global.__listenPid; }');
  // 注意：log 是单行函数，用 [^\n]* 限定，否则贪婪匹配会吞掉后面的 upgradeLocked()
  block = block.replace(/function log\(msg\) \{[^\n]*\}/, 'function log(msg) { global.__logs.push(String(msg)); }');
  assert.ok(/function upgradeLocked\(\)/.test(block), 'upgradeLocked 应仍在代码块内（正则误替换？）');
  assert.ok(/LOCK_STALE_MS/.test(block), '锁心跳常量 LOCK_STALE_MS 应仍在代码块内');
  assert.ok(/BUSY_GRACE_TICKS/.test(block), '忙碌宽限常量应仍在代码块内');

function build(ROOT) {
  const calls = { taskkill: 0, spawn: 0, killArgs: [] };
  global.__logs = [];
  const factory = new Function(
    'ROOT', 'NODE', 'SERVER', 'fs', 'path', 'spawnSync', 'spawn', 'INTERVAL',
    block + '\nreturn { ensureServer, SERVERS, upgradeLocked, BUSY_GRACE_TICKS };'
  );
  const mod = factory(
    ROOT,
    'node.exe',
    path.join(ROOT, 'server.js'),
    fs,
    path,
    (cmd, args) => { if (String(cmd).includes('taskkill')) { calls.taskkill++; calls.killArgs.push(args); } return { stdout: '' }; },
    () => { calls.spawn++; return { unref() {}, on() {}, pid: 999 }; },
    15000
  );
  return { mod, calls };
}

function freshRoot() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-wd-lock-'));
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'server.js'), '// mock\n');
  return ROOT;
}
const touchLater = (p) => {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(p, t, t);
};
const writeLock = (ROOT, ts) => fs.writeFileSync(path.join(ROOT, 'data', 'upgrade.lock'), String(ts === undefined ? Date.now() : ts), 'utf8');
const cleanup = (ROOT) => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {} };

(async () => {
  try {
    // 场景1：无锁 + 代码更新 → 应重启（原行为不退化）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = true;
      await mod.ensureServer();               // 首次接管：只记快照
      touchLater(path.join(ROOT, 'server.js'));
      await mod.ensureServer();               // 代码更新：应 taskkill
      assert.ok(calls.taskkill > 0, '无锁时代码更新应触发重启（taskkill）');
      console.log('✓ 场景1 无锁：代码更新正常热重载（不退化）');
      cleanup(ROOT);
    }

    // 场景2：升级锁存在 + 代码更新 → 绝不重启（核心修复）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = true;
      await mod.ensureServer();               // 首次接管
      writeLock(ROOT);
      touchLater(path.join(ROOT, 'server.js'));
      await mod.ensureServer();               // 升级中：不应杀进程
      assert.strictEqual(calls.taskkill, 0, '升级锁生效期间禁止 taskkill 掉正在升级的进程');
      console.log('✓ 场景2 有锁：解压期间不打断升级进程（核心修复）');
      cleanup(ROOT);
    }

    // 场景3a（v1.5.5）：有锁 + 端口不响应 + 监听进程已消失（真崩了）→ 必须拉起（自愈不失效）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = false;
      global.__listenPid = null;              // 端口无监听 → 进程确实没了
      writeLock(ROOT);
      await mod.ensureServer();
      assert.ok(calls.spawn > 0, '进程真崩（端口无监听）时必须拉起，锁不能挡住自愈');
      console.log('✓ 场景3a 有锁 + 进程真崩：仍能拉起（自愈不失效）');
      cleanup(ROOT);
    }

    // 场景3b（v1.5.5 核心）：有锁 + 端口不响应但**监听进程仍在**（升级同步解压冻住事件循环）
    // → 不得重复 spawn（生产实测原逻辑连拉 8 个实例，全部 EADDRINUSE 空转）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = false;
      global.__listenPid = 7777;
      writeLock(ROOT);
      for (let i = 0; i < 10; i++) await mod.ensureServer();
      assert.strictEqual(calls.spawn, 0, '监听进程仍存活时不得重复拉起实例（实测会连拉 8 次）');
      assert.ok(global.__logs.some(l => /判定为忙碌/.test(l)), '应打印「判定为忙碌」日志：' + JSON.stringify(global.__logs));
      console.log('✓ 场景3b 正在升级 + 端口暂不响应：判定忙碌，不重复拉起（核心修复）');
      cleanup(ROOT);
    }

    // 场景3c（v1.5.5）：无锁 + 端口不响应 + 监听进程仍在，但持续超过宽限期 → 判定僵死，强制重启
    // 注意：真实 SERVERS 有两个实例（5180/5181），断言按「每个僵死实例各 kill 一次」计数
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = false;
      global.__listenPid = 8888;
      const n = mod.SERVERS.length;
      for (let i = 0; i < mod.BUSY_GRACE_TICKS + 1; i++) await mod.ensureServer();
      assert.strictEqual(calls.taskkill, n, '持续无响应超过宽限期应逐个强制 taskkill 僵死进程，实际=' + calls.taskkill);
      assert.ok(calls.killArgs.every(a => a[0] === '/F' && a[1] === '/PID' && a[2] === '8888'), '应精确 kill 端口监听者 PID，实际=' + JSON.stringify(calls.killArgs));
      assert.strictEqual(calls.spawn, n, '清理僵死进程后应拉起新实例，实际=' + calls.spawn);
      console.log('✓ 场景3c 无锁 + 持续无响应超宽限：强制重启僵死进程（兜底不失效）');
      cleanup(ROOT);
    }

    // 场景4（v1.5.5）：过期残留锁（升级进程被杀）→ 视为无锁，不能永久禁用自愈/热重载
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = false;
      global.__listenPid = null;
      writeLock(ROOT, Date.now() - 10 * 60 * 1000);   // 10 分钟前的残留锁（无心跳刷新）
      assert.strictEqual(mod.upgradeLocked(), false, '过期残留锁必须判定为「无锁」');
      await mod.ensureServer();
      assert.ok(calls.spawn > 0, '过期锁存在时端口挂了仍必须拉起（自愈不能被残留锁永久禁用）');
      console.log('✓ 场景4 过期残留锁：自动忽略，自愈/热重载不失效');
      cleanup(ROOT);
    }

    // 场景5（v1.5.5）：新鲜锁（有心跳）→ 仍正常生效
    {
      const ROOT = freshRoot();
      const { mod } = build(ROOT);
      writeLock(ROOT, Date.now() - 10 * 1000);        // 10 秒前刷新 = 新鲜
      assert.strictEqual(mod.upgradeLocked(), true, '心跳新鲜的锁必须继续生效');
      console.log('✓ 场景5 锁心跳新鲜：仍正常抑制热重载');
      cleanup(ROOT);
    }

    console.log('\n=== 升级锁 + 忙碌判定（watchdog）测试全部通过 ===');
    process.exit(0);
  } catch (e) {
    console.error('\n✗ 升级锁测试失败:', e.message);
    process.exit(1);
  }
})();
