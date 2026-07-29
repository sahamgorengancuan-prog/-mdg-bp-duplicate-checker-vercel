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
echo Put service_account.json in this folder and share the Google Sheet to the service account email.
pause
