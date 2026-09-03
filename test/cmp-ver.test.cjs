// cmpVer 版本比较单测（回归点：hotfix3 vs hotfix4 原实现因只按 '.' 拆，后缀被吞，误判相等，
// 导致 checkUpdate 走"已是最新"分支，生产环境页脚自相矛盾：badge=hotfix3，状态文案=hotfix4）。
// 加载模式与 todo-nextweek.test.cjs 一致：mock document / window=undefined / localStorage 后 require app.js。
const path = require('path');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function makeEl() {
  return { classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} }, style:{}, value:'', checked:false, textContent:'', disabled:false, onclick:null, addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){return null;}, focus(){}, remove(){}, getContext: () => ({}) };
}
global.document = { getElementById: () => makeEl(), querySelector: () => makeEl(), querySelectorAll: () => [], createElement: () => makeEl(), addEventListener(){}, body: { classList: { add(){}, remove(){}, toggle(){} } } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window = undefined;
global.setInterval = () => 0; global.clearInterval = () => {};
global.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });

const p = path.resolve(__dirname, '../public/app.js');
delete require.cache[p];
const { cmpVer } = require(p);

ok('hotfix3 < hotfix4 (回归点)', cmpVer('1.4.7-hotfix3', '1.4.7-hotfix4') < 0);
ok('hotfix4 > hotfix3', cmpVer('1.4.7-hotfix4', '1.4.7-hotfix3') > 0);
ok('hotfix3 == hotfix3', cmpVer('1.4.7-hotfix3', '1.4.7-hotfix3') === 0);
ok('hotfix4 == hotfix4', cmpVer('1.4.7-hotfix4', '1.4.7-hotfix4') === 0);
ok('无后缀 < hotfix4', cmpVer('1.4.7', '1.4.7-hotfix4') < 0);
ok('hotfix4 > 无后缀', cmpVer('1.4.7-hotfix4', '1.4.7') > 0);
ok('1.4.6 < 1.4.7 (跨小版本)', cmpVer('1.4.6', '1.4.7') < 0);
ok('1.4.7 < 1.5.0 (跨中版本)', cmpVer('1.4.7', '1.5.0') < 0);
ok('1.5.0 < 2.0.0 (跨大版本)', cmpVer('1.5.0', '2.0.0') < 0);
ok('相等无后缀', cmpVer('1.4.7', '1.4.7') === 0);

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
process.exit(fail ? 1 : 0);
