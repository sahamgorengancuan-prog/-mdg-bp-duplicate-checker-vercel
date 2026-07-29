@echo off
setlocal
cd /d "%~dp0\.."
call .venv\Scripts\activate.bat
python scripts\sync_gsheet_indexed.py
pause
