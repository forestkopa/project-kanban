@echo off
REM Install kanban-watchdog as a Windows service (run as Administrator)
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" stop kanban-watchdog || echo (stop skipped)
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" remove kanban-watchdog confirm || echo (remove skipped)
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" install kanban-watchdog "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" "C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\watchdog.js"
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog AppDirectory "C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban"
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog AppStdout "C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\data\watchdog-service.log"
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog AppStderr "C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\data\watchdog-service.log"
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog Start SERVICE_AUTO_START
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog AppExit Default Restart
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" set kanban-watchdog AppRestartDelay 5000
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" start kanban-watchdog
"C:\Users\Administrator\WorkBuddy\2026-08-20-10-00-21\project-kanban\tools\nssm-2.24\win64\nssm.exe" status kanban-watchdog
echo.
echo === Done. Open https://kanban.forestkopa.top to verify. ===
