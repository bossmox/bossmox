#!/usr/bin/env bash
# Run from the repo on a development machine. Installs the current code into the container.
# Usage: deploy/update.sh root@<proxmox host> <ctid> <address people use> <proxmox url> [certificate name]
set -euo pipefail

HOST=$1
CT=$2
ADDRESS=$3
PVE_URL=$4
TLS_NAME=${5:-}

npm test >/dev/null
TMPFILE=$(mktemp -d)
trap 'rm -rf "$TMPFILE"' EXIT
tar -czf "$TMPFILE/bossmox.tgz" dist/src public deploy package.json node_modules/ws
# Private folders on the node and in the container, which only root can reach. A shared /tmp could let the
# container's bossmox account swap a file between it arriving and root running it (pre-public review 2026-11-09).
REMOTE=$(ssh -o BatchMode=yes "$HOST" 'mktemp -d /root/bossmox-stage.XXXXXX')
scp -q "$TMPFILE/bossmox.tgz" deploy/install-in-lxc.sh "$HOST:$REMOTE/"
ssh -o BatchMode=yes "$HOST" "STAGE=\$(pct exec $CT -- mktemp -d /root/bossmox-stage.XXXXXX) \
  && pct push $CT $REMOTE/bossmox.tgz \$STAGE/bossmox.tgz \
  && pct push $CT /etc/pve/pve-root-ca.pem \$STAGE/pve-root-ca.pem \
  && pct push $CT $REMOTE/install-in-lxc.sh \$STAGE/install-in-lxc.sh \
  && rm -rf $REMOTE \
  && pct exec $CT -- bash \$STAGE/install-in-lxc.sh '$ADDRESS' '$PVE_URL' '$TLS_NAME'; R=\$?; \
  pct exec $CT -- rm -rf \$STAGE; [ \$R = 0 ] && pct exec $CT -- systemctl is-active bossmox"
