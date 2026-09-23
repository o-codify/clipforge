@echo off
rem Web interface: catalog, actions, clip preview.
setlocal
cd /d "%~dp0"
start "" http://localhost:3000
node scripts/start.mjs
pause
