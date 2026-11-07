#!/bin/sh
# Run as root inside the BossMox VM by update.sh. Expects bossmox.tgz and install-in-alpine.sh next to this script.
# Writes one line to `result`: "ok", or the reason it put the old version back.
set -u

STAGE=$(dirname "$0")
OLD=/opt/bossmox.prev
exec > "$STAGE/update.log" 2>&1

finish() {
  printf '%s\n' "$1" > "$STAGE/result.new"
  mv "$STAGE/result.new" "$STAGE/result"
  exit 0
}

put_back() {
  rc-service bossmox stop || true
  rm -rf /opt/bossmox
  mv "$OLD" /opt/bossmox
  rc-service bossmox start || true
  finish "$1"
}

answers() {
  node -e '
    require("https").get({ host: "127.0.0.1", port: 443, path: "/", rejectUnauthorized: false, timeout: 4000 }, (r) => process.exit(r.statusCode === 200 ? 0 : 1))
      .on("error", () => process.exit(1)).on("timeout", () => process.exit(1));
  '
}

# A VM set up by the development script keeps its Proxmox details in this file, and installing would wipe them.
if grep -q '^export PVE_URL=' /etc/bossmox/env; then finish "this VM was set up by a script, so update it the same way."; fi

ADDRESS=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$ADDRESS" ] || finish "the VM has no network address."

rm -rf "$OLD"
cp -a /opt/bossmox "$OLD" || finish "there wasn't room to keep the old version."
# Stopped first, so it isn't crash-looping over missing files while the packages update.
rc-service bossmox stop
find /opt/bossmox -mindepth 1 -delete

sh "$STAGE/install-in-alpine.sh" "$ADDRESS" "" "" || put_back "the new version didn't install."

for i in $(seq 1 30); do
  if answers; then
    rm -rf "$OLD"
    finish ok
  fi
  sleep 1
done
put_back "the new version didn't start."
