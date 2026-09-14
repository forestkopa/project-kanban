// 升级包内容回归（v1.5.6）
//
// 为什么要有这条锁：
//   outputs/ 是本机临时产物目录（导出预览 xlsx、parity 比对件、demo 数据备份），
//   .gitignore 里排了、但 build_update_zip.py 一度没排 —— 结果 2026-09-11 打出来的
//   update.zip 里混进了 19 个 outputs/ 文件（含 4.5MB 的 _demo-backup-20260911/），
//   把一个 2.85MB 的包撑到 3.4MB，且把本机临时数据 + demo 残留发到了服务器。
//   这类"包里多了东西"的问题不跑一遍打包是看不出来的，所以直接跑真打包 + 查条目。
//
// 断言口径：包的【内容清单】而不是大小 —— 大小会随功能增长，清单不会骗人。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

// python 解析：环境变量优先 → 本机托管版本 → PATH 上的 python
function resolvePython() {
  const cands = [process.env.KB_PYTHON,
    'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python', 'python3', 'py'];
  for (const c of cands) {
    if (!c) continue;
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

console.log('=== 升级包内容回归 ===');
const py = resolvePython();
if (!py) {
  console.log('  SKIP 未找到 python，跳过打包回归（换机请设 KB_PYTHON）');
  console.log('\n断言: 0 | 通过: 0 | 失败: 0');
  process.exit(0);
}
console.log('  python = ' + py);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-zip-'));
const r = spawnSync(py, ['tools/build_update_zip.py', '-o', outDir], { cwd: ROOT, encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
ok(r.status === 0, '打包脚本退出码为 0');
ok(/SELF-CHECK OK/.test(out), '脚本自检通过（SELF-CHECK OK）');
ok(!/SELF-CHECK FAIL/.test(out), '脚本未报 SELF-CHECK FAIL');

const zipPath = path.join(outDir, 'project-kanban-update.zip');
ok(fs.existsSync(zipPath), '升级包已生成');

// 用 python 列条目（Node 侧不引额外依赖，且本机 unzip 不一定有）
const script = `
import json, zipfile, sys
z = zipfile.ZipFile(r"${zipPath.replace(/\\/g, '\\\\')}")
infos = z.infolist()
print(json.dumps({
  'n': len(infos),
  'total': sum(i.file_size for i in infos),
  'max': max([i.file_size for i in infos] or [0]),
  'maxname': max(infos, key=lambda i: i.file_size).filename if infos else '',
  'names': [i.filename for i in infos],
}, ensure_ascii=False))
`;
const lr = spawnSync(py, ['-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
let info = null;
try { info = JSON.parse((lr.stdout || '').trim()); } catch (e) { /* 下面按 null 报错 */ }
ok(!!info, '能读取升级包条目清单');
if (!info) process.exit(1);

const names = info.names;
const startsWith = p => names.filter(n => n.startsWith(p));

// 关键文件必须在（服务器解压后要能直接起来）
['server.js', 'db.js', 'package.json', 'watchdog.js', 'offline-adapter.js',
  'kanban-workbench-template.html', 'lib/ai-agent.js', 'public/index.html',
  'public/app.js', 'public/style.css'].forEach(f => ok(names.includes(f), '包内含关键文件 ' + f));

// 本地产物一律不得入包
ok(startsWith('node_modules/').length === 0, '不含 node_modules（默认口径）');
ok(startsWith('data/').length === 0, '不含 data/（线上数据不被覆盖）');
ok(startsWith('outputs/').length === 0, '不含 outputs/（本机临时产物 / demo 备份）');
ok(startsWith('backups/').length === 0 && startsWith('logs/').length === 0, '不含 backups/ 与 logs/');
// 临时产物后缀一律不得入包（vendor/*.tgz 是 xlsx 离线依赖包，属有意保留）
const junk = names.filter(n => /\.(xlsx|db|log|zip)$/i.test(n));
ok(junk.length === 0, '不含 xlsx/db/log/zip 类临时文件' + (junk.length ? ' → ' + junk.slice(0, 3).join(', ') : ''));
ok(!names.some(n => n.includes('recovered-modify-backup')), '不含 docs/recovered-modify-backup（169MB 抢救备份）');

// 体积守卫：防止将来某个大文件又被误打包（当前最大项是 vendor/xlsx 离线包 2.3MB）
ok(info.max < 3 * 1024 * 1024,
  '单条目最大 < 3MB（实际 ' + info.maxname + ' ' + (info.max / 1048576).toFixed(1) + 'MB）');
ok(info.total < 6 * 1024 * 1024, '包内未压缩总量 < 6MB（实际 ' + (info.total / 1048576).toFixed(2) + 'MB）');

// 本机若确实存在 outputs/，再显式确认排除生效（否则上面对 outputs/ 的断言是空转）
if (fs.existsSync(path.join(ROOT, 'outputs'))) {
  ok(startsWith('outputs/').length === 0, '本机存在 outputs/ 但未被打包（排除生效）');
}

console.log('\n包内条目：' + info.n + ' 个，解压后合计 ' + (info.total / 1048576).toFixed(2) + 'MB');
console.log('\n断言: ' + (pass + fail) + ' | 通过: ' + pass + ' | 失败: ' + fail);
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不判失败 */ }
if (fail) { console.log('✗ 升级包内容回归存在失败'); process.exit(1); }
console.log('✓ 升级包内容回归全部通过');
