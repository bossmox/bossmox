#!/usr/bin/env bash
# BossMox: management app for Proxmox Virtual Environment. Not affiliated with Proxmox.
#
# Run as root on a Proxmox node. Creates one small VM running BossMox and changes nothing else on the node.
# One line, which downloads the latest release:
#   bash -c "$(curl -fsSL https://github.com/bossmox/bossmox/releases/latest/download/install.sh)"
# Options go after it as: bash -c "$(curl ...)" -- --ip 192.168.1.20/24 --gateway 192.168.1.1
#
# Usage: install.sh [options]
#   --vmid N          VM ID. Default: the next free one.
#   --storage NAME    Where its disk goes. Default: the storage with the most free space that holds VM disks.
#   --bridge NAME     Network bridge. Default: vmbr0.
#   --vlan N          VLAN tag. Default: none.
#   --ip A.B.C.D/NN   Fixed address. Needs --gateway. Default: DHCP.
#   --gateway A.B.C.D Gateway for --ip.
#   --yes             Don't ask before creating the VM.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)
ALPINE=https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/cloud
VMID=""
STORAGE=""
BRIDGE=vmbr0
VLAN=""
ADDRESS=""
GATEWAY=""
ASSUME_YES=0

die() {
  echo "BossMox install stopped: $*" >&2
  exit 1
}
needs_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value."
}
while [ $# -gt 0 ]; do
  case "$1" in
    --vmid) needs_value "$@"; VMID=$2; shift 2 ;;
    --storage) needs_value "$@"; STORAGE=$2; shift 2 ;;
    --bridge) needs_value "$@"; BRIDGE=$2; shift 2 ;;
    --vlan) needs_value "$@"; VLAN=$2; shift 2 ;;
    --ip) needs_value "$@"; ADDRESS=$2; shift 2 ;;
    --gateway) needs_value "$@"; GATEWAY=$2; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "I don't know the option $1. Try --help." ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run this as root."
