# ADR 0002: Sign in with Proxmox accounts

Date: 2026-11-05. Status: accepted. Replaces the stored token in ADR 0001. The server still holds every Proxmox credential, and the browser holds none.

## Decision

People sign in with their Proxmox username, password and authenticator code. BossMox passes them to Proxmox's ticket API, keeps the ticket in server memory, and gives the browser a random session ID in an HttpOnly, SameSite=Strict cookie. The password is never stored. BossMox has no stored Proxmox credential of its own.

## Why

- Rocky asked for native Proxmox credentials.
- There is no second account system to manage.
- Every request runs as the signed-in person, so Proxmox applies their permissions, realms and 2FA.

## Choices inside this

- Tickets renew hourly using the current ticket. Sessions end after 12 hours, or when Proxmox refuses a renewal.
- Sessions live in memory, so restarting BossMox signs everyone out.
- Ten failed attempts from one address in 5 minutes locks that address out.
- POST requests need a custom header and a matching Origin, which blocks cross-site requests.
- A network address needs HTTPS. Plain HTTP needs an explicit setting.
- This was read-only when written. ADR 0003 covers the named actions added since.

## Known limits

- WebAuthn can't pass through another site's origin, and recovery codes aren't built. Both need their own work.
- Behind a proxy, every person shares one address for the lockout.
- BossMox isn't yet tested with LDAP, Active Directory or OpenID realms. OpenID needs a separate redirect flow.
