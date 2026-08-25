@echo off
REM 看板 watchdog 启动脚本（双击即可后台启动守护 + 隧道）
REM 建议配合「任务计划程序」开机自启（见 deploy/README-NAS.md 或对话指引）
cd /d "C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban"
start "kanban-watchdog" /min "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" watchdog.js
echo watchdog 已启动（最小化窗口）。日志见 data/watchdog.log
