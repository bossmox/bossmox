#!/bin/sh
# BossMox's own certificate authority and website certificate (ADR 0040). Installed as /usr/local/sbin/bossmox-cert.
#
# The CA lasts 20 years and can only vouch for BossMox's own addresses and names: name constraints cover both kinds
# of name (an IP-only BossMox gets a DNS limit that matches nothing), and it can only vouch for websites. So the
# Proxmox nodes can trust it for alerts without trusting it for anything else. Its key stays root-only. The website
# certificate lasts 825 days and is renewed from the same CA, so the nodes never need it again.
#
# Usage: bossmox-cert <address or name>[,...]   install and update: adds these to the names already covered
#        bossmox-cert renew                      the daily job: renews when under 60 days are left, then restarts
# Prints "changed" when the website certificate was replaced, and "new CA" when the nodes need it again.
set -eu
# Names come from the command line and files; none of them may expand as a file pattern.
set -f
umask 077

D=${BOSSMOX_CERT_DIR:-/etc/bossmox}
GROUP=${BOSSMOX_CERT_GROUP:-bossmox}
# Working files sit beside the real ones, so every swap below is a rename on the same disk.
WORK=$(mktemp -d "$D/.work.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# openssl's own words when it fails, instead of a silent exit.
run() {
  if ! "$@" 2> "$WORK/err"; then
    echo "bossmox-cert: $1 failed:" >&2
    cat "$WORK/err" >&2
    exit 1
  fi
}
# Written beside the target, then renamed: a full disk or a cut can't leave half a file.
put() { # put <file> <mode> <text>
  printf '%s' "$3" > "$WORK/put"
  chmod "$2" "$WORK/put"
  mv "$WORK/put" "$1"
}
# One name as typed: brackets and a port taken off. An IPv6 address keeps all its colons.
clean() {
  n=$1
  case "$n" in
    \[*\]:*) n=${n#\[}; n=${n%%\]*} ;;
    \[*\]) n=${n#\[}; n=${n%\]} ;;
    *:*:*) ;;
    *:*) n=${n%:*} ;;
  esac
  printf '%s' "$n"
}
names_of_cert() {
  openssl x509 -noout -ext subjectAltName -in "$1" 2>/dev/null | tail -n +2 | sed 's/IP Address://g; s/DNS://g; s/ //g' | tr '\n' ',' | sed 's/,*$//'
}
sorted() { printf '%s' "$1" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,*$//'; }

# The names to cover: the ones saved before (or, on the first run, the ones the old certificate already had), plus any new.
OLD=""
if [ -s "$D/cert-names" ]; then
  OLD=$(cat "$D/cert-names")
elif [ -s "$D/tls.crt" ]; then
  OLD=$(names_of_cert "$D/tls.crt")
fi
NAMES=$OLD
if [ "${1:-}" != renew ]; then
  for raw in $(printf '%s' "${1:-}" | tr ',' ' '); do
    n=$(clean "$raw")
    [ -n "$n" ] || continue
    case ",$NAMES," in *",$n,"*) ;; *) NAMES="${NAMES:+$NAMES,}$n" ;; esac
  done
fi
[ -n "$NAMES" ] || { echo "bossmox-cert: no address to make a certificate for." >&2; exit 1; }

SAN=""
LIMIT=""
HAS_DNS=""
HAS_IP=""
for n in $(printf '%s' "$NAMES" | tr ',' ' '); do
  case "$n" in
    *:*) s="IP:$n" l="IP:$n/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" HAS_IP=1 ;;
    *[!0-9.]*) s="DNS:$n" l="DNS:$n" HAS_DNS=1 ;;
    *) s="IP:$n" l="IP:$n/255.255.255.255" HAS_IP=1 ;;
  esac
  SAN="${SAN:+$SAN,}$s"
  LIMIT="${LIMIT:+$LIMIT,}permitted;$l"
