@echo off
setlocal

set "HERE=%~dp0"
set "ROOT=%HERE%..\.."
set "VAULT=%HERE%..\..\000-T4BVault"
set "PORT=3010"

start "" /min node "%HERE%viewer-server.js" "%ROOT%" --port %PORT%

timeout /t 2 /nobreak >nul

start "" "http://localhost:%PORT%/%HERE:\=/%canvas-player.html?vault=%VAULT:\=/%"
