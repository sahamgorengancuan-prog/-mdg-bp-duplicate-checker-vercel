@echo off
setlocal EnableExtensions
cd /d "%~dp0\.." || exit /b 2
REM Noninteractive Task Scheduler entry point: same OAuth .venv + keyed sync.
REM The --scheduled argument suppresses PAUSE so background tasks can finish.
call "bats\sync_to_gsheet_now.bat" --scheduled
exit /b %ERRORLEVEL%
