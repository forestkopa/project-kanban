// 升级锁回归测试（watchdog.js ensureServer）
// 背景（v1.5.1 修复）：一键升级解压期间会逐文件覆盖 server.js / public / lib，
// 文件 mtime 随之变化 → watchdog 判定「代码更新」并 taskkill 掉【正在执行升级的 server 进程】
// → 解压半途中断 + 任务状态（内存）丢失 → 前端看到「任务结束」但版本没变。
// 修复：升级期间 data/upgrade.lock 存在时，watchdog 跳过代码热重载（端口挂了仍照常拉起）。
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

// 注入：端口存活可控、进程操作记账、日志静默
block = block.replace(/function isUp\(port\)[\s\S]*?\n}/, 'function isUp(port) { return Promise.resolve(!!global.__portUp); }');
block = block.replace(/function pidOfPort\(port\)[\s\S]*?\n}/, 'function pidOfPort(port) { return 4321; }');
  // 注意：log 是单行函数，用 [^\n]* 限定，否则贪婪匹配会吞掉后面的 upgradeLocked()
  block = block.replace(/function log\(msg\) \{[^\n]*\}/, 'function log(msg) { global.__logs.push(String(msg)); }');
  assert.ok(/function upgradeLocked\(\)/.test(block), 'upgradeLocked 应仍在代码块内（正则误替换？）');

function build(ROOT) {
  const calls = { taskkill: 0, spawn: 0 };
  global.__logs = [];
  const factory = new Function(
    'ROOT', 'NODE', 'SERVER', 'fs', 'path', 'spawnSync', 'spawn',
    block + '\nreturn { ensureServer, SERVERS };'
  );
  const mod = factory(
    ROOT,
    'node.exe',
    path.join(ROOT, 'server.js'),
    fs,
    path,
    (cmd, args) => { if (String(cmd).includes('taskkill')) calls.taskkill++; return { stdout: '' }; },
    () => { calls.spawn++; return { unref() {}, on() {}, pid: 999 }; }
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
      fs.rmSync(ROOT, { recursive: true, force: true });
    }

    // 场景2：升级锁存在 + 代码更新 → 绝不重启（核心修复）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = true;
      await mod.ensureServer();               // 首次接管
      fs.writeFileSync(path.join(ROOT, 'data', 'upgrade.lock'), String(Date.now()), 'utf8');
      touchLater(path.join(ROOT, 'server.js'));
      await mod.ensureServer();               // 升级中：不应杀进程
      assert.strictEqual(calls.taskkill, 0, '升级锁生效期间禁止 taskkill 掉正在升级的进程');
      console.log('✓ 场景2 有锁：解压期间不打断升级进程（核心修复）');
      fs.rmSync(ROOT, { recursive: true, force: true });
    }

    // 场景3：有锁但端口挂了 → 仍要拉起（锁只挡热重载，不挡崩溃自愈）
    {
      const ROOT = freshRoot();
      const { mod, calls } = build(ROOT);
      global.__portUp = false;
      fs.writeFileSync(path.join(ROOT, 'data', 'upgrade.lock'), String(Date.now()), 'utf8');
      await mod.ensureServer();
      assert.ok(calls.spawn > 0, '有锁时端口挂了仍应拉起服务');
      console.log('✓ 场景3 有锁但进程崩溃：仍能拉起（自愈不失效）');
      fs.rmSync(ROOT, { recursive: true, force: true });
    }

    console.log('\n=== 升级锁（watchdog）测试全部通过 ===');
    process.exit(0);
  } catch (e) {
    console.error('\n✗ 升级锁测试失败:', e.message);
    process.exit(1);
  }
})();
