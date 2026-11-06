#!/bin/sh
# Run as root inside an Alpine Linux VM. Expects bossmox.tgz and pve-root-ca.pem next to this script.
# Usage: install-in-alpine.sh <address people use> <proxmox url[,url]> [certificate name]
set -eu

PUBLIC_ADDRESS=$1
PVE_URL=$2
PVE_TLS_NAME=${3:-}

# These end up in a file that's read by a root shell, so only what an address or URL needs gets through.
for value in "$PUBLIC_ADDRESS" "$PVE_URL" "$PVE_TLS_NAME"; do
  case "$value" in
    *[!]A-Za-z0-9.:/,_[-]*) echo "That doesn't look like an address: $value" >&2; exit 1 ;;
  esac
done
STAGE=$(dirname "$0")

apk update -q
apk upgrade -q
apk add -q nodejs openssl logrotate

# Alpine ignores Proxmox's shutdown request unless this is running, so the VM couldn't shut down cleanly.
rc-update add acpid default >/dev/null
rc-service acpid start >/dev/null

if id bossmox >/dev/null 2>&1 && [ "$(id -gn bossmox)" != bossmox ]; then deluser bossmox; fi
grep -q "^bossmox:" /etc/group || addgroup -S bossmox
id bossmox >/dev/null 2>&1 || adduser -S -D -H -h /opt/bossmox -s /sbin/nologin -G bossmox bossmox
mkdir -p /opt/bossmox /etc/bossmox
tar --no-same-owner -xzf "$STAGE/bossmox.tgz" -C /opt/bossmox
chown -R root:root /opt/bossmox
install -m 644 "$STAGE/pve-root-ca.pem" /etc/bossmox/pve-root-ca.pem

if [ ! -f /etc/bossmox/tls.key ]; then
  SAN=""
  OLDIFS=$IFS
  IFS=,
  for name in $PUBLIC_ADDRESS; do
    case "$name" in
      *:*:*) entry="IP:$name" ;;
      *[!0-9.:]*) entry="DNS:${name%%:*}" ;;
      *) entry="IP:${name%%:*}" ;;
    esac
    SAN="${SAN:+$SAN,}$entry"
  done
  IFS=$OLDIFS
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout /etc/bossmox/tls.key -out /etc/bossmox/tls.crt \
    -subj "/CN=BossMox" -addext "subjectAltName=$SAN" 2>/dev/null
fi
chown root:bossmox /etc/bossmox/tls.key
chmod 640 /etc/bossmox/tls.key

cat > /etc/bossmox/env <<EOF
export NODE_ENV=production
export HOST=0.0.0.0
export PORT=443
export PVE_URL='$PVE_URL'
export PVE_CA_FILE=/etc/bossmox/pve-root-ca.pem
export PVE_TLS_NAME='$PVE_TLS_NAME'
export BOSSMOX_ALLOWED_HOSTS='$PUBLIC_ADDRESS'
export TLS_CERT_FILE=/etc/bossmox/tls.crt
export TLS_KEY_FILE=/etc/bossmox/tls.key
EOF
chmod 644 /etc/bossmox/env

cat > /etc/init.d/bossmox <<'EOF'
#!/sbin/openrc-run
description="BossMox: management app for Proxmox Virtual Environment"
supervisor=supervise-daemon
command=/usr/bin/node
command_args="dist/src/server.js"
command_user=bossmox:bossmox
directory=/opt/bossmox
capabilities="^cap_net_bind_service"
output_log=/var/log/bossmox.log
error_log=/var/log/bossmox.log
respawn_delay=3
# A core dump would hold live Proxmox tickets.
rc_ulimit="-c 0"

depend() {
  need net
}

start_pre() {
  . /etc/bossmox/env
  checkpath -f -o bossmox:bossmox -m 640 /var/log/bossmox.log
}
EOF
chmod 755 /etc/init.d/bossmox

# The disk is 1 GB, so the log can't be left to grow.
cat > /etc/logrotate.d/bossmox <<'EOF'
/var/log/bossmox.log {
  size 5M
  rotate 3
  compress
  missingok
  notifempty
  copytruncate
}
EOF
cat > /etc/periodic/hourly/bossmox-logs <<'EOF'
#!/bin/sh
exec /usr/sbin/logrotate /etc/logrotate.d/bossmox
EOF
chmod 755 /etc/periodic/hourly/bossmox-logs
rc-update add crond default >/dev/null 2>&1 || true
rc-service crond start >/dev/null 2>&1 || true
rc-update add bossmox default >/dev/null 2>&1 || true
rc-service bossmox restart >/dev/null 2>&1 || rc-service bossmox start
rm -f "$STAGE/bossmox.tgz" "$STAGE/pve-root-ca.pem"
