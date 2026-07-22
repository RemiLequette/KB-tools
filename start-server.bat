@echo off
REM start-server.bat — Launch the shared local development server
REM
REM Edit the allowed roots below to match your machine's folder layout.
REM Add or remove lines as needed. At least one root is required.
REM
REM To start automatically at boot:
REM   Place a shortcut to this file in your Windows Startup folder.
REM   (Win+R -> shell:startup)

node "%~dp0local-server.js" ^
  "C:\Users\RemiLequette\Dropbox\AfrSCM2026_1.70_INVITE-ES_RSE" ^
  "C:\Users\RemiLequette\Development" ^
  "I:\Shared drives\T4B-Shared" ^
  --port 3000

pause
