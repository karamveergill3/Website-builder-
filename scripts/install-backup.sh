#!/usr/bin/env bash
#
# Install the nightly database backup as a systemd timer. Run once, on the
# server:
#
#   cd ~/keylo && bash scripts/install-backup.sh
#
# It runs `node scripts/backup.js` every night at 03:00 (and catches up if the
# machine was asleep). Backups land in data/backups/, newest 14 kept.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
USER_NAME="$(whoami)"

if [ -z "$NODE_BIN" ]; then
  echo "node is not on PATH — cannot install the backup timer." >&2
  exit 1
fi

sudo tee /etc/systemd/system/keylo-backup.service >/dev/null <<UNIT
[Unit]
Description=Prospect Book nightly database backup

[Service]
Type=oneshot
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} scripts/backup.js
UNIT

sudo tee /etc/systemd/system/keylo-backup.timer >/dev/null <<UNIT
[Unit]
Description=Run the Prospect Book backup nightly

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now keylo-backup.timer

echo
echo "Nightly backup installed. Scheduled runs:"
systemctl list-timers keylo-backup.timer --no-pager || true
echo
echo "Take one right now to prove it works:  npm run backup"
