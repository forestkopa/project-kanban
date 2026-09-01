// 升级链路集成测试（v1.4.6 回归）
// 不依赖网络：注入 mock 的 getLatestRelease / 下载 / 解压 / 重启，验证
//   prepare(落盘) → watchdog 重启(内存清空) → confirm(跨重启命中) → 进度跑完 → 落地
//   以及过期 token 仍被拒（安全不退化）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'lib', 'upgrade.js');

function buildModule(ROOT) {
  let src = fs.readFileSync(SRC, 'utf8');
  // 返回本地 mock（不联网）
  src = src.replace(
    /async function getLatestRelease\(\)[\s\S]*?\n}/,
    `async function getLatestRelease() {
      return { version: '1.4.6', tag: 'v1.4.6', url: 'http://localhost/mock', assetUrl: 'http://localhost/mock.zip' };
    }`
  );
  // 下载改为瞬间写本地占位（不联网）
  src = src.replace(
    /async function downloadFileWithProgress\([\s\S]*?\n}/,
    `async function downloadFileWithProgress(url, dest, onProgress) {
      fs.writeFileSync(dest, 'PK\\x03\\x04 mock zip');
      if (onProgress) onProgress(100, 1, 1);
      return dest;
    }`
  );
  // 解压改为写落地标记（不真解析 zip）
  src = src.replace(
    /function extractZip\([\s\S]*?\n}/,
    `function extractZip(zip, dest) {
      fs.writeFileSync(path.join(dest, 'UPGRADED_MARKER'), '1.4.6');
    }`
  );
  // 重启改为 no-op（不真杀进程）
  src = src.replace(
    /function scheduleRestart\(\)[\s\S]*?\n}/,
    `function scheduleRestart() { /* test: no-op */ }`
  );
  const MOD = path.join(ROOT, 'upgrade.test.cjs');
  fs.writeFileSync(MOD, src);
  const U = require(MOD);
  return { U, MOD };
}

(async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-upg-it-'));
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ version: '1.4.5' }));

  try {
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
    console.log('✓ 升级落地（UPGRADED_MARKER 存在）');

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

    console.log('\n=== 升级链路集成测试全部通过 ===');
    process.exit(0);
  } catch (e) {
    console.error('\n✗ 升级链路集成测试失败:', e.message);
    process.exit(1);
  } finally {
    // 清理临时模块 + 目录
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  }
})();
