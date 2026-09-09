// 升级链路集成测试（v1.4.6 基线 + v1.5.1 加固回归）
// 不依赖网络：注入 mock 的 getLatestRelease / 下载 / 解压 / 重启，验证
//   prepare(落盘) → watchdog 重启(内存清空) → confirm(跨重启命中) → 进度跑完 → 落地
//   以及过期 token 仍被拒（安全不退化）。
// v1.5.1 新增回归：
//   1) 解压后版本号未变 → 必须判 error（修复「提示完成但版本没变」的核心闸）
//   2) 任务状态持久化到 data/upgrade-task.json —— 模拟进程重启后仍可查到最终结果
//   3) 升级期间加 data/upgrade.lock，结束/失败后必须解锁
//   4) 全过程写 logs/upgrade-*.log
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'lib', 'upgrade.js');

// buildModule(ROOT, opts)
//   opts.breakExtract = true → 模拟「解压未真正覆盖」（不写 package.json），用于验证校验闸
function buildModule(ROOT, opts) {
  opts = opts || {};
  let src = fs.readFileSync(SRC, 'utf8');
  // 返回本地 mock（不联网）
  src = src.replace(
    /async function getLatestRelease\(\)[\s\S]*?\n}/,
    `async function getLatestRelease() {
      return { version: '1.4.6', tag: 'v1.4.6', url: 'http://localhost/mock', assetUrl: 'http://localhost/mock.zip' };
    }`
  );
  // 下载改为瞬间写本地占位（不联网；需 >1KB 才能通过「下载文件过小」校验）
  src = src.replace(
    /async function downloadFileWithProgress\([\s\S]*?\n}/,
    `async function downloadFileWithProgress(url, dest, onProgress) {
      fs.writeFileSync(dest, Buffer.alloc(4096, 0));
      if (onProgress) onProgress(4096, 4096);
      return 4096;
    }`
  );
  // 解压改为写落地标记（不真解析 zip）；breakExtract 时不改 package.json，模拟覆盖失败
  const markerLine = opts.breakExtract
    ? `fs.writeFileSync(path.join(dest, 'UPGRADED_MARKER'), '1.4.6');`
    : `fs.writeFileSync(path.join(dest, 'UPGRADED_MARKER'), '1.4.6');
       fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ version: '1.4.6' }));`;
  src = src.replace(
    /function extractZip\([\s\S]*?\n}/,
    `function extractZip(zip, dest) {
      ${markerLine}
      return 'mock';
    }`
  );
  // 重启改为 no-op（不真杀进程）
  src = src.replace(
    /function scheduleRestart\([^)]*\)[\s\S]*?\n}/,
    `function scheduleRestart(root) { scheduleRestartCalls.push(root); }`
  );
  src = src.replace(
    /^const pending = new Map\(\);/m,
    `const pending = new Map();\nglobal.scheduleRestartCalls = global.scheduleRestartCalls || [];\nconst scheduleRestartCalls = global.scheduleRestartCalls;`
  );
  const MOD = path.join(ROOT, 'upgrade.test.cjs');
  fs.writeFileSync(MOD, src);
  const U = require(MOD);
  return { U, MOD };
}

function freshRoot() {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-upg-it-'));
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ version: '1.4.5' }));
  return ROOT;
}

