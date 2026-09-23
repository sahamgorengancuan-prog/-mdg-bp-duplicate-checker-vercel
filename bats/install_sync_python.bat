@echo off
setlocal
cd /d "%~dp0\.."

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Python 3.10+ first.
  pause
  exit /b 1
)

if not exist .venv (
  python -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r scripts\requirements.txt

if not exist .env (
  copy .env.example .env
  echo Created .env. Please edit DB_PASS and check DB_QUERY/address mapping.
)

echo.
echo Installation complete.
echo Google access uses the OAuth user token (oauth_token.json / client_secret_oauth.json).
echo No service account is used. Run bats\sync_to_gsheet_now.bat once to test the sync.
pause
