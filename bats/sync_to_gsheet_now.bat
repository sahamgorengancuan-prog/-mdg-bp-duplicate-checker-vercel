@echo off
setlocal
cd /d "%~dp0\.."
REM Keyed delta sync only. NEVER run full-clear/repopulate legacy script here.
REM The Python entrypoint refuses to modify Google Sheets until the
REM private transactional search backend is explicitly configured.
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import pandas, psycopg2, gspread, google_auth_oauthlib" >nul 2>nul
    if not errorlevel 1 (
        ".venv\Scripts\python.exe" scripts\sync_bp_keyed.py
        exit /b %errorlevel%
    )
)
py -c "import pandas, psycopg2, gspread, google_auth_oauthlib" >nul 2>nul
if errorlevel 1 (
    echo Missing dependencies. Run: py -m pip install -r scripts\requirements.txt
    exit /b 1
)
py scripts\sync_bp_keyed.py
exit /b %errorlevel%
