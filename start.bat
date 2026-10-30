@echo off
rem riffledesk headless launcher: start server in background, then open browser.
cd /d "%~dp0"
start "" /b node server.js
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:5177/"
