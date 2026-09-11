@echo off
REM ============================================================
REM  Keylo hub — one-click launcher for Windows
REM
REM  Starts the app on this PC, then opens a free public HTTPS
REM  link (via Cloudflare) that your reps can open from anywhere.
REM  The app is reached ONLY through the login, so the link is
REM  safe to share with your team — but keep it out of public
REM  posts, and give everyone a strong password.
REM
REM  Needs Node (you already have it) and cloudflared:
REM    winget install --id Cloudflare.cloudflared
REM  or download cloudflared.exe from
REM    https://github.com/cloudflare/cloudflared/releases
REM  and put it next to this file or on your PATH.
REM ============================================================

cd /d "%~dp0\.."

echo.
echo   Starting the Keylo hub on this PC...
start "Keylo hub" cmd /k "node server/index.js"

REM Give the server a moment to come up before the tunnel points at it.
timeout /t 4 /nobreak >nul

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo   cloudflared is not installed, so I can only run it on this PC.
  echo   Open http://localhost:3000 here to use it yourself.
  echo.
  echo   To let your reps in from anywhere, install cloudflared:
  echo     winget install --id Cloudflare.cloudflared
  echo   then run this file again.
  echo.
  pause
  exit /b 0
)

echo.
echo   Opening your public link. Share the https://...trycloudflare.com
echo   address it prints below with your reps. Leave this window open —
echo   closing it takes the hub offline.
echo.
cloudflared tunnel --url http://localhost:3000
