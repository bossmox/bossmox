#!/bin/sh
# Run as root inside an Alpine Linux VM. Expects /tmp/bossmox.tgz and /tmp/pve-root-ca.pem.
# Usage: install-in-alpine.sh <address people use> <proxmox url[,url]> [certificate name]
set -eu

PUBLIC_ADDRESS=$1
PVE_URL=$2
PVE_TLS_NAME=${3:-}

apk update -q
apk upgrade -q
apk add -q nodejs openssl

if id bossmox >/dev/null 2>&1 && [ "$(id -gn bossmox)" != bossmox ]; then deluser bossmox; fi
grep -q "^bossmox:" /etc/group || addgroup -S bossmox
id bossmox >/dev/null 2>&1 || adduser -S -D -H -h /opt/bossmox -s /sbin/nologin -G bossmox bossmox
mkdir -p /opt/bossmox /etc/bossmox
tar --no-same-owner -xzf /tmp/bossmox.tgz -C /opt/bossmox
chown -R root:root /opt/bossmox
install -m 644 /tmp/pve-root-ca.pem /etc/bossmox/pve-root-ca.pem

if [ ! -f /etc/bossmox/tls.key ]; then
  case "$PUBLIC_ADDRESS" in
    *[!0-9.]*) SAN="DNS:$PUBLIC_ADDRESS" ;;
    *) SAN="IP:$PUBLIC_ADDRESS" ;;
  esac
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
export PVE_URL=$PVE_URL
export PVE_CA_FILE=/etc/bossmox/pve-root-ca.pem
export PVE_TLS_NAME=$PVE_TLS_NAME
export BOSSMOX_ALLOWED_HOSTS=$PUBLIC_ADDRESS
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

depend() {
  need net
}

start_pre() {
  . /etc/bossmox/env
  checkpath -f -o bossmox:bossmox -m 640 /var/log/bossmox.log
}
EOF
chmod 755 /etc/init.d/bossmox
rc-update add bossmox default >/dev/null 2>&1 || true
rc-service bossmox restart >/dev/null 2>&1 || rc-service bossmox start
rm -f /tmp/bossmox.tgz /tmp/pve-root-ca.pem
