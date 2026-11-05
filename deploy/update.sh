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
tar -czf /tmp/bossmox.tgz dist/src public deploy package.json
scp -q /tmp/bossmox.tgz deploy/install-in-lxc.sh "$HOST:/tmp/"
rm -f /tmp/bossmox.tgz
ssh -o BatchMode=yes "$HOST" "pct push $CT /tmp/bossmox.tgz /tmp/bossmox.tgz \
  && pct push $CT /etc/pve/pve-root-ca.pem /tmp/pve-root-ca.pem \
  && pct push $CT /tmp/install-in-lxc.sh /tmp/install-in-lxc.sh \
  && rm /tmp/bossmox.tgz /tmp/install-in-lxc.sh \
  && pct exec $CT -- bash /tmp/install-in-lxc.sh $ADDRESS $PVE_URL $TLS_NAME \
  && pct exec $CT -- rm /tmp/install-in-lxc.sh \
  && pct exec $CT -- systemctl is-active bossmox"
