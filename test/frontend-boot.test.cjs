// 前端启动冒烟测试：用轻量 DOM/fetch/localStorage stub，无需 jsdom（避免联网装包）。
// 锁死回归：
//   A. 未登录冷启动 → 必须弹出“可见”的登录框，且 splash 必淡出、绝不永久卡在首屏；用户登录后能进入 loadAll。
//   B. 已登录（token 有效）→ 直接 loadAll，不应弹登录框。
// 不依赖浏览器/jsdom：Node 下 app.js 顶层 boot() 被 `typeof window` 守卫跳过，由本测试手动调用 app.boot()。
const path = require('path');

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + msg); }
  else { failed++; console.error('  \x1b[31mFAIL\x1b[0m ' + msg); }
}

function makeEl() {
  const cls = new Set();
  return {
    _cls: cls,
    classList: {
      add: c => cls.add(c),
      remove: c => cls.delete(c),
      toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else { on ? cls.add(c) : cls.delete(c); } },
      contains: c => cls.has(c),
    },
    style: {}, value: '', checked: false, textContent: '', disabled: false,
    onclick: null, onkeydown: null,
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, focus() {}, remove() {},
    getContext: () => new Proxy({}, { get: () => (() => {}) }), // canvas 2d 上下文兜底（Node 无 canvas）
  };
}
function makeEnv() {
  const els = {};
  const get = sel => (els[sel] || (els[sel] = makeEl()));
  global.document = {
    getElementById: get,
    querySelector: get,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} } },
  };
  const store = {};
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  global.location = { reload() {} };
  global.window = undefined; // 关键：Node 下 typeof window === 'undefined'，app.js 顶层不自动 boot
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (u.includes('/api/login')) return res(200, { token: 'T', user: { id: 'u1', name: 'admin', role: 'admin' } });
    if (u.includes('/api/projects')) {
      const h = opts.headers || {};
      const tok = h['X-Auth-Token'];
      if (tok === 'T') return res(200, []); // 有效 token → 已登录（返回空列表，避开 render 所需的完整项目字段）
      return res(401, { error: '请先登录' });                        // 无效/无 token → 未登录
    }
    if (u.includes('/api/templates')) return res(200, []);
    if (u.includes('/api/options')) return res(200, { types: {}, productTypes: {}, levels: {} });
    if (u.includes('/api/readonly')) return res(200, { on: false, demo: false });
    if (u.includes('/api/me')) return res(401, {});
    return res(200, {});
  };
  return { els, store };
}

function loadApp() {
  const p = path.resolve(__dirname, '../public/app.js');
  delete require.cache[p];
  return require(p);
}
const flush = () => new Promise(r => setImmediate(r)); // 排空微任务，让 showLogin 同步部分先执行

async function scenarioAnonThenLogin() {
  console.log('\n=== 场景 A：未登录冷启动 → 用户登录 ===');
  const { els } = makeEnv(); // 无 token
  const app = loadApp();
  const bootP = app.boot();            // boot 进入 showLogin 后 pending（等用户操作）
  await flush();                       // 让 showLogin 同步部分执行：显示登录框 + 淡出 splash + 绑定 #loginBtn.onclick
  // 核心回归：未登录冷启动时，splash 必须立即淡出、登录框必须可见（修复前 splash z-index 9999 盖住 modal 200，用户看不见也点不到 → 永久卡死）
  check(els['splash']._cls.has('hide'), '未登录时 splash 立即淡出（不再永久卡首屏）');
  check(els['#loginModal'] && !els['#loginModal']._cls.has('hidden'), '未登录时登录框可见（修复前被 splash 盖住看不见 → 无法操作 → 永久卡死）');
  // 驱动“用户登录”：showLogin 已把 #loginBtn.onclick 绑定为 submit
  els['#loginName'].value = 'admin';
  els['#loginPass'].value = 'pw';
  await els['#loginBtn'].onclick();    // 触发 submit → /api/login 成功 → showLogin resolve(true)
  await bootP;                         // 等 boot 完成（递归重跑 → loadAll → hideSplash）
  check(Array.isArray(app.getState().projects), '登录成功后 loadAll 填充 projects（启动链路完整、未卡死）');
}

async function scenarioLoggedIn() {
  console.log('\n=== 场景 B：已登录（token 有效）直接进 ===');
  const { els, store } = makeEnv();
  store['kb-token'] = 'T';
  store['kb-user'] = JSON.stringify({ id: 'u1', name: 'admin', role: 'admin' });
  const app = loadApp();
  await app.boot();
  check(Array.isArray(app.getState().projects), '已登录直接 loadAll 填充 projects');
  check(els['#loginBtn'] === undefined, '已登录不弹登录框（#loginBtn 元素未被创建）');
  check(els['splash']._cls.has('hide'), '已登录 splash 被淡出');
}

(async () => {
  try {
    await scenarioAnonThenLogin();
    await scenarioLoggedIn();
  } catch (e) {
    failed++;
    console.error('  \x1b[31mERROR\x1b[0m 测试抛异常:', (e && e.stack) || e);
  }
  console.log(`\n前端启动冒烟结果: ${passed} 通过, ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
