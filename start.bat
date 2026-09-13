@echo off
title AIOSports

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit /b
)

echo [AIOSports] Installing dependencies if needed...
call npm install

echo.
echo [AIOSports] Starting the server...
call npm start

pause
