# BossMox

**BossMox: management app for Proxmox Virtual Environment.**

A desktop-style web interface for Proxmox VE, organized around what you came to do. Everyday tasks stay in plain English, and advanced settings stay one click away.

BossMox is an independent project. It is not affiliated with or endorsed by Proxmox Server Solutions GmbH. Proxmox is a registered trademark of Proxmox Server Solutions GmbH.

## Status

Early. Sign in with your normal Proxmox account, including authenticator-app 2FA. You see and do what your Proxmox permissions allow. You can start, stop, create, change, delete and open a console on VMs and containers, take snapshots, back up and restore on a schedule, and update a whole cluster one node at a time. It also shows nodes, storage, network, services and recent activity, and points out things worth a look. It can check a server for updates and install them in a live terminal. Everything it can change is listed in `ACTIONS` and the install route in `src/server.ts`.

Hardware security keys (WebAuthn) and recovery codes don't work in BossMox yet.

## Run it

1. Copy `/etc/pve/pve-root-ca.pem` from Proxmox to `./pve-root-ca.pem`.
2. Copy `.env.example` to `.env` and fill in `PVE_URL`.
3. Run:

```sh
docker build -t bossmox .
docker run --rm --env-file .env -e PVE_CA_FILE=/ca.pem -e BOSSMOX_ALLOW_HTTP=1 \
  -v "$PWD/pve-root-ca.pem:/ca.pem:ro" -p 127.0.0.1:8080:8080 bossmox
```

Then open http://localhost:8080.

On a Proxmox cluster, the smallest setup is the Alpine VM in `deploy/`: 256 MB of memory and 1 GB of disk. A VM can move between servers while it runs, so BossMox stays online. List every server in `PVE_URL`, comma separated.

Running BossMox outside the cluster is the most robust choice, because it keeps working when a node restarts.

To use it from other machines, it needs HTTPS because passwords pass through it. Set `TLS_CERT_FILE` and `TLS_KEY_FILE`, or put it behind an HTTPS proxy and set `BOSSMOX_BEHIND_HTTPS_PROXY=1`. List the host names you use in `BOSSMOX_ALLOWED_HOSTS`. BossMox refuses to start on a network address without one of those, or `BOSSMOX_ALLOW_HTTP=1`, which is only for a port published to `127.0.0.1` as above.

To try it without Proxmox, run `npm run mock`, and set `PVE_URL=http://127.0.0.1:8079`. Sign in as `demo` with the password `demo`.

## How it's built

Rocky Lott directs the product: what to build, the conventions, and what works and what doesn't. Claude, an AI model from Anthropic, writes much of the code.

## Development

```sh
npm ci
npm test
npm run build && npm start
```
