// 聚合运行全部测试：数据层权限 / 纯函数 / API 集成 / 角色强制 / AI / 升级守护 / 前端冒烟
// v1.5.2：补齐此前漏网的 4 个套件（公式引擎、报告聚合、待办顺延、前端启动），
// 并新增「防漏网自检」——扫描 test/ 下所有测试文件，凡未纳入本聚合的一律报警并判失败，
// 杜绝"加了测试文件却忘了加进 run-all → npm test 静默漏跑"。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// node 路径：优先 KB_NODE 覆盖，否则用当前运行的 node（process.execPath）。
// 曾硬编码 .../versions/22.22.2/node.exe，WorkBuddy 升级后实际为 22.22.2-2 → ENOENT。
const NODE = process.env.KB_NODE || process.execPath;
// node_modules 路径：默认指向 managed node workspace（本机 jsdom 所在），换机/CI 用 KB_NODE_MODULES 覆盖
const WS = process.env.KB_NODE_MODULES || 'C:/Users/Administrator/.workbuddy/binaries/node/workspace';

let code = 0;
const passedSuites = [], failedSuites = [];
// 已调度执行的测试文件（绝对路径），供末尾防漏网自检比对
const scheduled = new Set();
const T = f => path.join(__dirname, f);

function run(label, args, opts) {
  console.log('\n############################################ 运行 ' + label + ' ############################################');
  (args || []).forEach(a => {
    if (typeof a === 'string' && /\.(test|e2e)\.(cjs|js)$/i.test(a)) scheduled.add(path.resolve(a));
  });
  const r = spawnSync(NODE, args, opts || { stdio: 'inherit' });
  if (r.status !== 0) { code = r.status; failedSuites.push(label); }
  else passedSuites.push(label);
  return r;
}
const nodeOpts = { stdio: 'inherit' };
run('数据层权限单测', [T('db-permissions.test.cjs')], nodeOpts);
run('lib 纯函数单测(recurrence)', [T('lib-recurrence.test.cjs')], nodeOpts);
run('lib 纯函数单测(xlsx-export)', [T('lib-xlsx-export.test.cjs')], nodeOpts);
run('版本比较纯函数单测(cmpVer)', [T('cmp-ver.test.cjs')], nodeOpts);
run('AI Markdown 渲染单测(mdToHtml)', [T('md-render.test.cjs')], nodeOpts);
run('AI 超时配置回归(本地慢模型)', [T('ai-timeout.test.cjs')], nodeOpts);
// 以下两个用 Node 内置 node:test 运行（文件为 .js，需 --test 开关）
run('甘特公式引擎 + 报告聚合(node:test)', ['--test', T('formula-engine.test.js'), T('db-report.test.js')], nodeOpts);
run('AI 对话记录 db 层(会话 CRUD/隔离)', [T('ai-sessions.test.cjs')], nodeOpts);
run('AI 对话记录 API(真实实例)', [T('ai-sessions-api.test.cjs')], nodeOpts);
run('AI Agent 单测(权限/确认/双协议)', [T('ai-agent.test.cjs')], nodeOpts);
run('AI Agent 端到端(真实实例+mock LLM)', [T('ai-agent.e2e.cjs')], nodeOpts);
run('后端 API 集成(自起隔离 demo+real 双实例)', [T('api.integration.test.cjs')], nodeOpts);
run('角色分级强制(live)', [T('api-roles.test.cjs')], nodeOpts);
run('升级链路集成(v1.4.6 回归)', [T('upgrade.integration.test.cjs')], nodeOpts);
run('隧道守护稳定性(watchdog)', [T('watchdog-tunnel.test.cjs')], nodeOpts);
run('升级锁(watchdog 不打断解压)', [T('watchdog-upgrade-lock.test.cjs')], nodeOpts);
// 前端回归（v1.4.7 hotfix3/4 的修复锁，此前未在聚合入口，导致 npm test 漏跑这两条防线）
run('待办下周顺延回归(todo-nextweek)', [T('todo-nextweek.test.cjs')], nodeOpts);
run('前端启动流程回归(frontend-boot)', [T('frontend-boot.test.cjs')], nodeOpts);
// 冒烟脚本路径：默认相对 ROOT 根目录的 _smoke_v2.js，换机/CI 用 KB_SMOKE 覆盖
run('前端 jsdom 冒烟', [process.env.KB_SMOKE || path.join(ROOT, '_smoke_v2.js')],
  { stdio: 'inherit', cwd: WS, env: { ...process.env, NODE_PATH: path.join(WS, 'node_modules') } });

console.log('\n========== 聚合结果 ==========');
console.log('套件：' + passedSuites.length + ' 通过 / ' + failedSuites.length + ' 失败');
if (failedSuites.length) console.log('失败套件：' + failedSuites.join(' | '));

// —— 防漏网自检：test/ 下所有 *.test.cjs|js 与 *.e2e.cjs 必须全部出现在本次调度中 ——
const allTests = fs.readdirSync(__dirname)
  .filter(f => /\.(test|e2e)\.(cjs|js)$/i.test(f))
  .map(f => path.resolve(T(f)));
const missing = allTests.filter(f => !scheduled.has(f));
if (missing.length) {
  code = code || 1;
  console.log('⚠️ 以下测试文件未纳入聚合（共 ' + allTests.length + ' 个，漏 ' + missing.length + ' 个）：');
  missing.forEach(f => console.log('   - ' + path.basename(f)));
  console.log('   请在本文件 run(...) 列表中补充，否则这些测试永远不会被执行。');
} else {
  console.log('覆盖自检：test/ 下 ' + allTests.length + ' 个测试文件全部纳入聚合 ✅');
}

console.log(code === 0 ? '✅ 全部测试通过' : '❌ 存在失败（code=' + code + '）');
process.exit(code);
