#!/usr/bin/env bash
# Run from the repo on a development machine. Installs the current code into the Alpine VM.
# Usage: deploy/update-alpine.sh alpine@<vm address> <ca file> <address people use> <proxmox url[,url]> [certificate name]
set -euo pipefail

VM=$1
CA=$2
ADDRESS=$3
PVE_URL=$4
TLS_NAME=${5:-}

npm test >/dev/null
TMPFILE=$(mktemp -d)
tar -czf "$TMPFILE/bossmox.tgz" dist/src public deploy package.json node_modules/ws
cp "$CA" "$TMPFILE/pve-root-ca.pem"
scp -q "$TMPFILE/bossmox.tgz" "$TMPFILE/pve-root-ca.pem" deploy/install-in-alpine.sh "$VM:/tmp/"
rm -rf "$TMPFILE"
ssh -o BatchMode=yes "$VM" "doas sh /tmp/install-in-alpine.sh $ADDRESS $PVE_URL $TLS_NAME && rm -f /tmp/install-in-alpine.sh && doas rc-service bossmox status"
