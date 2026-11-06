#!/bin/sh
# Run as root inside an Alpine Linux VM. Expects bossmox.tgz and pve-root-ca.pem next to this script.
# Usage: install-in-alpine.sh <address people use> [proxmox url[,url]] [certificate name]
# With no Proxmox address, BossMox starts in setup mode and shows a code on this VM's console.
set -eu

PUBLIC_ADDRESS=$1
PVE_URL=${2:-}
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
[ ! -f "$STAGE/pve-root-ca.pem" ] || install -m 644 "$STAGE/pve-root-ca.pem" /etc/bossmox/pve-root-ca.pem
mkdir -p /var/lib/bossmox
chown bossmox:bossmox /var/lib/bossmox
chmod 750 /var/lib/bossmox

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
export TLS_CERT_FILE=/etc/bossmox/tls.crt
export TLS_KEY_FILE=/etc/bossmox/tls.key
EOF
if [ -n "$PVE_URL" ]; then
  cat >> /etc/bossmox/env <<EOF
export PVE_URL='$PVE_URL'
export PVE_CA_FILE=/etc/bossmox/pve-root-ca.pem
export PVE_TLS_NAME='$PVE_TLS_NAME'
export BOSSMOX_ALLOWED_HOSTS='$PUBLIC_ADDRESS'
EOF
fi
chmod 644 /etc/bossmox/env

cat > /etc/init.d/bossmox <<'EOF'
#!/sbin/openrc-run
description="BossMox: management app for Proxmox Virtual Environment"
supervisor=supervise-daemon
command=/usr/bin/node
command_args="dist/src/index.js"
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
  /usr/local/sbin/bossmox-setup-code
  checkpath -f -o bossmox:bossmox -m 640 /var/log/bossmox.log
}
EOF
chmod 755 /etc/init.d/bossmox

# The setup code proves control of this VM, so it's shown only here and kept on disk only as a hash.
cat > /usr/local/sbin/bossmox-setup-code <<'EOF'
#!/bin/sh
ISSUE=/etc/issue
sed -i '/^# BossMox setup/,/^# end BossMox setup/d' "$ISSUE"
grep -q '^export PVE_URL=' /etc/bossmox/env && exit 0
[ -f /var/lib/bossmox/settings.json ] && exit 0
HASH=/var/lib/bossmox/setup.hash
CODE_FILE=/var/lib/bossmox/setup.code
if [ ! -f "$HASH" ] || [ ! -f "$CODE_FILE" ]; then
  RAW=$(openssl rand -hex 6 | tr 'a-f' 'A-F')
  printf '%s' "$RAW" | sha256sum | cut -d' ' -f1 > "$HASH"
  printf '%s' "$RAW" > "$CODE_FILE"
  chown bossmox:bossmox "$HASH"
  chown root:root "$CODE_FILE"
  chmod 640 "$HASH"
  chmod 600 "$CODE_FILE"
fi
RAW=$(cat "$CODE_FILE")
ADDR=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
{
  echo '# BossMox setup'
  echo
  echo "  To set up BossMox, open https://$ADDR"
  echo "  Setup code: $(echo "$RAW" | sed 's/..../&-/g; s/-$//')"
  echo
  echo '# end BossMox setup'
} >> "$ISSUE"
EOF
chmod 755 /usr/local/sbin/bossmox-setup-code
cat > /usr/local/sbin/bossmox-reset <<'EOF'
#!/bin/sh
# Starts setup again with a new code. Only someone with console access to this VM can run this.
rm -f /var/lib/bossmox/settings.json /var/lib/bossmox/setup.hash /var/lib/bossmox/setup.code /var/lib/bossmox/pve-root-ca.pem
rc-service bossmox restart
EOF
chmod 755 /usr/local/sbin/bossmox-reset

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
