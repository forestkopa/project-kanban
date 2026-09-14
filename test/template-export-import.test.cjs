// 参考模版导出 / 导入回归测试
//
// 锁死两类历史缺陷：
//  1) 格式：参考模版导出必须走 xlsx-js-style 写出。曾用普通 xlsx 创建/写出，
//     结果 stylePlanSheet 写进去的填充、字体、边框、居中在落盘时被整体丢弃
//     （普通 xlsx 不保存 cell.s），表现为「导出的 Excel 是白板」。
//     同时阶段列必须用合并单元格（阶段名只填首行）。
//  2) 闭环：导出→导入后阶段与任务必须与模板完全一致。曾因跳过规则
//     skip='插入新行|提示|说明|汇总|合计' 按关键词无条件匹配，
//     把「包装与说明书」「隐私说明」这类正常任务整行吞掉；
//     阶段列改合并后，被吞的若正是阶段首行，还会连带丢掉整个阶段。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const XLSXS = require('xlsx-js-style');
const { startRealInstance } = require('./_harness.cjs');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const CASES = [
  { id: 'tpl_lock', label: '门锁' },
  { id: 'tpl_wearable', label: '手表' },
  { id: 'tpl_camera', label: '摄像头' },
  { id: 'tpl_speaker', label: '音箱' },
];

