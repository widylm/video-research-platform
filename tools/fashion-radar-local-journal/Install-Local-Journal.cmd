@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer and run this installer again.
  exit /b 1
)
node "%~dp0install.mjs" %*
exit /b %errorlevel%
