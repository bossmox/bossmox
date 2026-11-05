#!/usr/bin/env bash
# Run on a Proxmox host. Creates a small unprivileged container for BossMox.
# Usage: create-lxc.sh <ctid> <ip/cidr> <gateway> [storage] [bridge] [nameserver]
# The nameserver defaults to the gateway.
set -euo pipefail

CTID=$1
ADDRESS=$2
GATEWAY=$3
STORAGE=${4:-local-lvm}
BRIDGE=${5:-vmbr0}
NAMESERVER=${6:-$GATEWAY}
IP=${ADDRESS%/*}

if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then
  echo "ID $CTID is already in use." >&2
  exit 1
fi
if ping -c 2 -W 1 "$IP" >/dev/null 2>&1; then
  echo "$IP already answers on the network." >&2
  exit 1
fi

pveam update >/dev/null 2>&1 || true
TEMPLATE=$(pveam list local | awk '{print $1}' | sed 's#^local:vztmpl/##' | grep -E '^debian-13-standard' | sort -V | tail -1 || true)
if [ -z "$TEMPLATE" ]; then
  TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-13-standard' | sort -V | tail -1)
  pveam download local "$TEMPLATE" >/dev/null
fi
pveam list local | grep -q "$TEMPLATE" || { echo "The Debian 13 template didn't download." >&2; exit 1; }

pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname bossmox \
  --unprivileged 1 \
  --features nesting=1 \
  --cores 1 --cpuunits 50 \
  --memory 512 --swap 256 \
  --rootfs "$STORAGE:4" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$ADDRESS,gw=$GATEWAY" \
  --nameserver "$NAMESERVER" \
  --onboot 1 --startup order=2 \
  --description "BossMox: management app for Proxmox Virtual Environment"
pct start "$CTID"
echo "Container $CTID started from $TEMPLATE"
