// 隧道守护稳定性回归测试（watchdog.js ensureTunnel）
// 背景：原逻辑「单次探测失败 → 立即 taskkill + 重拉」过于激进，公司宽带偶发丢包
// 即误判重启，重连期间公网不可达，重连慢时更陷入每 15s 重启循环。
// 新逻辑：双次确认 + 连续 3 次才重启 + 重启后 90s 冷却。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'watchdog.js');
const raw = fs.readFileSync(SRC, 'utf8');

// 截取 ensureTunnel 相关代码块（不含文件末尾的 setInterval 启动段）
const startMark = 'const TUNNEL_FAIL_THRESHOLD';
const endMark = "log('守护已启动";
const si = raw.indexOf(startMark);
const ei = raw.indexOf(endMark);
assert.ok(si >= 0 && ei > si, '未能定位 ensureTunnel 代码块（watchdog.js 结构变更？）');
let block = raw.slice(si, ei);

// isTunnelUp 改为可注入 mock；探测间隔压缩以便快速测试
block = block.replace(
  /function isTunnelUp\(\)[\s\S]*?\n}/,
  'function isTunnelUp() { return Promise.resolve(global.__tunnelUp()); }'
);
block = block.replace(/const TUNNEL_RECHECK_DELAY = \d+;/, 'const TUNNEL_RECHECK_DELAY = 10;');
block = block.replace(/const TUNNEL_COOLDOWN = \d+;/, 'const TUNNEL_COOLDOWN = 300;');
assert.ok(!/const TUNNEL_RECHECK_DELAY = 2000/.test(block), 'RECHECK_DELAY 未被压缩');

// 装配：spawnSync/spawn 记录调用，log 静默
function build() {
  const calls = { taskkill: 0, spawn: 0 };
  const logs = [];
  const factory = new Function(
    'TUNNEL_URL', 'CLOUDFLARED', 'TUNNEL_CONFIG', 'spawnSync', 'spawn', 'log',
    block + '\nreturn { ensureTunnel, state: () => ({ tunnelFailCount, tunnelLastRestart }) };'
  );
  const mod = factory(
    'https://kanban.forestkopa.top',
    'cloudflared.exe',
    'config.yml',
    () => { calls.taskkill++; return {}; },
    () => { calls.spawn++; return { unref() {} }; },
    (m) => logs.push(m)
  );
  return { mod, calls, logs };
}

(async () => {
  // 场景1：偶发抖动（首次失败、复查通过）→ 不重启
  {
    const { mod, calls } = build();
    let n = 0;
    global.__tunnelUp = () => (++n <= 1 ? false : true); // 第一次失败，复查成功
    delete process.env.KANBAN_NO_TUNNEL;
    await mod.ensureTunnel();
    assert.strictEqual(calls.taskkill, 0, '偶发抖动不应触发 taskkill');
    assert.strictEqual(calls.spawn, 0, '偶发抖动不应拉起 cloudflared');
    console.log('✓ 场景1 偶发抖动不重启（原逻辑会误杀）');
  }

  // 场景2：连续 3 次真失败 → 才重启
  {
    const { mod, calls } = build();
    global.__tunnelUp = () => false; // 持续不可达
    let restarts = 0;
    for (let i = 0; i < 3; i++) {
      await mod.ensureTunnel();
      if (calls.taskkill > restarts) restarts = calls.taskkill;
    }
    assert.strictEqual(calls.taskkill, 1, '持续不可达应恰好重启 1 次，实际=' + calls.taskkill);
    assert.strictEqual(calls.spawn, 1, '应恰好拉起 1 次，实际=' + calls.spawn);
    console.log('✓ 场景2 持续不可达才重启（连续 3 次确认后）');
  }

  // 场景3：重启后冷却期内再次失败 → 不再重复重启（防每 15s 循环）
  {
    const { mod, calls } = build();
    global.__tunnelUp = () => false;
    for (let i = 0; i < 3; i++) await mod.ensureTunnel();
    assert.strictEqual(calls.taskkill, 1, '首次应重启 1 次');
    // 冷却期内继续失败：不应再重启
    for (let i = 0; i < 5; i++) await mod.ensureTunnel();
    assert.strictEqual(calls.taskkill, 1, '冷却期内不得重复重启，实际=' + calls.taskkill);
    console.log('✓ 场景3 冷却期内不重复重启（防 15s 重启循环）');
  }

  // 场景4：KANBAN_NO_TUNNEL=1（开发机）→ 永不接管隧道
  {
    const { mod, calls } = build();
    global.__tunnelUp = () => false;
    process.env.KANBAN_NO_TUNNEL = '1';
    for (let i = 0; i < 5; i++) await mod.ensureTunnel();
    assert.strictEqual(calls.taskkill, 0, '开发机模式不得 taskkill');
    assert.strictEqual(calls.spawn, 0, '开发机模式不得拉起 cloudflared');
    delete process.env.KANBAN_NO_TUNNEL;
    console.log('✓ 场景4 开发机模式（KANBAN_NO_TUNNEL）永不接管隧道');
  }

  console.log('\n=== 隧道守护稳定性测试全部通过 ===');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 隧道守护测试失败:', e.message);
  process.exit(1);
});
