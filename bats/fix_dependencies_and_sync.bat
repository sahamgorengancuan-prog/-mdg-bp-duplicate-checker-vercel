@echo off
setlocal
cd /d "%~dp0\.."
REM Reinstall the sync dependencies into the proven OAuth .venv, then run the
REM keyed A/A2 + B/B2 sync. (The old full-clear legacy sync_gsheet_indexed.py
REM is no longer started from here.)
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv not found. Run bats\install_sync_python.bat first.
    pause
    exit /b 2
)
".venv\Scripts\python.exe" -m pip install -r scripts\requirements.txt
if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)
call "bats\sync_to_gsheet_now.bat" %*
exit /b %ERRORLEVEL%
