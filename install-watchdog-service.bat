@echo off
REM ============================================
REM 安装 kanban-watchdog 为 Windows 服务（开机自启，无需登录）
REM 使用方法：右键本文件 -> 以管理员身份运行
REM ============================================
set NSSM=C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe
set ROOT=C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban
set NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe

echo [1/5] 注册服务...
"%NSSM%" install kanban-watchdog "%NODE%" watchdog.js
"%NSSM%" set kanban-watchdog AppDirectory "%ROOT%"
"%NSSM%" set kanban-watchdog AppStdout "%ROOT%\data\watchdog-service.log"
"%NSSM%" set kanban-watchdog AppStderr "%ROOT%\data\watchdog-service.log"
"%NSSM%" set kanban-watchdog AppRotateFiles 1
"%NSSM%" set kanban-watchdog AppRotateBytes 1048576

echo [2/5] 设置开机自启...
"%NSSM%" set kanban-watchdog Start SERVICE_AUTO_START

echo [3/5] 崩溃自动重启...
"%NSSM%" set kanban-watchdog AppExit Default Restart
"%NSSM%" set kanban-watchdog AppRestartDelay 5000

echo [4/5] 启动服务...
"%NSSM%" start kanban-watchdog

echo [5/5] 完成！服务状态：
"%NSSM%" status kanban-watchdog
echo.
echo 验证：浏览器打开 https://kanban.forestkopa.top 应为 200
pause
