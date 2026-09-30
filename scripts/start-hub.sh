#!/usr/bin/env bash
# Keylo hub launcher for macOS / Linux — the twin of start-hub.cmd.
#
# Starts the app on this machine, then opens a free public HTTPS link (via
# Cloudflare) that reps can reach from anywhere. The app is only reachable
# through the login, so the link is safe to share with the team — but keep it
# out of public posts and give everyone a strong password.
#
# Needs Node and cloudflared:
#   macOS:  brew install cloudflared
#   Linux:  see https://github.com/cloudflare/cloudflared/releases
set -euo pipefail
cd "$(dirname "$0")/.."

echo
echo "  Starting the Keylo hub on this machine..."
node server/index.js &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

sleep 4

if ! command -v cloudflared >/dev/null 2>&1; then
  echo
  echo "  cloudflared is not installed, so the hub is only reachable on this"
  echo "  machine at http://localhost:3000 ."
  echo "  To let reps in from anywhere, install cloudflared and run this again:"
  echo "    macOS: brew install cloudflared"
  echo
  wait "$APP_PID"
fi

echo
echo "  Opening your public link. Share the https://...trycloudflare.com"
echo "  address printed below with your reps. Leave this running — stopping"
echo "  it takes the hub offline."
echo
cloudflared tunnel --url http://localhost:3000
