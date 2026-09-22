@echo off
setlocal
cd /d "%~dp0\.."
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m pip install -r scripts\requirements.txt
    if errorlevel 1 exit /b 1
    ".venv\Scripts\python.exe" scripts\sync_gsheet_indexed.py
    if errorlevel 1 exit /b 1
    exit /b 0
)
py -m pip install -r scripts\requirements.txt
if errorlevel 1 exit /b 1
py scripts\sync_gsheet_indexed.py
exit /b %errorlevel%
