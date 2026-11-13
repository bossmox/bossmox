# 0040: Email alerts through Outlook

**Date:** 2026-11-13. **Status:** accepted 2026-11-13 (Rocky: OK to keep the token, encrypted). Issue #34, 0.2.1.

## Context

ADR 0038 left email for 0.2.1. Rocky then dropped SMTP: "I think SMTP is too unreliable and could just frustrate people", and after research chose "Outlook only" (2026-11-13). Gmail follows once Google verifies a BossMox app: its `gmail.send` permission needs that, and Google's code sign-in allows no Gmail permission.

Outlook sends through Microsoft Graph (`POST /me/sendMail`), which needs a sign-in token that lasts about an hour, renewed with a longer-lived refresh token. Proxmox's webhook target sends a fixed secret and can't renew anything. So Proxmox can't send this email itself.

## Decision

- **One BossMox app registration** in Rocky's own Microsoft tenant, for personal and work accounts, a public client with no secret. Its client ID ships in BossMox. Unverified for now (Rocky 2026-11-13: "let's leave it unverified for now"), so a Microsoft 365 tenant may need its admin to approve it. Permissions: `Mail.Send`, `offline_access`. BossMox can send as the account, and can't read its mail.
- **Sign-in by code:** Settings → Alerts → Email (Outlook). BossMox shows a short code; the person enters it at microsoft.com/devicelogin on any device and approves. Nothing has to reach BossMox's address from outside.
- **BossMox sends the email.** Proxmox gets a webhook target pointing at BossMox, with a shared secret it keeps in its private config. BossMox checks the secret and sends the message through Graph to the chosen addresses (the signed-in account by default).
- **BossMox keeps the refresh token, encrypted** (Rocky 2026-11-13: "can we encrypt the token at rest?", then "ok"). AES-256-GCM from Node's own crypto; the key is a separate root-only file outside the settings folder, so a copy of the settings folder alone (a backup of it, a bug report) is useless. It doesn't stop someone with root on the BossMox machine, or a backup of the whole VM: BossMox has to unlock the token unattended, and the default Alpine VM has no TPM. This differs from ADR 0038, where BossMox keeps no alert secret at all.
- **It stays signed in:** BossMox renews the token on a schedule, so a quiet month doesn't let it lapse. If Microsoft refuses the renewal, Health check says email alerts stopped and offers Connect again.
- Send a test and Turn off work as in ADR 0038. Turn off also forgets the token.

## Consequences

- **Email depends on BossMox being up**, unlike the 0.2.0 targets Proxmox sends itself. A node failure that takes BossMox's VM down with it sends no email. The setup window says so and suggests a second target (ntfy) for those.
- To check on the lab before building the webhook leg: whether Proxmox's webhook target accepts BossMox's own certificate (⚠️ not checked).
- Device code sign-in with a personal account and `Mail.Send` isn't spelled out in Microsoft's documentation. Prove it with a real free outlook.com account first.
