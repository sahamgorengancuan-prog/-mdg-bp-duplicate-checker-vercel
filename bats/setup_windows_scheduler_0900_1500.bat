@echo off
setlocal
cd /d "%~dp0\.."
set TASK_NAME=MDG_BP_GSheet_Indexed_Sync
set SCRIPT_PATH=%CD%\bats\sync_to_gsheet_now.bat

schtasks /Delete /TN "%TASK_NAME%_0900" /F >nul 2>nul
schtasks /Delete /TN "%TASK_NAME%_1500" /F >nul 2>nul

schtasks /Create /TN "%TASK_NAME%_0900" /SC DAILY /ST 09:00 /TR "\"%SCRIPT_PATH%\"" /F
schtasks /Create /TN "%TASK_NAME%_1500" /SC DAILY /ST 15:00 /TR "\"%SCRIPT_PATH%\"" /F

echo.
echo Scheduler created: 09:00 and 15:00 local Windows time.
pause