command -v qm >/dev/null && command -v pvesm >/dev/null || die "this isn't a Proxmox node."
# The package: beside this script when copied by hand, otherwise the latest release from GitHub, so the whole
# thing can run as one line. A download has to pass its checksum; one copied by hand is checked when it has one.
RELEASE_URL=${BOSSMOX_RELEASE_URL:-https://github.com/bossmox/bossmox/releases/latest/download}
PKG=""
trap '[ -z "$PKG" ] || rm -rf "$PKG"' EXIT
if [ ! -f "$HERE/bossmox.tgz" ]; then
  echo "Downloading BossMox."
  PKG=$(mktemp -d /var/tmp/bossmox-pkg.XXXXXX)
  curl -fsSL -o "$PKG/bossmox.tgz" "$RELEASE_URL/bossmox.tgz" && curl -fsSL -o "$PKG/bossmox.tgz.sha256" "$RELEASE_URL/bossmox.tgz.sha256" \
    || die "couldn't download BossMox. Check this node can reach github.com."
  HERE=$PKG
fi
if [ -f "$HERE/bossmox.tgz.sha256" ]; then
  (cd "$HERE" && sha256sum --quiet -c bossmox.tgz.sha256) || die "bossmox.tgz failed its checksum."
elif [ -n "$PKG" ]; then
  die "the download came without its checksum, so it wasn't used."
fi
[ -z "$ADDRESS" ] || [ -n "$GATEWAY" ] || die "--ip needs --gateway too."
[[ "$VLAN" =~ ^[0-9]*$ ]] || die "--vlan has to be a number."
[[ "$ADDRESS" =~ ^[0-9./]*$ ]] && [[ "$GATEWAY" =~ ^[0-9.]*$ ]] || die "that address isn't valid."
[ -d "/sys/class/net/$BRIDGE" ] || die "there's no network bridge called $BRIDGE. Pick one with --bridge."

[ -n "$VMID" ] || VMID=$(pvesh get /cluster/nextid)
[[ "$VMID" =~ ^[0-9]+$ ]] || die "--vmid has to be a number."
if qm status "$VMID" >/dev/null 2>&1 || pct status "$VMID" >/dev/null 2>&1; then die "ID $VMID is already in use."; fi

if [ -z "$STORAGE" ]; then
  STORAGE=$(pvesm status --content images --enabled 1 2>/dev/null | awk 'NR>1 && $3=="active" {print $6, $1}' | sort -rn | awk 'NR==1 {print $2}')
  [ -n "$STORAGE" ] || die "no storage here holds VM disks. Pick one with --storage."
fi
pvesm status --storage "$STORAGE" >/dev/null 2>&1 || die "there's no storage called $STORAGE."

echo
echo "BossMox will create one VM on $(hostname):"
echo "  VM ID      $VMID, named bossmox"
echo "  Size       1 core, 256 MB memory, 1 GB disk"
echo "  Storage    $STORAGE"
echo "  Network    $BRIDGE${VLAN:+, VLAN $VLAN}, ${ADDRESS:-address from DHCP}"
echo "Nothing else on this node changes. To remove it later: qm destroy $VMID --purge 1"
echo
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Go ahead? [y/N] " ANSWER
  [[ "$ANSWER" =~ ^[Yy] ]] || { echo "Stopped. Nothing was changed."; exit 0; }
fi

WORK=$(mktemp -d /var/tmp/bossmox.XXXXXX)
MOUNT=""
LOOP=""
cleanup() {
  [ -z "$MOUNT" ] || umount "$MOUNT" 2>/dev/null || true
  [ -z "$LOOP" ] || losetup -d "$LOOP" 2>/dev/null || true
  rm -rf "$WORK"
  [ -z "$PKG" ] || rm -rf "$PKG"
}
trap cleanup EXIT

echo "Downloading Alpine Linux."
IMG=$(curl -fsSL "$ALPINE/" | grep -oE 'generic_alpine-[0-9.]+-x86_64-bios-cloudinit-r[0-9]+\.qcow2' | sort -uV | tail -1)
[ -n "$IMG" ] || die "couldn't find the Alpine image. Check this node can reach the internet."
curl -fsSL -o "$WORK/img.qcow2" "$ALPINE/$IMG"
WANT=$(curl -fsSL "$ALPINE/$IMG.sha512" | awk '{print $1}')
[ "$WANT" = "$(sha512sum "$WORK/img.qcow2" | awk '{print $1}')" ] || die "the Alpine image failed its checksum."

# BossMox goes straight onto the disk before the VM's first boot, so the VM needs no way in from outside.
echo "Putting BossMox on the disk."
qemu-img convert -O raw "$WORK/img.qcow2" "$WORK/img.raw"
rm -f "$WORK/img.qcow2"
LOOP=$(losetup -fP --show "$WORK/img.raw")
sleep 1
PART=$(lsblk -lnpo NAME,SIZE -b "$LOOP" | awk -v d="$LOOP" '$1 != d {print $2, $1}' | sort -rn | awk 'NR==1 {print $2}')
PART=${PART:-$LOOP}
MOUNT="$WORK/mnt"
mkdir -p "$MOUNT"
mount "$PART" "$MOUNT" || { MOUNT=""; die "couldn't open the Alpine disk."; }
STAGE="$MOUNT/opt/bossmox-stage"
mkdir -p "$STAGE"
cp "$HERE/bossmox.tgz" "$STAGE/"
tar -xzf "$HERE/bossmox.tgz" -C "$STAGE" --strip-components=1 deploy/install-in-alpine.sh
awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf > "$STAGE/dns"

cat > "$MOUNT/etc/local.d/bossmox-firstboot.start" <<'EOF'
#!/bin/sh
# Runs once, on the first boot.
exec > /var/log/bossmox-firstboot.log 2>&1
STAGE=/opt/bossmox-stage
for i in $(seq 1 120); do
  ADDR=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$ADDR" ] && break
  sleep 1
done
[ -n "$ADDR" ] || { echo "no network address"; exit 1; }
# Cloud images don't always write this.
grep -q '^nameserver' /etc/resolv.conf 2>/dev/null || echo "nameserver $(cat "$STAGE/dns")" > /etc/resolv.conf
for i in $(seq 1 30); do
  apk update -q && break
  sleep 2
done
apk add -q qemu-guest-agent
rc-update add qemu-guest-agent default
rc-service qemu-guest-agent start
sh "$STAGE/install-in-alpine.sh" "$ADDR" "" "" && rm -rf "$STAGE" /etc/local.d/bossmox-firstboot.start && echo finished
EOF
chmod 755 "$MOUNT/etc/local.d/bossmox-firstboot.start"
ln -sf /etc/init.d/local "$MOUNT/etc/runlevels/default/local"

sync
umount "$MOUNT"
MOUNT=""
losetup -d "$LOOP"
LOOP=""
qemu-img convert -O qcow2 "$WORK/img.raw" "$WORK/img.qcow2"
rm -f "$WORK/img.raw"

echo "Creating VM $VMID."
NET="virtio,bridge=$BRIDGE${VLAN:+,tag=$VLAN}"
qm create "$VMID" --name bossmox --cores 1 --cpuunits 50 --memory 256 --balloon 0 \
  --net0 "$NET" --scsihw virtio-scsi-single --ostype l26 --onboot 1 --agent 1 \
  --serial0 socket --tablet 0 --description "BossMox: management app for Proxmox Virtual Environment" >/dev/null
qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$WORK/img.qcow2,iothread=1" >/dev/null 2>&1
qm set "$VMID" --ide2 "$STORAGE:cloudinit" --boot order=scsi0 >/dev/null 2>&1
qm resize "$VMID" scsi0 1G >/dev/null 2>&1
qm set "$VMID" --ciuser alpine --ipconfig0 "ip=${ADDRESS:-dhcp}${GATEWAY:+,gw=$GATEWAY}" >/dev/null
qm start "$VMID" >/dev/null

echo "Starting it. The first boot installs what BossMox needs, which takes a few minutes."
# The agent doesn't answer until partway through the first boot, and that's not a failure.
guest_file() {
  { qm guest exec "$VMID" --timeout 10 -- cat "$1" 2>/dev/null || true; } \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("out-data","").strip())
except Exception: pass'
}
LOG_TAIL=""
for _ in $(seq 1 120); do
  sleep 5
  CODE=$(guest_file /var/lib/bossmox/setup.code)
  if [ -n "$CODE" ]; then
    ADDR=$({ qm guest cmd "$VMID" network-get-interfaces 2>/dev/null || true; } | python3 -c 'import json,sys
try: found = json.load(sys.stdin)
except Exception: found = []
for i in found:
    if i.get("name") == "lo": continue
    for a in i.get("ip-addresses", []):
        if a.get("ip-address-type") == "ipv4":
            print(a["ip-address"]); raise SystemExit')
    echo
    echo "BossMox is ready."
    if [ -n "$ADDR" ]; then echo "  Open         https://$ADDR"; else echo "  Open         the address on this VM's console"; fi
    echo "  Setup code   $(echo "$CODE" | sed 's/..../&-/g; s/-$//')"
    FP=$(guest_file /etc/bossmox/tls.fingerprint | tr -cd '0-9A-F:')
    [ -z "$FP" ] || echo "  Certificate  $FP"
    echo
    echo "Your browser will warn about the certificate the first time. That's expected."
    [ -z "$FP" ] || echo "Before entering the code, open the certificate details in the browser and check its SHA-256 fingerprint matches the one above."
    exit 0
  fi
  LOG_TAIL=$(guest_file /var/log/bossmox-firstboot.log | tail -3)
done
echo
echo "BossMox hasn't finished after 10 minutes. VM $VMID is still there, so nothing is lost." >&2
[ -z "$LOG_TAIL" ] || echo "Last lines of its setup log: $LOG_TAIL" >&2
echo "Open VM $VMID's console in Proxmox to see what it's doing." >&2
exit 1
