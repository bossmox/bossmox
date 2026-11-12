# Running BossMox somewhere else

The one-line install puts BossMox in a small VM on a Proxmox node, which is the easiest way. This page is for running it yourself instead: in Docker, on another machine, or behind a reverse proxy.

## In Docker

1. Copy `/etc/pve/pve-root-ca.pem` from Proxmox to `./pve-root-ca.pem`.
2. Copy `.env.example` to `.env` and fill in `PVE_URL`. Every setting is explained in that file.
3. Run:

```sh
docker build -t bossmox .
docker run --rm --env-file .env -e PVE_CA_FILE=/ca.pem -e BOSSMOX_ALLOW_HTTP=1 \
  -v "$PWD/pve-root-ca.pem:/ca.pem:ro" -v bossmox-state:/var/lib/bossmox -p 127.0.0.1:8080:8080 bossmox
```

The `bossmox-state` volume keeps settings, preferences and the record of runs and moved guests when the container is replaced.

Then open http://localhost:8080.

## Where to run it

On a Proxmox cluster, the smallest setup is the Alpine VM the installer makes: 256 MB of memory and 1 GB of disk. A VM can move between nodes while it runs, so BossMox stays online. List every node in `PVE_URL`, comma separated.

Running BossMox outside the cluster is the most robust choice, because it keeps working when a node restarts.

**Treat wherever BossMox runs like a node.** Every admin's password passes through it at sign-in, so anyone who controls that VM or container could capture them. If it runs on the cluster, give only full admins any rights on it, including console, power, backup and cloud-init rights. Running it off-cluster avoids this.

Give BossMox its own name or address. Browsers share cookies across every port on a host, so an untrusted site on another port of the same address could interfere with sign-in.

## HTTPS and reverse proxies

To use it from other machines, it needs HTTPS, because passwords pass through it. Set `TLS_CERT_FILE` and `TLS_KEY_FILE`, or put it behind an HTTPS proxy and set `BOSSMOX_BEHIND_HTTPS_PROXY=1`. List the host names you use in `BOSSMOX_ALLOWED_HOSTS`. BossMox refuses to start on a network address without one of those, or `BOSSMOX_ALLOW_HTTP=1`, which is only for a port published to `127.0.0.1` as above.

Behind a reverse proxy, pass the original `Host` header through, set `BOSSMOX_TRUSTED_PROXY` to the proxy's address, and add the public name to `BOSSMOX_ALLOWED_HOSTS`. The proxy must add the real client address to `X-Forwarded-For`.

## Trying it without Proxmox

Run `npm run mock`, and set `PVE_URL=http://127.0.0.1:8079`. Sign in as `demo` with the password `demo`.

## Development

```sh
npm ci
npm test
npm run build && npm start
```

Design decisions, and the reasons for them, are in `docs/adr/`.
