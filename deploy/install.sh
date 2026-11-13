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
#   --ip A.B.C.D/NN   Fixed address. Needs --gateway. Default: asks when run by hand, DHCP when not.
#   --gateway A.B.C.D Gateway for --ip.
#   --yes             Don't ask before creating the VM.
set -euo pipefail

# The same text as the top of this file. Kept here because run as a one-liner there's no file to read it from (#76).
usage() {
  cat <<'USAGE'
BossMox: management app for Proxmox Virtual Environment. Not affiliated with Proxmox.

Run as root on a Proxmox node. Creates one small VM running BossMox and changes nothing else on the node.
Options go after the one-liner as: bash -c "$(curl ...)" -- --ip 192.168.1.20/24 --gateway 192.168.1.1

Usage: install.sh [options]
  --vmid N          VM ID. Default: the next free one.
  --storage NAME    Where its disk goes. Default: the storage with the most free space that holds VM disks.
  --bridge NAME     Network bridge. Default: vmbr0.
  --vlan N          VLAN tag. Default: none.
  --ip A.B.C.D/NN   Fixed address. Needs --gateway. Default: asks when run by hand, DHCP when not.
  --gateway A.B.C.D Gateway for --ip.
  --yes             Don't ask before creating the VM.
USAGE
}

# Where this script sits, only when it was run as a file. Run as a one-liner (bash -c "$(curl ...)") there's no
# file, so HERE stays empty and the package is always downloaded: a bossmox.tgz that happens to be in the current
# folder is never used (pre-public review 2026-11-09). BASH_SOURCE, not $0: with options, bash -c sets $0 to "--".
SCRIPT=${BASH_SOURCE[0]:-}
HERE=""
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ]; then HERE=$(cd "$(dirname -- "$SCRIPT")" && pwd); fi
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
    -h|--help) usage; exit 0 ;;
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
if [ -z "$HERE" ] || [ ! -f "$HERE/bossmox.tgz" ]; then
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
ip2int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
valid_ip() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local n; for n in "${BASH_REMATCH[@]:1}"; do [ "$n" -le 255 ] || return 1; done
}
same_network() { # address prefix gateway
  local mask=$(( (0xFFFFFFFF << (32 - $2)) & 0xFFFFFFFF ))
  [ $(( $(ip2int "$1") & mask )) -eq $(( $(ip2int "$3") & mask )) ]
}
# All of --ip checked before anything is built: an address without its /NN used to fail only after the VM existed (#76).
if [ -n "$ADDRESS" ]; then
  [[ "$ADDRESS" =~ ^([0-9.]+)/([0-9]+)$ ]] || die "--ip needs the network size too, like 192.168.1.20/24."
  A=${BASH_REMATCH[1]}; P=${BASH_REMATCH[2]}
  valid_ip "$A" && [ "$P" -ge 8 ] && [ "$P" -le 30 ] || die "--ip $ADDRESS isn't a valid address."
  valid_ip "$GATEWAY" || die "--gateway $GATEWAY isn't a valid address."
  same_network "$A" "$P" "$GATEWAY" || die "--gateway $GATEWAY isn't on the same network as $ADDRESS."
fi
[ -d "/sys/class/net/$BRIDGE" ] || die "there's no network bridge called $BRIDGE. Pick one with --bridge."

