#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 server (1 vCPU / 2 GB).
# Run as root (or with sudo):  sudo bash ops/server-setup.sh
set -euo pipefail

# 1. Docker Engine + compose plugin (official convenience script).
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
# Docker DNS: on this provider's image the containers inherited the host's
# 127.0.0.53 stub resolver, which they can't reach, so Caddy could not reach
# Let's Encrypt for the HTTPS certificate. Use public resolvers instead.
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{"dns": ["1.1.1.1", "8.8.8.8"]}' > /etc/docker/daemon.json
fi
systemctl enable docker
systemctl restart docker

# The provider image ships Nginx on port 80; Caddy (ops/Caddyfile) needs 80/443.
if systemctl list-unit-files nginx.service >/dev/null 2>&1; then
  systemctl stop nginx || true
  systemctl disable nginx || true
  systemctl mask nginx || true
fi

# 2. 2 GB swap: building the images needs more than 2 GB RAM for a moment.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 3. Firewall: only SSH and the web ports. Postgres, the API and settlement
#    are never published (they live on the private Docker network).
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 8080/tcp
  ufw --force enable
fi

echo "server ready — now run: ./ops/deploy.sh"
