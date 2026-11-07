#!/bin/sh
# Run as root inside an Alpine Linux VM. Expects bossmox.tgz and pve-root-ca.pem next to this script.
# Usage: install-in-alpine.sh <address people use> [proxmox url[,url]] [certificate name]
# With no Proxmox address, BossMox starts in setup mode and shows a code on this VM's console.
set -eu

# The guest agent runs commands with umask 077, which would leave the app unreadable by the service account.
umask 022

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
apk add -q nodejs openssl logrotate kbd

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

# The setup code proves control of this VM, so it's shown only on its console and BossMox keeps only a hash.
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/bossmox-setup-code <<'EOF'
#!/bin/sh
grep -q '^export PVE_URL=' /etc/bossmox/env && exit 0
[ -f /var/lib/bossmox/settings.json ] && exit 0
HASH=/var/lib/bossmox/setup.hash
CODE_FILE=/var/lib/bossmox/setup.code
if [ ! -f "$HASH" ] || [ ! -f "$CODE_FILE" ]; then
  RAW=$(openssl rand -hex 6 | tr 'a-f' 'A-F')
  printf '%s' "$RAW" | sha256sum | cut -d' ' -f1 > "$HASH"
  printf '%s' "$RAW" > "$CODE_FILE"
  chown bossmox:bossmox "$HASH" "$CODE_FILE"
  chmod 640 "$HASH"
  chmod 600 "$CODE_FILE"
fi
EOF
chmod 755 /usr/local/sbin/bossmox-setup-code
rm -f /etc/periodic/15min/bossmox-setup-code

# What the VM's console shows, like a hypervisor's status screen. It takes the place of a login prompt on
# the screen and the serial port, and redraws so it's there whenever someone attaches.
cat > /usr/local/sbin/bossmox-console <<'EOF'
#!/bin/sh
trap '' INT QUIT TSTP
# Read from across a room or in a small window, so the screen gets a big font and BossMox's teal.
# The serial port keeps its own font and shows the nearest standard colour.
if [ "$(tty)" = /dev/tty1 ]; then
  setfont /usr/share/consolefonts/solar24x32.psfu.gz 2>/dev/null
  printf '\033]P60E7EA6'
fi
COLS=$(stty size 2>/dev/null | cut -d' ' -f2)
[ -n "$COLS" ] && [ "$COLS" -gt 0 ] || COLS=80
BAND='\033[0;1;97;46m'
PLAIN='\033[0m'
BRIGHT='\033[1;97m'
CODE='\033[1;93m'
GOOD='\033[1;92m'
BAD='\033[1;91m'
DIM='\033[0;37m'
EOL='\033[K'
printf '\033[2J'
while :; do
  ADDR=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  # Drawn over the old screen rather than clearing it, so it doesn't flicker every few seconds.
  printf '\033[H'
  printf "$BAND"; printf '%*s\n' "$COLS" ''
  printf "$BAND"; printf '%-*s\n' "$COLS" '  BossMox'
  printf "$BAND"; printf '%-*s\n' "$COLS" '  Management app for Proxmox Virtual Environment'
  printf "$BAND"; printf '%*s\n' "$COLS" ''
  printf "$PLAIN$EOL\n$EOL\n"
  if [ -z "$ADDR" ]; then
    printf "  ${BRIGHT}Waiting for a network address.$PLAIN$EOL\n$EOL\n$EOL\n$EOL\n"
  elif [ -f /var/lib/bossmox/setup.hash ] && [ -f /var/lib/bossmox/setup.code ]; then
    CODE_TEXT=$(sed 's/..../&-/g; s/-$//' /var/lib/bossmox/setup.code)
    printf "  ${BRIGHT}Ready to set up$PLAIN$EOL\n$EOL\n"
    printf "  Open         ${BRIGHT}https://%s$PLAIN$EOL\n" "$ADDR"
    printf "  Setup code   ${CODE}%s$PLAIN$EOL\n" "$CODE_TEXT"
  else
    if rc-service bossmox status >/dev/null 2>&1; then STATE="${GOOD}Running"; else STATE="${BAD}Not running"; fi
    printf "  ${BRIGHT}BossMox is set up$PLAIN$EOL\n$EOL\n"
    printf "  Manage at    ${BRIGHT}https://%s$PLAIN$EOL\n" "$ADDR"
    printf "  Status       $STATE$PLAIN$EOL\n"
    [ ! -f /opt/bossmox/VERSION ] || printf "  Version      %s$EOL\n" "$(cat /opt/bossmox/VERSION)"
  fi
  printf "$EOL\n$EOL\n$EOL\n  ${DIM}Press L to log in to this machine$PLAIN$EOL\n\033[J"
  KEY=""
  read -r -s -n 1 -t 5 KEY 2>/dev/null || true
  case "$KEY" in
    l|L) printf '\033[0m\033[2J\033[H'; /bin/login; printf '\033[2J' ;;
  esac
done
EOF
chmod 755 /usr/local/sbin/bossmox-console
sed -i '/^tty[0-9]*::/d; /^ttyS0::/d' /etc/inittab
printf 'tty1::respawn:/usr/local/sbin/bossmox-console\nttyS0::respawn:/usr/local/sbin/bossmox-console\n' >> /etc/inittab
sed -i '/^# BossMox setup/,/^# end BossMox setup/d' /etc/issue
kill -HUP 1
pkill -f getty 2>/dev/null || true
# The screen is a loop that started at boot, so after an update it would keep showing the old one.
pkill -f /usr/local/sbin/bossmox-console 2>/dev/null || true
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
