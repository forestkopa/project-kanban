// 聚合运行全部测试：数据层权限 / API 集成 / 角色强制 / 前端冒烟
const { spawnSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// node 路径：优先 KB_NODE 覆盖，否则用当前运行的 node（process.execPath）。
// 曾硬编码 .../versions/22.22.2/node.exe，WorkBuddy 升级后实际为 22.22.2-2 → ENOENT。
const NODE = process.env.KB_NODE || process.execPath;
// node_modules 路径：默认指向 managed node workspace（本机 jsdom 所在），换机/CI 用 KB_NODE_MODULES 覆盖
const WS = process.env.KB_NODE_MODULES || 'C:/Users/Administrator/.workbuddy/binaries/node/workspace';

let code = 0;
function run(label, args, opts) {
  console.log('\n############################################ 运行 ' + label + ' ############################################');
  const r = spawnSync(NODE, args, opts || { stdio: 'inherit' });
  if (r.status !== 0) code = r.status;
  return r;
}
const nodeOpts = { stdio: 'inherit' };
run('数据层权限单测', [path.join(__dirname, 'db-permissions.test.cjs')], nodeOpts);
run('lib 纯函数单测(recurrence)', [path.join(__dirname, 'lib-recurrence.test.cjs')], nodeOpts);
run('lib 纯函数单测(xlsx-export)', [path.join(__dirname, 'lib-xlsx-export.test.cjs')], nodeOpts);
run('后端 API 集成', [path.join(__dirname, 'api.integration.test.cjs')], nodeOpts);
run('角色分级强制(live)', [path.join(__dirname, 'api-roles.test.cjs')], nodeOpts);
run('升级链路集成(v1.4.6 回归)', [path.join(__dirname, 'upgrade.integration.test.cjs')], nodeOpts);
run('隧道守护稳定性(watchdog)', [path.join(__dirname, 'watchdog-tunnel.test.cjs')], nodeOpts);
// 冒烟脚本路径：默认相对 ROOT 根目录的 _smoke_v2.js，换机/CI 用 KB_SMOKE 覆盖
run('前端 jsdom 冒烟', [process.env.KB_SMOKE || path.join(ROOT, '_smoke_v2.js')],
  { stdio: 'inherit', cwd: WS, env: { ...process.env, NODE_PATH: path.join(WS, 'node_modules') } });

console.log('\n========== 聚合结果 ==========');
console.log(code === 0 ? '✅ 全部测试通过' : '❌ 存在失败（code=' + code + '）');
process.exit(code);
