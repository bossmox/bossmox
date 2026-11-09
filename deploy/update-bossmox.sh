#!/usr/bin/env bash
# Updates the BossMox VM on this Proxmox node. Run as root on the node holding that VM. One line, which downloads
# the latest release:  bash -c "$(curl -fsSL https://github.com/bossmox/bossmox/releases/latest/download/update-bossmox.sh)"
# Or with bossmox.tgz copied next to this script, which is used instead.
# Settings, the certificate and the setup all stay. If the new version doesn't start, the old one goes back.
#
# Usage: update-bossmox.sh [options]
#   --vmid N   The BossMox VM. Default: the VM called bossmox.
#   --yes      Don't ask before updating.
set -euo pipefail

VMID=""
YES=""
STAGE=/var/tmp/bossmox-update
CHUNK=700k # Proxmox accepts 1 MiB at a time.
UPDATE_WAIT=300

die() { echo "BossMox update stopped: $*" >&2; exit 1; }
needs_value() { [ $# -ge 2 ] || die "$1 needs a value."; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vmid) needs_value "$@"; VMID=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    *) die "I don't know the option $1." ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run this as root on a Proxmox node."
command -v qm >/dev/null || die "this isn't a Proxmox node."
# Where this script sits, only when it was run as a file. Run as a one-liner (bash -c "$(curl ...)") there's no
# file, so HERE stays empty and the package is always downloaded: a bossmox.tgz that happens to be in the current
# folder is never used (pre-public review 2026-11-09). BASH_SOURCE, not $0: with options, bash -c sets $0 to "--".
SCRIPT=${BASH_SOURCE[0]:-}
HERE=""
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ]; then HERE=$(cd "$(dirname -- "$SCRIPT")" && pwd); fi
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

if [ -z "$VMID" ]; then
  FOUND=$(qm list | awk 'NR>1 && $2=="bossmox" {print $1}')
  [ -n "$FOUND" ] || die "there's no VM called bossmox on this node. Use --vmid."
  [ "$(echo "$FOUND" | wc -l)" = 1 ] || die "more than one VM is called bossmox here. Use --vmid."
  VMID=$FOUND
fi
case "$VMID" in *[!0-9]*) die "--vmid needs a number." ;; esac
qm status "$VMID" 2>/dev/null | grep -q running || die "VM $VMID isn't running."
qm guest cmd "$VMID" ping >/dev/null 2>&1 || die "VM $VMID's guest agent isn't answering."

# Runs a command in the VM and prints what it wrote, failing when the command does.
parse='import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
sys.stdout.write(d.get("out-data", ""))
sys.exit(d.get("exitcode", 1))'
in_vm() { qm guest exec "$VMID" --timeout 60 -- "$@" 2>/dev/null | python3 -c "$parse"; }

in_vm test -f /etc/bossmox/env || die "VM $VMID doesn't look like BossMox."
OLD_VERSION=$(in_vm cat /opt/bossmox/VERSION 2>/dev/null || true)
NEW_VERSION=$(tar -xzOf "$HERE/bossmox.tgz" VERSION 2>/dev/null || true)
[ -n "$NEW_VERSION" ] || die "bossmox.tgz has no version in it."
[ "$OLD_VERSION" != "$NEW_VERSION" ] || { echo "VM $VMID is already on $NEW_VERSION."; exit 0; }

echo
echo "BossMox will update VM $VMID:"
echo "  From       ${OLD_VERSION:-an earlier version}"
echo "  To         $NEW_VERSION"
echo "Everyone using it is signed out when it restarts. Settings stay."
if [ -z "$YES" ]; then
  printf "Carry on? [y/N] "
  read -r ANSWER || ANSWER=""
  case "$ANSWER" in y|Y|yes) ;; *) echo "Nothing changed."; exit 0 ;; esac
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ -z "$PKG" ] || rm -rf "$PKG"' EXIT
tar -xzf "$HERE/bossmox.tgz" -C "$WORK" deploy/install-in-alpine.sh deploy/update-in-alpine.sh

echo "Copying it to the VM."
in_vm sh -c "rm -rf $STAGE && mkdir -m 700 $STAGE" >/dev/null || die "couldn't make a working folder in the VM."
send() {
  split -b "$CHUNK" "$1" "$WORK/part."
  for part in "$WORK"/part.*; do
    qm guest exec "$VMID" --timeout 60 --pass-stdin 1 -- sh -c "cat >> $STAGE/$2" < "$part" >/dev/null 2>&1 || die "couldn't copy $2 to the VM."
  done
  rm -f "$WORK"/part.*
  WANT=$(sha256sum "$1" | awk '{print $1}')
  GOT=$(in_vm sha256sum "$STAGE/$2" | awk '{print $1}') || GOT=""
  [ "$WANT" = "$GOT" ] || die "$2 didn't arrive intact."
}
send "$HERE/bossmox.tgz" bossmox.tgz
send "$WORK/deploy/install-in-alpine.sh" install-in-alpine.sh
send "$WORK/deploy/update-in-alpine.sh" update-in-alpine.sh

echo "Updating. This can take a few minutes."
qm guest exec "$VMID" --timeout 0 -- sh "$STAGE/update-in-alpine.sh" >/dev/null 2>&1 || die "couldn't start the update in the VM."

RESULT=""
for _ in $(seq 1 $((UPDATE_WAIT / 3))); do
  sleep 3
  # The agent can drop out if Alpine updates it, and that's not a failure.
  RESULT=$(in_vm cat "$STAGE/result" 2>/dev/null || true)
  [ -z "$RESULT" ] || break
done
[ -n "$RESULT" ] || die "it didn't finish in $((UPDATE_WAIT / 60)) minutes. Its log is $STAGE/update.log in the VM."

if [ "$RESULT" = ok ]; then
  in_vm rm -rf "$STAGE" >/dev/null || true
  echo
  echo "BossMox is updated to $NEW_VERSION."
  exit 0
fi
die "$RESULT Its log is $STAGE/update.log in the VM."
