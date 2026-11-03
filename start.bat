@echo off
rem The CLI starts a detached, windowless server and then exits.
cd /d "%~dp0"
node bin\riffledesk.js %*
