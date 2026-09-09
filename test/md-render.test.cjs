// mdToHtml 轻量 Markdown 渲染器单测：三个 AI 入口（Agent 对话 / 报告视图总结 / 月度计划总结）
// 统一用它把模型输出的 Markdown 渲染成结构化 HTML。关键约束：先转义后解析，XSS 安全。
// 加载模式与 cmp-ver.test.cjs 一致：mock document / window / localStorage 后 require app.js。
const path = require('path');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function makeEl() {
  return { classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} }, style:{}, value:'', checked:false, textContent:'', disabled:false, onclick:null, addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){return null;}, focus(){}, remove(){}, getContext: () => ({}) };
}
global.document = { getElementById: () => makeEl(), querySelector: () => makeEl(), querySelectorAll: () => [], createElement: () => makeEl(), addEventListener(){}, body: { classList: { add(){}, remove(){}, toggle(){} }, appendChild(){}, contains(){return false;} } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window = undefined;
global.setInterval = () => 0; global.clearInterval = () => {};
global.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });
global.navigator = { clipboard: { writeText: async () => {} } };

const p = path.resolve(__dirname, '../public/app.js');
delete require.cache[p];
const { mdToHtml } = require(p);

/* 粗体 / 斜体 / 行内代码 */
ok('**粗体** 渲染', mdToHtml('**项目**').includes('<strong>项目</strong>'));
ok('*斜体* 渲染', mdToHtml('*斜体*').includes('<em>斜体</em>'));
ok('`行内码` 渲染', mdToHtml('看板 `app.js` 文件').includes('<code>app.js</code>'));
ok('斜体不吞粗体', !/<em>[^<]*<strong>/.test(mdToHtml('**a** *b*')));

/* 标题 / 分隔线 / 引用 */
ok('## 标题渲染为 md-h2', mdToHtml('## 周报').includes('<b class="md-h md-h2">周报</b>'));
ok('# 一级标题', mdToHtml('# 大标题').includes('md-h1'));
ok('--- 分隔线', mdToHtml('a\n\n---').includes('<hr>'));
ok('> 引用', mdToHtml('> 注意风险').includes('<blockquote>'));

/* 列表 */
ok('- 无序列表两行', (() => { const h = mdToHtml('- 甲\n- 乙'); return h.includes('<ul>') && h.includes('<li>甲</li>') && h.includes('<li>乙</li>'); })());
ok('1. 有序列表', (() => { const h = mdToHtml('1. 第一\n2. 第二'); return h.includes('<ol>') && h.includes('<li>第一</li>'); })());

/* 表格：模型输出表格 → thead/th/tbody */
const tblMd = '| 项目 | 进度 |\n| --- | --- |\n| 门锁 | 45% |\n| 音箱 | 100% |';
const tblHtml = mdToHtml(tblMd);
ok('表格渲染 <table>', tblHtml.includes('<table>'));
ok('表格表头 <th>', tblHtml.includes('<th>项目</th>') && tblHtml.includes('<th>进度</th>'));
ok('表格行 <td>', tblHtml.includes('<td>门锁</td>') && tblHtml.includes('<td>45%</td>'));
ok('表格分隔行 --- 不渲染为数据', !tblHtml.includes('<td>---</td>'));
ok('表格包 tblwrap(可横向滚动)', tblHtml.includes('tblwrap'));

/* 代码块 */
ok('``` 代码块', (() => { const h = mdToHtml('```js\nconst a = 1;\n```'); return h.includes('<pre><code>') && h.includes('const a = 1;'); })());

/* 段落：连续非空行合并为一个 <p> */
ok('段落合并', (() => { const h = mdToHtml('第一行\n第二行'); const m = h.match(/<p>([\s\S]*?)<\/p>/); return m && m[1].includes('第一行') && m[1].includes('第二行'); })());

/* XSS 安全 */
const xss = mdToHtml('<script>alert(1)</script>');
ok('XSS script 被转义', !xss.includes('<script>alert') && xss.includes('&lt;script&gt;'));
ok('XSS 表格注入被转义', !mdToHtml('| a |\n| --- |\n| <img src=x onerror=alert(1)> |').includes('<img'));
ok('XSS 列表项标签被转义', !mdToHtml('- <b>粗</b>').includes('<li><b>粗</b>'));
ok('列表项内 **加粗** 正常渲染', mdToHtml('- **真粗**').includes('<li><strong>真粗</strong>'));

/* 边界 */
ok('空输入返回空串', mdToHtml('') === '' && mdToHtml(null) === '');
ok('链接渲染 target=_blank', mdToHtml('[看板](https://kanban.forestkopa.top)').includes('target="_blank" rel="noopener"'));

console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
if (fail) console.log('失败项：\n' + fails.map(f => ' - ' + f).join('\n'));
process.exit(fail ? 1 : 0);
