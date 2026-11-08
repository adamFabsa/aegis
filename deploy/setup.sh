#!/usr/bin/env bash
# One-time setup of the Aegis server (Ubuntu 24.04 on Vultr), run as root:
#   DOMAIN=yourdomain.com bash setup.sh
# Installs Node 22, Caddy (automatic HTTPS), the firewall, the app code and the AI worker service.
# The website files (/srv/aegis) are copied up from a laptop build: see deploy/README.md.
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=aegis.example bash setup.sh}"
REPO=${REPO:-https://github.com/adamFabsa/aegis.git}

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw gnupg debian-keyring debian-archive-keyring apt-transport-https

# Node 22 (the worker runs on it)
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (web server with automatic Let's Encrypt certificates)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# firewall: ssh, http, https only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# app code (the worker reads ../seed/buildings.json, so the whole repo)
id -u aegis >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin aegis
if [ -d /opt/aegis/.git ]; then git -C /opt/aegis pull --ff-only; else git clone "$REPO" /opt/aegis; fi
chown -R aegis:aegis /opt/aegis
sudo -u aegis bash -c 'cd /opt/aegis/worker && npm ci --no-audit --no-fund'

# website
mkdir -p /srv/aegis
cp /opt/aegis/deploy/Caddyfile /etc/caddy/Caddyfile
echo "DOMAIN=$DOMAIN" > /etc/default/caddy
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/domain.conf
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy

# AI worker service (starts once /opt/aegis/worker/.env exists)
cp /opt/aegis/deploy/aegis-worker.service /etc/systemd/system/aegis-worker.service
systemctl daemon-reload
systemctl enable aegis-worker
if [ -f /opt/aegis/worker/.env ]; then systemctl restart aegis-worker; else echo "worker: add /opt/aegis/worker/.env, then: systemctl restart aegis-worker"; fi

echo "done: https://$DOMAIN (after DNS points here and the site files are in /srv/aegis)"
