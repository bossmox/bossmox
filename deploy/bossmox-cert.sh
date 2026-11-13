#!/bin/sh
# BossMox's own certificate authority and website certificate (ADR 0040). Installed as /usr/local/sbin/bossmox-cert.
#
# The CA lasts 20 years and can only vouch for BossMox's own addresses and names (name constraints), so the Proxmox
# nodes can trust it for alerts without trusting it for anything else. Its key stays root-only. The website
# certificate lasts 825 days and is renewed from the same CA, so the nodes never need it again.
#
# Usage: bossmox-cert <address or name>[,...]   install and update: adds these to the names already covered
#        bossmox-cert renew                      the daily job: renews when under 60 days are left, then restarts
# Prints "changed" when the website certificate was replaced.
set -eu
umask 077

D=${BOSSMOX_CERT_DIR:-/etc/bossmox}
GROUP=${BOSSMOX_CERT_GROUP:-bossmox}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

names_of_cert() {
  openssl x509 -noout -ext subjectAltName -in "$1" 2>/dev/null | tail -n +2 | sed 's/IP Address://g; s/DNS://g; s/ //g'
}

# The names to cover: the ones saved before (or, on the first run, the ones the old certificate already had), plus any new.
OLD=""
if [ -s "$D/cert-names" ]; then
  OLD=$(cat "$D/cert-names")
elif [ -s "$D/tls.crt" ]; then
  OLD=$(names_of_cert "$D/tls.crt")
fi
if [ "${1:-}" = renew ]; then
  NAMES=$OLD
else
  NAMES=$OLD
  for n in $(printf '%s' "${1:-}" | tr ',' ' '); do
    n=${n%%:[0-9]*}
    case ",$NAMES," in *",$n,"*) ;; *) NAMES="${NAMES:+$NAMES,}$n" ;; esac
  done
fi
[ -n "$NAMES" ] || { echo "bossmox-cert: no address to make a certificate for." >&2; exit 1; }

SAN=""
LIMIT=""
for n in $(printf '%s' "$NAMES" | tr ',' ' '); do
  case "$n" in
    *:*) s="IP:$n" l="IP:$n/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" ;;
    *[!0-9.]*) s="DNS:$n" l="DNS:$n" ;;
    *) s="IP:$n" l="IP:$n/255.255.255.255" ;;
  esac
  SAN="${SAN:+$SAN,}$s"
  LIMIT="${LIMIT:+$LIMIT,}permitted;$l"
done

# A new CA only when there isn't one, or it doesn't cover every name. The nodes then need it again.
if [ ! -s "$D/ca.key" ] || [ ! -s "$D/ca.crt" ] || [ "$(cat "$D/ca-names" 2>/dev/null)" != "$NAMES" ]; then
  cat > "$WORK/ca.cnf" <<EOF
[req]
distinguished_name=dn
prompt=no
[dn]
CN=BossMox CA ($(printf '%s' "$NAMES" | cut -d, -f1))
[v3]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
nameConstraints=critical,$LIMIT
EOF
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7305 \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" -config "$WORK/ca.cnf" -extensions v3 2>/dev/null
  chmod 600 "$WORK/ca.key"
  chmod 644 "$WORK/ca.crt"
  mv "$WORK/ca.key" "$D/ca.key"
  mv "$WORK/ca.crt" "$D/ca.crt"
  printf '%s' "$NAMES" > "$D/ca-names"
  chmod 644 "$D/ca-names"
fi
chown root:root "$D/ca.key"
chmod 600 "$D/ca.key"

# The website certificate: replaced when missing, not from this CA, missing a name, or under 60 days from running out.
current_ok() {
  [ -s "$D/tls.crt" ] && [ -s "$D/tls.key" ] || return 1
  openssl x509 -noout -checkend 5184000 -in "$D/tls.crt" >/dev/null 2>&1 || return 1
  for n in $(printf '%s' "$NAMES" | tr ',' ' '); do
    case "$n" in
      *:*) how=-verify_ip ;;
      *[!0-9.]*) how=-verify_hostname ;;
      *) how=-verify_ip ;;
    esac
    openssl verify -CAfile "$D/ca.crt" "$how" "$n" "$D/tls.crt" >/dev/null 2>&1 || return 1
  done
}
if current_ok; then
  printf '%s' "$NAMES" > "$D/cert-names"
  exit 0
fi
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\nauthorityKeyIdentifier=keyid\n' "$SAN" > "$WORK/leaf.ext"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$WORK/tls.key" -out "$WORK/tls.csr" -subj "/CN=BossMox" 2>/dev/null
openssl x509 -req -in "$WORK/tls.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" -CAcreateserial -CAserial "$WORK/ca.srl" -days 825 \
  -out "$WORK/tls.crt" -extfile "$WORK/leaf.ext" 2>/dev/null
chown "root:$GROUP" "$WORK/tls.key"
chmod 640 "$WORK/tls.key"
chmod 644 "$WORK/tls.crt"
mv "$WORK/tls.key" "$D/tls.key"
mv "$WORK/tls.crt" "$D/tls.crt"
printf '%s' "$NAMES" > "$D/cert-names"
chmod 644 "$D/cert-names"
openssl x509 -noout -fingerprint -sha256 -in "$D/tls.crt" | cut -d= -f2 > "$D/tls.fingerprint"
chmod 644 "$D/tls.fingerprint"
echo changed

if [ "${1:-}" = renew ]; then
  if command -v rc-service >/dev/null 2>&1; then rc-service bossmox restart >/dev/null; else systemctl restart bossmox; fi
fi
