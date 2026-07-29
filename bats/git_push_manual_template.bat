@echo off
setlocal
cd /d "%~dp0\.."

echo This script initializes git and pushes to your GitHub repo.
echo Edit REPO_URL below before running.

set REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

if "%REPO_URL%"=="https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git" (
  echo Please edit REPO_URL inside bats\git_push_manual_template.bat first.
  pause
  exit /b 1
)

git init
git add .
git commit -m "Initial Vercel deploy version"
git branch -M main
git remote remove origin 2>nul
git remote add origin %REPO_URL%
git push -u origin main
pause