# BossMox's own address (ADR 0023). Run by hand without --ip, it asks: an automatic address can change after a
# restart, which breaks the bookmark and the certificate. Scripts, --yes and --ip behave as before.
if [ -z "$ADDRESS" ] && [ "$ASSUME_YES" != 1 ] && [ -t 0 ]; then
  HOST_NET=$(ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | awk '{print $4; exit}')
  NODE_IP=${HOST_NET%/*}
  # Without a VLAN, BossMox sits on the node's own network, so its size and gateway are the sensible defaults.
  PREFIX_GUESS=""
  GW_GUESS=""
  if [ -z "$VLAN" ] && [ -n "$HOST_NET" ]; then
    PREFIX_GUESS=${HOST_NET#*/}
    GW_GUESS=$(ip -4 route show default dev "$BRIDGE" 2>/dev/null | awk '{print $3; exit}')
  fi
  echo
  echo "BossMox needs its own address on your network."
  echo "  A fixed address stays the same, so your bookmark keeps working. Recommended."
  echo "  An automatic one comes from your router and can change after a restart."
  [ -z "$NODE_IP" ] || echo "  This node is $NODE_IP. Pick an address on the same network that nothing else uses."
  for _ in 1 2 3 4 5; do
    read -r -p "Fixed address for BossMox (like 192.168.1.20), or press Enter for automatic: " IN || IN=""
    [ -n "$IN" ] || break
    A=${IN%/*}
    P=${PREFIX_GUESS:-24}
    [ "$A" = "$IN" ] || P=${IN#*/}
    if ! valid_ip "$A" || ! [[ "$P" =~ ^[0-9]+$ ]] || [ "$P" -lt 8 ] || [ "$P" -gt 30 ]; then echo "  That isn't an address. Type four numbers like 192.168.1.20."; continue; fi
    if [ "$A" = "$NODE_IP" ]; then echo "  That's this node's own address. Pick a different one."; continue; fi
    if ping -c 1 -W 1 "$A" >/dev/null 2>&1; then echo "  Something on your network already answers at $A. Pick a different one."; continue; fi
    while :; do
      read -r -p "Gateway (your router)${GW_GUESS:+ [$GW_GUESS]}: " G || G=""
      G=${G:-$GW_GUESS}
      if ! valid_ip "$G"; then echo "  That isn't an address. Type four numbers like 192.168.1.1."; continue; fi
      if ! same_network "$A" "$P" "$G"; then echo "  $G isn't on the same network as $A/$P. Check both."; G=""; fi
      break
    done
    [ -n "$G" ] || continue
    ADDRESS="$A/$P"
    GATEWAY="$G"
    break
  done
  [ -n "$ADDRESS" ] || [ -z "$IN" ] || die "no usable address after five tries. Run it again, or use --ip and --gateway."
fi

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
echo "  Network    $BRIDGE${VLAN:+, VLAN $VLAN}, ${ADDRESS:-address from DHCP}${GATEWAY:+, gateway $GATEWAY}"
echo "Nothing else on this node changes. To remove it later: qm destroy $VMID --purge 1"
echo
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Go ahead? [y/N] " ANSWER
  [[ "$ANSWER" =~ ^[Yy] ]] || { echo "Stopped. Nothing was changed."; exit 0; }
fi

WORK=$(mktemp -d /var/tmp/bossmox.XXXXXX)
MOUNT=""
LOOP=""
# Set from creating the VM until it starts. A step that fails in between leaves a VM with no disk, so it goes (#58).
CREATED=""
cleanup() {
  [ -z "$MOUNT" ] || umount "$MOUNT" 2>/dev/null || true
  [ -z "$LOOP" ] || losetup -d "$LOOP" 2>/dev/null || true
  rm -rf "$WORK"
  [ -z "$PKG" ] || rm -rf "$PKG"
  if [ -n "$CREATED" ]; then
    echo "Removing the unfinished VM $CREATED." >&2
    qm destroy "$CREATED" --purge >/dev/null 2>&1 || echo "Couldn't remove VM $CREATED. Remove it in Proxmox." >&2
  fi
}
trap cleanup EXIT
# Runs one qm step quietly, and on failure stops with what Proxmox said instead of exiting without a word (#58).
qm_step() {
  local what=$1 out
  shift
  if ! out=$("$@" 2>&1 >/dev/null); then die "$what failed: ${out:-Proxmox gave no reason}"; fi
}

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
qm_step "Creating VM $VMID" qm create "$VMID" --name bossmox --cores 1 --cpuunits 50 --memory 256 --balloon 0 \
  --net0 "$NET" --scsihw virtio-scsi-single --ostype l26 --onboot 1 --agent 1 \
  --serial0 socket --tablet 0 --description "BossMox: management app for Proxmox Virtual Environment"
CREATED=$VMID
qm_step "Importing the disk onto $STORAGE" qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$WORK/img.qcow2,iothread=1"
qm_step "Adding the cloud-init drive" qm set "$VMID" --ide2 "$STORAGE:cloudinit" --boot order=scsi0
qm_step "Growing the disk" qm resize "$VMID" scsi0 1G
qm_step "Setting the network" qm set "$VMID" --ciuser alpine --ipconfig0 "ip=${ADDRESS:-dhcp}${GATEWAY:+,gw=$GATEWAY}"
qm_step "Starting VM $VMID" qm start "$VMID"
# From here the VM is kept: the first boot can be slow, and its console shows what it's doing.
CREATED=""

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
