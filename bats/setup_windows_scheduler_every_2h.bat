@echo off
setlocal
cd /d "%~dp0\.."
REM PostgreSQL -> Google Sheets keyed sync every 2 hours (07:00, 09:00, ... local time).
REM Uses the non-interactive wrapper (no PAUSE). An overlapping run exits safely
REM because sync_bp_keyed.py holds a single-sync OS lock. An unchanged source is a NOOP.
set TASK_NAME=MDG_BP_GSheet_Keyed_Sync_Every2h
set SCRIPT_PATH=%CD%\bats\sync_to_gsheet_scheduled.bat

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
schtasks /Create /TN "%TASK_NAME%" /SC HOURLY /MO 2 /ST 07:00 /TR "\"%SCRIPT_PATH%\"" /F
if errorlevel 1 (
  echo [ERROR] Could not create the scheduled task.
  pause
  exit /b 1
)
echo.
echo Scheduler created: every 2 hours starting 07:00 local Windows time.
echo Remove the 09:00/15:00 tasks if they exist: bats\remove_windows_scheduler.bat
echo Logs: logs\sync_gsheet_indexed.log
pause