done
# A kind of name with no limit is unlimited (RFC 5280), so the missing kind gets one that matches nothing real.
[ -n "$HAS_DNS" ] || LIMIT="$LIMIT,permitted;DNS:bossmox.invalid"
[ -n "$HAS_IP" ] || LIMIT="$LIMIT,permitted;IP:0.0.0.0/255.255.255.255"

key_matches() { # key_matches <key> <cert>
  [ "$(openssl pkey -in "$1" -pubout 2>/dev/null)" = "$(openssl x509 -in "$2" -noout -pubkey 2>/dev/null)" ]
}

# A CA made before both kinds of name were limited, or without the websites-only limit, can vouch for too much.
ca_limited() {
  limits=$(openssl x509 -noout -ext nameConstraints,extendedKeyUsage -in "$D/ca.crt" 2>/dev/null) || return 1
  case "$limits" in *"IP:"*) ;; *) return 1 ;; esac
  case "$limits" in *"DNS:"*) ;; *) return 1 ;; esac
  case "$limits" in *"TLS Web Server Authentication"*) ;; *) return 1 ;; esac
}

# A new CA only when there isn't a whole, limited one, or it doesn't cover every name. The nodes then need it again.
if [ ! -s "$D/ca.key" ] || [ ! -s "$D/ca.crt" ] || ! key_matches "$D/ca.key" "$D/ca.crt" || ! ca_limited ||
  [ "$(sorted "$(cat "$D/ca-names" 2>/dev/null || true)")" != "$(sorted "$NAMES")" ]; then
  cat > "$WORK/ca.cnf" <<EOF
[req]
distinguished_name=dn
prompt=no
[dn]
CN=BossMox CA ($(printf '%s' "$NAMES" | cut -d, -f1))
[v3]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
nameConstraints=critical,$LIMIT
EOF
  run openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7305 \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" -config "$WORK/ca.cnf" -extensions v3
  chmod 600 "$WORK/ca.key"
  chmod 644 "$WORK/ca.crt"
  # The certificate first: a cut between the two leaves a key that doesn't match, which the check above catches.
  mv "$WORK/ca.crt" "$D/ca.crt"
  mv "$WORK/ca.key" "$D/ca.key"
  put "$D/ca-names" 644 "$NAMES"
  echo "new CA"
fi
chown root:root "$D/ca.key"
chmod 600 "$D/ca.key"

# The website certificate: replaced when missing, not from this CA, missing a name, or under 60 days from running out.
current_ok() {
  [ -s "$D/tls.crt" ] && [ -s "$D/tls.key" ] || return 1
  key_matches "$D/tls.key" "$D/tls.crt" || return 1
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
  [ "$(cat "$D/cert-names" 2>/dev/null || true)" = "$NAMES" ] || put "$D/cert-names" 644 "$NAMES"
  exit 0
fi
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\nauthorityKeyIdentifier=keyid\n' "$SAN" > "$WORK/leaf.ext"
run openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$WORK/tls.key" -out "$WORK/tls.csr" -subj "/CN=BossMox"
run openssl x509 -req -in "$WORK/tls.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" -CAcreateserial -CAserial "$WORK/ca.srl" -days 825 \
  -out "$WORK/tls.crt" -extfile "$WORK/leaf.ext"
chown "root:$GROUP" "$WORK/tls.key"
chmod 640 "$WORK/tls.key"
chmod 644 "$WORK/tls.crt"
# Key first, then certificate. BossMox keeps serving what it loaded at start until it restarts.
mv "$WORK/tls.key" "$D/tls.key"
mv "$WORK/tls.crt" "$D/tls.crt"
put "$D/cert-names" 644 "$NAMES"
put "$D/tls.fingerprint" 644 "$(openssl x509 -noout -fingerprint -sha256 -in "$D/tls.crt" | cut -d= -f2)"
echo changed

if [ "${1:-}" = renew ]; then
  if command -v rc-service >/dev/null 2>&1; then rc-service bossmox restart >/dev/null; else systemctl restart bossmox; fi
fi
