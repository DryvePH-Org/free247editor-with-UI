@echo off
rem Double-click to open free247editor in your browser (Windows). Keep this window open while you edit.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it with: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
node app\server.mjs
pause
