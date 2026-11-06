# ADR 0001: A small TypeScript server holds the Proxmox token

Date: 2026-11-05. Status: accepted.

## Decision

BossMox ships as one Docker container: a small Node and TypeScript server plus a plain JavaScript front end. The server holds the Proxmox token and returns a simplified overview to the browser.

## Why

- The token must never reach the browser.
- The server turns Proxmox's raw answers into plain-language views and warnings in one tested place.
- Docker is the easiest way for most Proxmox admins to run it.

## Choices inside this

- **Runtime dependencies: none at the time.** `ws` was added later for the terminal, the only one. Node's built-in modules cover this version. TypeScript and `@types/node` are pinned development tools.
- **Certificates:** Proxmox's CA is verified through `PVE_CA_FILE`. There is deliberately no option to skip verification. `PVE_TLS_NAME` handles the common case of a certificate listing an old address: the chain is still verified, and the certificate must match that named address.
- **Read-only by construction:** the client has only a `get` method, and the token has only the `PVEAuditor` role.
- **Host header check:** only named hosts are served, so a malicious website can't reach a localhost copy through DNS rebinding.

## Known limits

- No BossMox login yet, so it binds to localhost. This must change before any network use.
- `PVEAuditor` can't list backup files, so "isn't on a backup schedule" comes from Proxmox's not-backed-up report. A VM with a one-off backup still shows this warning.
- Google Fonts are loaded from the web. Self-host them before release so BossMox works offline.
