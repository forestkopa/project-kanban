甘特图布局备份存档
====================
备份时间：2026-08-20 17:41
版本标记：v=20260820-r38（index.html 资源版本号）
备份原因：用户确认「保持当前甘特图布局不要动，备份一下」

当前甘特图布局要点（r38）：
1. 顶部横坐标：独立灰底字母行（g-alpha）——纯列标 A | B | C | D + 时间轴刻度/今日线，仅用于公式定位
2. 表头行（行号 1）：公式框 | 开始 | 结束 | 天数（B1=开始、C1=结束、D1=天数）
3. 左侧竖坐标：独立行号列（g-rnum，34px 灰底），表头=1，分组/任务行=2..连续
4. 工具栏：项目开始日期 + 重新排期（项目开始不在表格内）
5. 任务行：行号 | 任务名 | 开始日期 | 结束日期 | 天数(可编辑) | 甘特条
6. 公式框：点选任务开始/结束日期显示当前坐标公式（如 =B4、=C4+1、=WORKDAY.INTL(B6-1,D6,11)），可修改后级联
7. 天数编辑：D 列可编辑，改后结束日期按公式级联重算
8. 重新排期：彻底清除公式（规则+原文）

恢复方法：将本目录下文件复制回项目根目录对应位置：
  public/* -> public/
  server.js -> ./
  templates.json -> ./
  package.json -> ./
  data/* -> data/
（恢复前建议把当前文件再备份一份）

备份内容清单：
  public/index.html  页面结构（视图栏/弹窗，资源版本 r38）
  public/style.css   样式（含 .g-alpha/.g-rnum/.g-colA-D/.g-date-head/.g-days-in 等甘特样式）
  public/app.js      逻辑（renderGantt 坐标布局、ganttRowMap/xlsxToCur/curFormulaStr/curToXlsxFormula、公式框、天数编辑）
  public/wb-logo.png 品牌图标
  server.js          后端（公式解析/级联重算/reschedule 彻底清公式/只读/brand-logo/映射模版等）
  templates.json     模板（4 个：门锁/手表/摄像头/音箱）
  data/projects.json 项目数据
  data/mappings.json 映射模版
  data/readonly.flag 只读标记
