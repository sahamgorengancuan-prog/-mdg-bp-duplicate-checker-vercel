@echo off
setlocal
cd /d "%~dp0\.."

REM Prefer installed virtualenv, but do not silently use an incomplete one.
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import pandas, psycopg2, gspread, google_auth_oauthlib" >nul 2>nul
    if not errorlevel 1 (
        ".venv\Scripts\python.exe" scripts\sync_gsheet_indexed.py
        if errorlevel 1 exit /b 1
        exit /b 0
    )
    echo Virtualenv dependencies missing; trying the working Windows Python launcher.
)
py -c "import pandas, psycopg2, gspread, google_auth_oauthlib" >nul 2>nul
if errorlevel 1 (
    echo Missing dependencies. Run: py -m pip install -r scripts\requirements.txt
    exit /b 1
)
py scripts\sync_gsheet_indexed.py
exit /b %errorlevel%
