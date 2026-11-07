#!/usr/bin/env bash
# Run from the repo on a development machine. Installs the current code into the Alpine VM.
# Usage: deploy/update-alpine.sh alpine@<vm address> <ca file> <address people use> <proxmox url[,url]> [certificate name]
set -euo pipefail

VM=$1
CA=$2
ADDRESS=$3
PVE_URL=${4:-}
TLS_NAME=${5:-}

npm test >/dev/null
TMPFILE=$(mktemp -d)
echo "dev-$(git rev-parse --short HEAD)" > "$TMPFILE/VERSION"
tar -czf "$TMPFILE/bossmox.tgz" dist/src public deploy package.json node_modules/ws -C "$TMPFILE" VERSION
rm "$TMPFILE/VERSION"
[ "$CA" = "-" ] || cp "$CA" "$TMPFILE/pve-root-ca.pem"
# A private folder, because these run as root and /tmp is shared with the service account.
STAGE=$(ssh -o BatchMode=yes "$VM" "mktemp -d")
trap 'ssh -o BatchMode=yes "$VM" "rm -rf \"$STAGE\"" 2>/dev/null || true' EXIT
scp -q "$TMPFILE"/* deploy/install-in-alpine.sh "$VM:$STAGE/"
rm -rf "$TMPFILE"
ssh -o BatchMode=yes "$VM" "doas sh '$STAGE/install-in-alpine.sh' '$ADDRESS' '$PVE_URL' '$TLS_NAME' && doas rc-service bossmox status"