// 最小 zip 读取：从 local file header 定位条目并 inflateRaw（避免为测试引入解压依赖）
function unzipEntry(buf, want) {
  let off = 0;
  while (off + 30 < buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === want) {
      const data = buf.slice(dataStart, dataStart + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    off = dataStart + compSize;
  }
  return null;
}
// 按「阶段任务数分布」推算合并范围：数据从 Excel 第 2 行起
function expectMerges(dist) {
  const out = []; let r = 1;
  for (const n of dist) { const e = r + n - 1; out.push(`B${r + 1}:B${e + 1}`); r = e + 1; }
  return out;
}

(async () => {
  console.log('\n=== 参考模版导出/导入回归 ===');

  // ---------- A. 源码约束（防样式丢失复发） ----------
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const seg = (srv.match(/function buildTemplateXlsx\(tpl\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('buildTemplateXlsx 已定义', seg.length > 0);
  ok('用 xlsx-js-style 建表/写出（否则样式全丢）',
    /XLSXS\.utils\.aoa_to_sheet/.test(seg) && /XLSXS\.write\(/.test(seg) && /XLSXS\.utils\.book_new/.test(seg));
  ok('不得再用普通 xlsx 建表/写出',
    !/XLSX\.utils\.(aoa_to_sheet|book_new|book_append_sheet)/.test(seg) && !/XLSX\.write\(/.test(seg));
  ok('阶段列写合并单元格（!merges）', /!merges/.test(seg));
  // 注意：只匹配字符串字面量 / 行构造，别把注释里「项目开始时间 = 序号 1 的开始日期」误判成生成该行
  ok('不再生成「项目开始」行（表头置顶）',
    !/['"]项目开始['"]/.test(seg) && /rows = \[\s*\[\s*'序号'/.test(seg));
  ok('导出文件名做了非法字符净化（模板名含 /）',
    /safeName/.test(srv) && /function safeFileName\(name\)[\s\S]{0,160}?replace\(/.test(src));
  ok('前端两处下载名都走 safeFileName',
    (src.match(/safeFileName\(t\.name\)/g) || []).length >= 2,
    { found: (src.match(/safeFileName\(t\.name\)/g) || []).length });

  // ---------- A2. 模板命名规范（防品类后缀回流） ----------
  // 模板名只表示产品形态；品类归属由项目「产品类型」字段表达（data/options.json 可配置）。
  // 历史包袱：模板名曾兼做品类标注（智能手表 / 可穿戴、智能摄像头 / AI 视觉、智能音箱 / 语音助手）。
  const tplsPre = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates.json'), 'utf8'));
  const names = tplsPre.map(t => String(t.name || ''));
  ok('内置模板名不含 / 等文件名非法字符', names.every(n => !/[\\/:*?"<>|]/.test(n)), names.join(' / '));
  ok('内置模板名不含遗留品类后缀',
    names.every(n => !/可穿戴|AI\s*视觉|语音助手|安防/.test(n)), names.join(' / '));

  // ---------- B/C. 端到端：导出格式 + 导入闭环 ----------
  const tpls = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates.json'), 'utf8'));

  // 真实隔离实例：server.js 对 KB_DATA_DIR 隔离实例把模板文件放进数据目录，导入只写临时目录，
  // 不会污染仓库里的 templates.json —— 因此无需再手动快照/还原。
  const inst = await startRealInstance();
  try {
    for (const c of CASES) {
      const tpl = tpls.find(t => t.id === c.id);
      if (!tpl) { ok(`${c.label} 模板存在`, false, c.id); continue; }
      const dist = tpl.phases.map(p => tpl.tasks.filter(t => t.phaseId === p.id).length);
      const expMerges = expectMerges(dist);

      const r = await fetch(inst.base + '/api/templates/reference-xlsx?tplId=' + encodeURIComponent(c.id), { headers: { 'x-auth-token': inst.token } });
      ok(`${c.label} 导出 → 200`, r.status === 200, r.status);
      if (r.status !== 200) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      ok(`${c.label} 是合法 xlsx（PK 头）`, buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b, buf.length);

      // 文件名不得含 Windows 非法字符（守卫必须保留：用户自建/导入的模板名不受控）
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
      const utf8Name = m ? decodeURIComponent(m[1]) : '';
      ok(`${c.label} 下载名不含非法字符`, utf8Name.length > 0 && !/[\\/:*?"<>|]/.test(utf8Name), utf8Name);

      // 样式（直接解 xl/styles.xml，普通 xlsx 写出会退化成只有默认 fill/font）
      const stylesBuf = unzipEntry(buf, 'xl/styles.xml');
      const styles = stylesBuf ? stylesBuf.toString('utf8') : '';
      ok(`${c.label} 表头深蓝填充 #173A5A`, styles.includes('FF173A5A'));
      ok(`${c.label} 字体含微软雅黑`, styles.includes('微软雅黑'));
      ok(`${c.label} 细黑边框（网格）`, /style="thin"/.test(styles) && styles.includes('FF000000'));
      ok(`${c.label} 全列居中`, /horizontal="center"/.test(styles));

      // 结构：无「项目开始」行 + 阶段列合并范围与任务数吻合
      const sheetBuf = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
      const sheet = sheetBuf ? sheetBuf.toString('utf8') : '';
      ok(`${c.label} 无「项目开始」行`, !sheet.includes('项目开始'));
      const wb = XLSXS.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      ok(`${c.label} 表头首格为「序号」`, ws.A1 && ws.A1.v === '序号', ws.A1 && ws.A1.v);
      const merges = (ws['!merges'] || []).map(x => `B${x.s.r + 1}:B${x.e.r + 1}`);
      ok(`${c.label} 阶段列合并范围正确（${expMerges.join(',')}）`,
        JSON.stringify(merges) === JSON.stringify(expMerges), merges);

      // 闭环：导出 → 导入，阶段/任务/归类必须与模板一致
      const imp = await fetch(inst.base + '/api/templates/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-token': inst.token },
        body: JSON.stringify({ kind: 'xlsx', data: buf.toString('base64'), filename: utf8Name || (c.label + '.xlsx') }),
      });
      const ij = await imp.json().catch(() => ({}));
      const made = (ij.templates && ij.templates[0]) || {};
      const phases = made.phases || [];
      const tasks = made.tasks || [];
      const groups = {};
      tasks.forEach(t => { const ph = phases.find(p => p.id === t.phaseId); const k = ph ? ph.name : '(无阶段)'; groups[k] = (groups[k] || 0) + 1; });
      const gotDist = phases.map(p => groups[p.name] || 0);
      ok(`${c.label} 导入闭环：阶段数一致`, phases.length === tpl.phases.length, { got: phases.length, want: tpl.phases.length });
      ok(`${c.label} 导入闭环：任务数一致（含「说明」类任务名不被吞）`,
        tasks.length === tpl.tasks.length, { got: tasks.length, want: tpl.tasks.length });
      ok(`${c.label} 导入闭环：阶段任务分布一致`,
        JSON.stringify(gotDist) === JSON.stringify(dist), { got: gotDist, want: dist });
      ok(`${c.label} 导入闭环：任务自带公式链`,
        tasks.filter(t => t.startF || t.dueF).length === tasks.length, tasks.length);
    }
  } catch (e) {
    ok('e2e 执行未抛异常', false, String((e && e.message) || e));
  } finally {
    inst.stop();
  }

  console.log(`\n断言: ${pass + fail} | 通过: ${pass} | 失败: ${fail}`);
  if (fail) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
  console.log('✓ 参考模版导出/导入回归全部通过');
})().catch(e => { console.error(e); process.exit(1); });
