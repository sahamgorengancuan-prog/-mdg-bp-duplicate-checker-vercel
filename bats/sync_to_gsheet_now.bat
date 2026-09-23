@echo off
setlocal EnableExtensions
cd /d "%~dp0\.." || goto :startup_failed

REM Manual launch: show every step and PAUSE so early errors remain visible.
REM Scheduled launch: call this BAT with --scheduled to return promptly.
REM Do not switch back to sync_gsheet_indexed.py: it clears/repopulates tabs.
set "SYNC_FORCE_EXIT_AFTER_SUCCESS="
echo.
echo ============================================================
echo MDG BP DUPLICATE - KEYED INCREMENTAL GOOGLE SHEETS SYNC
echo ============================================================
echo [START] %date% %time%
echo [ROOT] %CD%
echo [MODE] %~1

if not exist ".venv\Scripts\activate.bat" (
    echo [ERROR] Working OAuth virtualenv .venv not found.
    echo [FIX] Run: bats\install_sync_python.bat
    set "SYNC_RC=2"
    goto :finish
)
if not exist "scripts\sync_bp_keyed.py" (
    echo [ERROR] scripts\sync_bp_keyed.py is missing.
    echo [FIX] Download the keyed script from the GitHub main branch.
    set "SYNC_RC=2"
    goto :finish
)
echo [1/3] Activating the SAME .venv as the proven OAuth BAT...
call ".venv\Scripts\activate.bat"
if errorlevel 1 (
    echo [ERROR] Virtualenv activation failed.
    set "SYNC_RC=2"
    goto :finish
)
echo [2/3] Checking Python and required libraries...
python -c "import pandas, psycopg2, gspread, google_auth_oauthlib"
if errorlevel 1 (
    echo [ERROR] Dependencies missing in .venv.
    echo [FIX] Run: python -m pip install -r scripts\requirements.txt
    set "SYNC_RC=2"
    goto :finish
)
echo [3/3] Starting keyed delta sync with local .env and existing OAuth token...
echo [INFO] Google Sheets ONLY: GSHEET_SNAPSHOT_MODE=dual.
echo [INFO] Requires approved, separate SHEET_A_ID / SHEET_B_ID / SHEET_CONTROL_ID.
echo [INFO] Active snapshot stays unchanged while staging sync runs.
python -u "scripts\sync_bp_keyed.py"
set "SYNC_RC=%ERRORLEVEL%"

:finish
echo.
if "%SYNC_RC%"=="0" (
    echo [SUCCESS] Sync script finished at %date% %time%.
) else (
    echo [FAILED] Exit code %SYNC_RC% at %date% %time%.
    echo [INFO] See logs\sync_gsheet_indexed.log for Python diagnostics.
)
echo [INFO] This BAT never force-kills Python or clears Google Sheets.
if /I "%~1"=="--scheduled" goto :end
echo.
pause
:end
exit /b %SYNC_RC%

:startup_failed
echo [ERROR] Cannot enter the project directory.
if /I not "%~1"=="--scheduled" pause
exit /b 2
