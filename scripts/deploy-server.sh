#!/usr/bin/env bash
# =============================================================================
#  Keylo hub — one-command installer for a free 24/7 server
#
#  Run this ON the server (an Oracle Cloud "Always Free" Ubuntu box), from
#  inside the cloned repo:
#
#      cd ~/website-builder-
#      bash scripts/deploy-server.sh
#
#  It sets the hub up to run on its own, forever, reachable at a permanent
#  HTTPS link — so the team gets in whether or not your PC is on. In one go it:
#
#    * installs Node 22, the build tools, and Caddy (the bit that gives you
#      free automatic HTTPS);
#    * installs the app's dependencies;
#    * runs the hub as a background service that starts on boot and restarts
#      itself if it ever crashes;
#    * points your free DuckDNS web address at this server and keeps it pointed
#      there;
#    * opens the server's own firewall for web traffic (ports 80 and 443).
#
#  It is safe to run again — nothing is duplicated, and re-running is how you
#  pick up code changes after a `git pull`.
#
#  ONE thing it can't do for you: opening ports 80 and 443 in the Oracle
#  *console* (the "Security List"). That lives in Oracle's website, not on the
#  server. docs/DEPLOY.md walks you through it — do it before or right after
#  this, or the HTTPS link won't come up.
# =============================================================================
set -euo pipefail

# --- don't run this as root; it uses sudo only where it must ----------------
if [ "$(id -u)" -eq 0 ]; then
  echo "Please run this as your normal user (e.g. 'ubuntu'), NOT with sudo." >&2
  echo "It will ask for sudo itself for the few steps that need it." >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="$(id -un)"
say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }

say "Installing the Keylo hub from: $APP_DIR  (as user: $RUN_USER)"

# --- config: DuckDNS address (free, permanent) ------------------------------
# You get these free at https://www.duckdns.org — sign in, pick a subdomain,
# copy your token. You can also pass them ahead of time, e.g.:
#   DUCKDNS_SUBDOMAIN=keylostudios DUCKDNS_TOKEN=xxxx bash scripts/deploy-server.sh
DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN:-}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"
while [ -z "$DUCKDNS_SUBDOMAIN" ]; do
  read -r -p "Your DuckDNS subdomain (just the name, e.g. 'keylostudios'): " DUCKDNS_SUBDOMAIN
  DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN%%.duckdns.org}"   # tolerate a full domain being pasted
done
while [ -z "$DUCKDNS_TOKEN" ]; do
  read -r -p "Your DuckDNS token: " DUCKDNS_TOKEN
done
DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
say "This hub will live at:  https://${DOMAIN}"

# --- a little swap, so a 1 GB box never runs out of memory ------------------
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [ "${mem_kb:-0}" -lt 1900000 ] && [ ! -f /swapfile ]; then
  say "Small server — adding 2 GB of swap so installs and the app never stall."
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

export DEBIAN_FRONTEND=noninteractive

# --- system packages --------------------------------------------------------
say "Updating the server and installing basics (git, build tools, curl)…"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git build-essential python3 iptables-persistent

# --- Node 22 ----------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node $(node -v) already present — good."
fi
NODE_BIN="$(command -v node)"

# --- Caddy (free automatic HTTPS) -------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy (handles the HTTPS certificate automatically, for free)…"
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
else
  say "Caddy already present — good."
fi

# --- app dependencies -------------------------------------------------------
say "Installing the app's dependencies…"
cd "$APP_DIR"
mkdir -p data
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# --- .env (secrets live here, never in the repo) ----------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  warn "Created a blank .env — you MUST paste your API keys into it later:"
  warn "    nano $APP_DIR/.env      (then: sudo systemctl restart keylo)"
fi

# --- run the hub as a service that survives reboots and crashes -------------
say "Setting the hub up to run on its own (starts on boot, restarts if it crashes)…"
sudo tee /etc/systemd/system/keylo.service >/dev/null <<UNIT
[Unit]
Description=Keylo hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/index.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now keylo
sleep 2
sudo systemctl restart keylo

# --- keep the DuckDNS address pointed at this server ------------------------
say "Pointing ${DOMAIN} at this server and keeping it updated…"
sudo tee /etc/keylo-duckdns.env >/dev/null <<ENV
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
ENV
sudo chmod 600 /etc/keylo-duckdns.env
sudo tee /usr/local/bin/keylo-duckdns.sh >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
. /etc/keylo-duckdns.env
curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null
SCRIPT
sudo chmod +x /usr/local/bin/keylo-duckdns.sh
sudo tee /etc/systemd/system/keylo-duckdns.service >/dev/null <<'UNIT'
[Unit]
Description=Update DuckDNS for the Keylo hub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/keylo-duckdns.sh
UNIT
sudo tee /etc/systemd/system/keylo-duckdns.timer >/dev/null <<'UNIT'
[Unit]
Description=Refresh DuckDNS for the Keylo hub every 5 minutes

[Timer]
OnBootSec=30
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now keylo-duckdns.timer
sudo /usr/local/bin/keylo-duckdns.sh || warn "DuckDNS update failed — check the subdomain and token."

# --- Caddy: serve the domain(s) over HTTPS, proxying to the hub -------------
# The list of hostnames Caddy serves lives in /etc/keylo-domains, one per line.
# The DuckDNS domain is always included; a branded domain added there later
# (e.g. app.keylostudios.com) is kept across re-runs of this installer.
if ! sudo test -f /etc/keylo-domains; then
  echo "${DOMAIN}" | sudo tee /etc/keylo-domains >/dev/null
elif ! sudo grep -qxF "${DOMAIN}" /etc/keylo-domains; then
  echo "${DOMAIN}" | sudo tee -a /etc/keylo-domains >/dev/null
fi
CADDY_HOSTS="$(sudo grep -v '^[[:space:]]*$' /etc/keylo-domains | paste -sd, -)"
say "Telling Caddy to serve: ${CADDY_HOSTS}"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${CADDY_HOSTS} {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
CADDY
sudo systemctl restart caddy

# --- open the server's own firewall for web traffic -------------------------
say "Opening the server firewall for web traffic (ports 80 and 443)…"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
sudo netfilter-persistent save >/dev/null 2>&1 || sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null

# --- done -------------------------------------------------------------------
cat <<DONE

$(say "Installed. The hub is running.")

  Your permanent link:   https://${DOMAIN}

  Two things to finish:

  1) OPEN PORTS IN THE ORACLE CONSOLE (once). On the server's own firewall
     they're open now, but Oracle blocks them in the cloud too. In the Oracle
     website: your VM → its Virtual Cloud Network → the public Subnet → its
     Security List → add two Ingress rules: Source 0.0.0.0/0, TCP, dest ports
     80 and 443. Full click-by-click is in docs/DEPLOY.md. Until this is done,
     the https link will not load and Caddy keeps retrying the certificate.

  2) PASTE YOUR API KEYS into the .env file so the hunt and PayPal work:
        nano ${APP_DIR}/.env
        sudo systemctl restart keylo

  Then open https://${DOMAIN} — the first screen creates your owner account.

  Handy commands:
    sudo systemctl status keylo         # is the hub running?
    sudo journalctl -u keylo -f         # live hub logs
    sudo systemctl restart keylo        # restart after editing .env
    sudo journalctl -u caddy -f         # HTTPS / certificate logs

DONE
