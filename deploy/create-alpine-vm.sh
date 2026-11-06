#!/usr/bin/env bash
# Run on a Proxmox host. Creates a small Alpine VM for BossMox. A VM can move between
# servers while it runs, so BossMox stays online and people stay signed in.
# Usage: create-alpine-vm.sh <vmid> <ip/cidr> <gateway> [storage] [bridge]
# Log in as the alpine user with the host's root SSH keys. Then set /etc/resolv.conf,
# because the cloud image doesn't write one, and run install-in-alpine.sh.
set -euo pipefail

VM=$1
ADDRESS=$2
GATEWAY=$3
STORAGE=${4:-local}
BRIDGE=${5:-vmbr0}
BASE=https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/cloud

IMG=$(curl -fsSL "$BASE/" | grep -oE 'generic_alpine-[0-9.]+-x86_64-bios-cloudinit-r[0-9]+\.qcow2' | sort -uV | tail -1)
WORK=$(mktemp -d /var/tmp/bossmox.XXXXXX)
curl -fsSL -o "$WORK/img.qcow2" "$BASE/$IMG"
WANT=$(curl -fsSL "$BASE/$IMG.sha512" | awk '{print $1}')
GOT=$(sha512sum "$WORK/img.qcow2" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || { echo "The Alpine image failed its checksum." >&2; exit 1; }

qm create "$VM" --name bossmox --cores 1 --cpuunits 50 --memory 256 --balloon 0 \
  --net0 "virtio,bridge=$BRIDGE" --scsihw virtio-scsi-single --ostype l26 --onboot 1 \
  --serial0 socket --vga serial0 --description "BossMox: management app for Proxmox Virtual Environment"
qm set "$VM" --scsi0 "$STORAGE:0,import-from=$WORK/img.qcow2,iothread=1" >/dev/null
qm set "$VM" --ide2 "$STORAGE:cloudinit" --boot order=scsi0 >/dev/null
qm resize "$VM" scsi0 1G >/dev/null
qm set "$VM" --ciuser alpine --sshkeys /root/.ssh/authorized_keys --ipconfig0 "ip=$ADDRESS,gw=$GATEWAY" --nameserver "$GATEWAY" >/dev/null
qm start "$VM"
rm -rf "$WORK"
echo "VM $VM started from $IMG"
