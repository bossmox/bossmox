#!/bin/sh
# Run as root inside the BossMox VM by update-bossmox.sh. Expects bossmox.tgz and install-in-alpine.sh next to this script.
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

# The settings file and the service script go back with the app, so a failed update leaves everything as it was (#47).
put_back() {
  rc-service bossmox stop || true
  rm -rf /opt/bossmox
  mv "$OLD" /opt/bossmox
  [ ! -f "$OLD.env" ] || cp -a "$OLD.env" /etc/bossmox/env
  [ ! -f "$OLD.init" ] || cp -a "$OLD.init" /etc/init.d/bossmox
  rm -f "$OLD.env" "$OLD.init"
  rc-service bossmox start || true
  finish "$1"
}

# How it listens, which may have been changed by hand in the settings file: the port, the address, and HTTPS only
# when it has its own certificate. Plain HTTP behind a proxy is checked over plain HTTP (#72).
LISTEN=$( (. /etc/bossmox/env 2>/dev/null; echo "${PORT:-443} ${HOST:-127.0.0.1} $([ -n "${TLS_CERT_FILE:-}" ] && [ -n "${TLS_KEY_FILE:-}" ] && echo https || echo http)") )
answers() {
  LISTEN=$LISTEN node -e '
    const [port, host, scheme] = process.env.LISTEN.split(" ");
    // Listening on every address means the loopback one answers too.
    const to = ["0.0.0.0", "::", "[::]"].includes(host) ? "127.0.0.1" : host.replace(/^\[|\]$/g, "");
    require(scheme).get({ host: to, port: Number(port), path: "/", headers: { Host: "localhost" }, rejectUnauthorized: false, timeout: 4000 }, (r) => process.exit(r.statusCode === 200 ? 0 : 1))
      .on("error", () => process.exit(1)).on("timeout", () => process.exit(1));
  '
}

# A VM set up by the development script keeps its Proxmox details in this file, and installing would wipe them.
if grep -q '^export PVE_URL=' /etc/bossmox/env; then finish "this VM was set up by a script, so update it the same way."; fi

ADDRESS=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$ADDRESS" ] || finish "the VM has no network address."

rm -rf "$OLD" "$OLD.env" "$OLD.init"
cp -a /opt/bossmox "$OLD" || finish "there wasn't room to keep the old version."
cp -a /etc/bossmox/env "$OLD.env" || finish "couldn't keep a copy of /etc/bossmox/env."
[ ! -f /etc/init.d/bossmox ] || cp -a /etc/init.d/bossmox "$OLD.init" || finish "couldn't keep a copy of the service script."
# Stopped first, so it isn't crash-looping over missing files while the packages update.
rc-service bossmox stop
find /opt/bossmox -mindepth 1 -delete

sh "$STAGE/install-in-alpine.sh" "$ADDRESS" "" "" || put_back "the new version didn't install."

for i in $(seq 1 30); do
  if answers; then
    rm -rf "$OLD" "$OLD.env" "$OLD.init"
    finish ok
  fi
  sleep 1
done
put_back "the new version didn't start."
