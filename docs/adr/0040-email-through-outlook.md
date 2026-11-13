# 0040: Email alerts through Outlook

**Date:** 2026-11-13. **Status:** accepted 2026-11-13 (Rocky: OK to keep the token, encrypted). Issue #34, 0.2.1.

## Context

ADR 0038 left email for 0.2.1. Rocky then dropped SMTP: "I think SMTP is too unreliable and could just frustrate people", and after research chose "Outlook only" (2026-11-13). Gmail follows once Google verifies a BossMox app: its `gmail.send` permission needs that, and Google's code sign-in allows no Gmail permission.

Outlook sends through Microsoft Graph (`POST /me/sendMail`), which needs a sign-in token that lasts about an hour, renewed with a longer-lived refresh token. Proxmox's webhook target sends a fixed secret and can't renew anything. So Proxmox can't send this email itself.

## Decision

- **One BossMox app registration** in Rocky's own Microsoft tenant, for personal and work accounts, a public client with no secret. Its client ID ships in BossMox. Unverified for now (Rocky 2026-11-13: "let's leave it unverified for now"), so on a Microsoft 365 work account an admin has to approve it: Microsoft stopped users consenting to new multi-tenant apps from unverified publishers in November 2020, and the Entra portal says so on the app (seen 2026-11-13). Personal accounts aren't under that rule (a third-party source says so, not Microsoft's docs; to prove with a real outlook.com account). Permissions: `Mail.Send`, `offline_access`. BossMox can send as the account, and can't read its mail.
- **Sign-in by code:** Settings → Alerts → Email (Outlook). BossMox shows a short code; the person enters it at microsoft.com/devicelogin on any device and approves. Nothing has to reach BossMox's address from outside.
- **BossMox sends the email.** Proxmox gets a webhook target pointing at BossMox, with a shared secret it keeps in its private config. BossMox checks the secret and sends the message through Graph to the chosen addresses (the signed-in account by default).
- **BossMox keeps the refresh token, encrypted** (Rocky 2026-11-13: "can we encrypt the token at rest?", then "ok"). AES-256-GCM from Node's own crypto; the key is `/etc/bossmox/secret.key`, outside the settings folder, made by the installer and owned by root with BossMox's group able to read it (like `tls.key`), so BossMox can use it but not replace it, so a copy of the settings folder alone (a backup of it, a bug report) is useless. It doesn't stop someone with root on the BossMox machine, or a backup of the whole VM: BossMox has to unlock the token unattended, and the default Alpine VM has no TPM. This differs from ADR 0038, where BossMox keeps no alert secret at all.
- **It stays signed in:** BossMox renews the token on a schedule, so a quiet month doesn't let it lapse. If Microsoft refuses the renewal, Health check says email alerts stopped and offers Connect again.
- Send a test and Turn off work as in ADR 0038. Turn off also forgets the token.

## Consequences

- **Email depends on BossMox being up**, unlike the 0.2.0 targets Proxmox sends itself. A node failure that takes BossMox's VM down with it sends no email. The setup window says so and suggests a second target (ntfy) for those.
- **Proxmox to BossMox is encrypted, never plain HTTP** (Rocky 2026-11-13: "Plain text over network is always bad"). Proxmox's webhook (`proxmox-notify`, `webhook.rs`) has no setting for a self-signed certificate or a fingerprint; it trusts the node's system certificates. So the nodes are made to trust BossMox's certificate, in the narrowest way that works:
  - The nodes don't already trust Proxmox's own cluster CA system-wide (bmx8lab, 8.4, 2026-11-13: its fingerprint isn't in the system store, and the node's own certificate fails `openssl verify` against it), so that shortcut is out.
  - Proven on bmx8lab the same day, with Proxmox's own webhook test: a certificate from a CA the node doesn't trust is refused ("unable to get local issuer certificate"); once that CA is in `/usr/local/share/ca-certificates` and `update-ca-certificates` has run, it's accepted and the message arrives; a trusted CA whose name limit doesn't cover the address is refused ("permitted subtree violation"). Test pieces removed afterwards.
  - So BossMox makes a one-time CA limited by name constraints to BossMox's own address and name, signs its certificate with it, and deletes the CA's key. That CA goes into each node's trusted list. With its key gone, it can never vouch for anything else, so the nodes' other encrypted connections can't be faked with it. Redone when BossMox's address changes or a node joins; Health check names a node that doesn't have it.
- Device code sign-in with a personal account and `Mail.Send` isn't spelled out in Microsoft's documentation. Prove it with a real free outlook.com account first.
