// 测试隔离实例 harness：自起一个"真实模式"服务进程（独立临时数据目录），
// 完全不触碰项目 data/ 与运行中的 5180/5181，使写操作测试可在受控环境进行，
// 同时自然满足 P1-8 强制改密闸门（admin 初始密码 000000 → 测试内改密）。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

// node 路径：优先 KB_NODE 覆盖，否则用当前运行的 node（process.execPath）。
// 曾硬编码 .../versions/22.22.2/node.exe，WorkBuddy 升级后实际为 22.22.2-2 → ENOENT 全部集成测试失败。
const NODE = process.env.KB_NODE || process.execPath;
const ROOT = path.join(__dirname, '..');
const DEFAULT_PW = '000000';
const TEST_PW = 'KbTest@2026';

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function req(base, method, p, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['x-auth-token'] = token;
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, json: j };
}
async function waitFor(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/readonly');
      if (r.ok) { const j = await r.json().catch(() => null); if (j && j.demo === false) return true; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// 启动一个隔离的真实模式实例，返回 { base, token, stop }
async function startRealInstance() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  const PORT = await freePort();
  const base = 'http://127.0.0.1:' + PORT;
  const child = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), KB_DATA_DIR: tmp },
    stdio: 'ignore',
  });
  let ok2 = false;
  try {
    ok2 = await waitFor(base);
    if (!ok2) throw new Error('测试实例启动超时（端口 ' + PORT + '）');
    // admin 初始密码 000000 → 改密以通过 P1-8 闸门（tokens 不吊销，旧会话仍有效）
    const lg = await req(base, 'POST', '/api/login', { name: 'admin', password: DEFAULT_PW });
    if (lg.status !== 200 || !lg.json || !lg.json.token) throw new Error('admin 登录失败: ' + JSON.stringify(lg.json));
    const tok = lg.json.token;
    const ch = await req(base, 'POST', '/api/password', { old: DEFAULT_PW, next: TEST_PW }, tok);
    if (ch.status !== 200) throw new Error('admin 改密失败: ' + JSON.stringify(ch.json));
    return {
      base, token: tok,
      stop() {
        try { child.kill('SIGTERM'); } catch (_) {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      },
    };
  } catch (e) {
    try { child.kill('SIGTERM'); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

module.exports = { startRealInstance, req, DEFAULT_PW, TEST_PW };
