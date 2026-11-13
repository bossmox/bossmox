#!/usr/bin/env bash
# Run inside the container. Expects bossmox.tgz and pve-root-ca.pem next to this script, in a folder only root
# can write to (update.sh makes one).
# Usage: install-in-lxc.sh <address people use> <proxmox url> [certificate name]
set -euo pipefail

HERE=$(cd "$(dirname -- "$0")" && pwd)
PUBLIC_ADDRESS=$1
PVE_URL=$2
PVE_TLS_NAME=${3:-}

# These end up in a file that's read by a root shell, so only what an address or URL needs gets through.
for value in "$PUBLIC_ADDRESS" "$PVE_URL" "$PVE_TLS_NAME"; do
  case "$value" in
    *[!]A-Za-z0-9.:/,_[-]*) echo "That doesn't look like an address: $value" >&2; exit 1 ;;
  esac
done
NODE_VERSION=22.22.2

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl xz-utils ca-certificates openssl unattended-upgrades >/dev/null

if [ "$(/opt/node/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  NODE_DL=$(mktemp -d)
  cd "$NODE_DL"
  FILE="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$FILE"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $FILE\$" | sha256sum -c - >/dev/null
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "$FILE" -C /opt/node --strip-components=1
  cd /
  rm -rf "$NODE_DL"
fi

id bossmox >/dev/null 2>&1 || useradd --system --home-dir /opt/bossmox --shell /usr/sbin/nologin bossmox
mkdir -p /opt/bossmox /etc/bossmox
tar --no-same-owner -xzf "$HERE/bossmox.tgz" -C /opt/bossmox
chown -R root:root /opt/bossmox
install -m 644 "$HERE/pve-root-ca.pem" /etc/bossmox/pve-root-ca.pem

# BossMox's CA and certificate (ADR 0040). An update re-runs this: an old self-signed certificate is replaced once,
# and from then on only renewed, from the same CA, so the Proxmox nodes keep trusting it.
install -m 755 /opt/bossmox/deploy/bossmox-cert.sh /usr/local/sbin/bossmox-cert
/usr/local/sbin/bossmox-cert "$PUBLIC_ADDRESS" >/dev/null
# A daily timer renews the certificate when under 60 days are left.
printf '[Unit]\nDescription=Renew BossMox certificate when due\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/bossmox-cert renew\n' > /etc/systemd/system/bossmox-cert.service
printf '[Unit]\nDescription=Renew BossMox certificate when due\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/bossmox-cert.timer
systemctl daemon-reload
systemctl enable --now bossmox-cert.timer >/dev/null 2>&1
# The key BossMox seals saved sign-ins with (ADR 0040). Made once and kept by every update, or a saved sign-in
# couldn't be opened again. BossMox can read it and can't replace it.
if [ ! -s /etc/bossmox/secret.key ]; then
  (umask 077 && openssl rand -hex 32 > /etc/bossmox/secret.key)
fi
chown root:bossmox /etc/bossmox/secret.key
chmod 640 /etc/bossmox/secret.key

cat > /etc/bossmox/env <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=443
PVE_URL=$PVE_URL
PVE_CA_FILE=/etc/bossmox/pve-root-ca.pem
PVE_TLS_NAME=$PVE_TLS_NAME
BOSSMOX_ALLOWED_HOSTS=$PUBLIC_ADDRESS
TLS_CERT_FILE=/etc/bossmox/tls.crt
TLS_KEY_FILE=/etc/bossmox/tls.key
EOF
chmod 644 /etc/bossmox/env

install -m 644 /opt/bossmox/deploy/bossmox.service /etc/systemd/system/bossmox.service
systemctl daemon-reload
systemctl enable --now bossmox >/dev/null 2>&1
systemctl restart bossmox
rm -f "$HERE/bossmox.tgz" "$HERE/pve-root-ca.pem"
