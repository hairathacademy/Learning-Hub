@echo off
setlocal
cd /d "%~dp0"
title HAIRATH ACADEMY - Course Platform
if not exist node_modules (
  echo First-time setup: installing packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Please install Node.js LTS and try again.
    pause
    exit /b 1
  )
)
echo Starting HAIRATH ACADEMY server...
start "HAIRATH ACADEMY Browser" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm start
pause
