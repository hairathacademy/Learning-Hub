@echo off
setlocal
cd /d "%~dp0"
title HAIRATH ACADEMY - Server
if not exist node_modules (
  echo Installing required packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation failed. Make sure Node.js LTS is installed.
    pause
    exit /b 1
  )
)
echo.
echo Starting HAIRATH ACADEMY...
start "HAIRATH ACADEMY Browser" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
call npm start
pause
