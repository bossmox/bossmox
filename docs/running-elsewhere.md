# Running BossMox: where, proxies and development

The one-line install puts BossMox in a small VM on a Proxmox node. That VM is the one supported way to run it: the Docker image and the container scripts were removed in 0.2.1, and an image for running it on your own computer is planned ([#97](https://github.com/bossmox/bossmox/issues/97)).

## Where to run it

On a Proxmox cluster, the smallest setup is the Alpine VM the installer makes: 256 MB of memory and 1 GB of disk. A VM can move between nodes while it runs, so BossMox stays online. List every node in `PVE_URL`, comma separated.

**Treat the BossMox VM like a node.** Every admin's password passes through it at sign-in, so anyone who controls that VM could capture them. Give only full admins any rights on it, including console, power, backup and cloud-init rights.

Give BossMox its own name or address. Browsers share cookies across every port on a host, so an untrusted site on another port of the same address could interfere with sign-in.

## HTTPS and reverse proxies

To use it from other machines, it needs HTTPS, because passwords pass through it. Set `TLS_CERT_FILE` and `TLS_KEY_FILE`, or put it behind an HTTPS proxy and set `BOSSMOX_BEHIND_HTTPS_PROXY=1`. List the host names you use in `BOSSMOX_ALLOWED_HOSTS`. BossMox refuses to start on a network address without one of those. `BOSSMOX_ALLOW_HTTP=1` is only for development on `127.0.0.1`.

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