(async () => {
  let ROOT = freshRoot();

  try {
    // ---------- 主链路 ----------
    // 进程1：prepare 应发 token 并落盘
    let { U, MOD } = buildModule(ROOT);
    const pre = await U.prepareUpgrade(ROOT);
    assert.strictEqual(pre.need, true, 'prepare 应判定需要升级');
    const tokFile = path.join(ROOT, 'data', 'upgrade-tokens.json');
    assert.ok(fs.existsSync(tokFile), 'prepare 后 token 应持久化到磁盘');
    console.log('✓ prepare 发 token + 落盘');

    // 进程2：清 require cache + 删临时模块，模拟 watchdog 重启（内存 pending 空）
    delete require.cache[MOD];
    fs.unlinkSync(MOD);
    ({ U, MOD } = buildModule(ROOT));
    console.log('✓ 模拟 watchdog 重启（新模块实例，内存 pending 空）');

    // confirm（startUpgrade）用之前 prepare 的 token，应跨重启命中
    const r = U.startUpgrade(ROOT, pre.token);
    assert.ok(r.ok && r.taskId, 'startUpgrade 应返回 taskId');
    console.log('✓ startUpgrade 跨重启命中 token，返 taskId:', r.taskId.slice(0, 8));

    // 轮询进度直到 done
    let st, waited = 0;
    while (waited < 8000) {
      st = U.getTaskStatus(r.taskId);
      if (st && st.finished) break;
      await new Promise((res) => setTimeout(res, 200));
      waited += 200;
    }
    assert.ok(st && st.finished, '任务应在 8s 内完成');
    assert.strictEqual(st.phase, 'done', 'phase 应为 done，实际=' + (st && st.phase));
    assert.strictEqual(st.progress, 100, '进度应到 100，实际=' + (st && st.progress));
    console.log('✓ 进度跑完：phase=done progress=100 (' + (st.message || '') + ')');

    // 升级落地
    assert.ok(fs.existsSync(path.join(ROOT, 'UPGRADED_MARKER')), 'extractZip 应落地升级标记');
    assert.strictEqual(U.localVersion(ROOT), '1.4.6', 'package.json 应已被覆盖为目标版本');
    console.log('✓ 升级落地（UPGRADED_MARKER 存在 + 版本已变为 1.4.6）');

    // v1.5.1：任务状态持久化（进程被 watchdog 重启后仍可查）
    const taskF = path.join(ROOT, 'data', 'upgrade-task.json');
    assert.ok(fs.existsSync(taskF), '任务状态应持久化到 data/upgrade-task.json');
    const persisted = JSON.parse(fs.readFileSync(taskF, 'utf8'));
    assert.strictEqual(persisted.taskId, r.taskId, '持久化记录的 taskId 应匹配');
    assert.strictEqual(persisted.snap.phase, 'done', '持久化快照应为 done');
    // 清空内存后（模拟重启）仍能从磁盘恢复
    delete require.cache[MOD];
    fs.unlinkSync(MOD);
    ({ U, MOD } = buildModule(ROOT));
    const after = U.getTaskStatus(r.taskId, ROOT);
    assert.ok(after && after.phase === 'done', '重启后应能从磁盘恢复任务状态（phase=done）');
    console.log('✓ 任务状态持久化：重启后仍能拉到 done（不再「任务不存在」）');

    // v1.5.1：升级结束后必须解锁（否则 watchdog 永久停止热重载）
    assert.ok(!fs.existsSync(path.join(ROOT, 'data', 'upgrade.lock')), '升级完成后必须删除 upgrade.lock');
    assert.ok(global.scheduleRestartCalls.includes(ROOT), '升级完成应触发 scheduleRestart');
    console.log('✓ 升级结束已解锁 + 已触发重启');

    // v1.5.1：日志落盘
    const logsDir = path.join(ROOT, 'logs');
    const logOk = fs.existsSync(logsDir) && fs.readdirSync(logsDir).some(f => /^upgrade-.*\.log$/.test(f));
    assert.ok(logOk, '应生成 logs/upgrade-*.log');
    console.log('✓ 升级日志已落盘 logs/upgrade-*.log');

    // 过期 token 应被拒（安全不退化）
    const expired = 'deadbeefdeadbeefdeadbeefdeadbeef';
    fs.writeFileSync(tokFile, JSON.stringify({ [expired]: { exp: Date.now() - 1000, tag: 'v1.4.6', assetUrl: 'x' } }));
    delete require.cache[MOD];
    fs.unlinkSync(MOD);
    ({ U, MOD } = buildModule(ROOT));
    let threw = false;
    try { U.startUpgrade(ROOT, expired); } catch (e) { threw = /token 无效或已过期/.test(e.message); }
    assert.ok(threw, '过期 token 应抛「token 无效或已过期」');
    console.log('✓ 过期 token 正确被拒（安全不退化）');

    // ---------- v1.5.1 核心回归：解压后版本没变 → 必须 error ----------
    const ROOT2 = freshRoot();
    const m2 = buildModule(ROOT2, { breakExtract: true });
    const pre2 = await m2.U.prepareUpgrade(ROOT2);
    const r2 = m2.U.startUpgrade(ROOT2, pre2.token);
    let st2 = null, w2 = 0;
    while (w2 < 8000) {
      st2 = m2.U.getTaskStatus(r2.taskId);
      if (st2 && st2.finished) break;
      await new Promise((res) => setTimeout(res, 200));
      w2 += 200;
    }
    assert.ok(st2 && st2.finished, '异常场景任务也应结束');
    assert.strictEqual(st2.phase, 'error', '版本未变时必须判 error，实际=' + st2.phase);
    assert.ok(/版本|未被覆盖/.test(st2.message || ''), '错误信息应说明版本未变：' + st2.message);
    assert.ok(!fs.existsSync(path.join(ROOT2, 'data', 'upgrade.lock')), '失败后也必须解锁');
    console.log('✓ 解压后版本未变 → 判 error 并解锁（不再「提示完成但版本没变」）');
    try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch (e) {}

    console.log('\n=== 升级链路集成测试全部通过 ===');
    process.exit(0);
  } catch (e) {
    console.error('\n✗ 升级链路集成测试失败:', e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  }
})();
