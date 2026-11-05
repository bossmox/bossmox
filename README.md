# BossMox

**BossMox: management app for Proxmox Virtual Environment.**

A desktop-style web interface for Proxmox VE, organized around what you came to do. Everyday tasks stay in plain English, and advanced settings stay one click away.

BossMox is an independent project. It is not affiliated with or endorsed by Proxmox Server Solutions GmbH. Proxmox is a registered trademark of Proxmox Server Solutions GmbH.

## Status

Early and **read only**. This version shows servers, VMs, containers, snapshots and storage, and points out things worth a look. It cannot change anything on Proxmox.

There is no BossMox login yet, so keep it bound to localhost as shown below. Don't expose it to a network.

## Run it

1. In Proxmox, create a user with the `PVEAuditor` role on `/`, and an API token for that user.
2. Copy `/etc/pve/pve-root-ca.pem` from Proxmox to `./pve-root-ca.pem`.
3. Copy `.env.example` to `.env` and fill in `PVE_URL` and `PVE_TOKEN`.
4. Run:

```sh
docker build -t bossmox .
docker run --rm --env-file .env -e PVE_CA_FILE=/ca.pem \
  -v "$PWD/pve-root-ca.pem:/ca.pem:ro" -p 127.0.0.1:8080:8080 bossmox
```

Then open http://localhost:8080.

To try it without Proxmox, run `npm run mock`, and set `PVE_URL=http://127.0.0.1:8079` with any `PVE_TOKEN`.

## How it's built

Rocky Lott directs the product: what to build, the conventions, and what works and what doesn't. Claude, an AI model from Anthropic, writes much of the code.

## Development

```sh
npm ci
npm test
npm run build && npm start
```
