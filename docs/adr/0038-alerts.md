# 0038: Alerts by email, through Proxmox's own notifications

**Date:** 2026-11-13. **Status:** proposed (Rocky reads before any code). Issue #34, 0.2.0 piece 4, part (a).

## Context

Proxmox 8.1+ has its own notification system: **targets** (where a message goes: email by SMTP, the node's local sendmail, Gotify, a webhook) and **matchers** (which messages go to which target, by severity, type and time). Proxmox itself raises the messages that matter most: a node fenced, a backup that failed, replication that failed, new updates. Because Proxmox sends them, they arrive even when BossMox's own VM is down.

**On a fresh install they go nowhere.** Read on the bmx8 lab (8.4), and it's the default: one target, `mail-to-root`, sends through the node's local sendmail to root@pam's email address. Root has no email address set, and the local mail server has no relay. So a failed backup or a fenced node tells no one.

Rocky's call (2026-11-12): (a) Proxmox's own notifications first, then (b) BossMox's own health-check emails.

## Decision (part a)

### Where it lives

- **Settings → Alerts** (a new section): who gets emailed, how it's sent, what's included, Send a test, and Change.
- **Health check:** while nothing can deliver, a best-practice item, "Best practice: get an email when something fails", that's dismissable and has Open Settings (the ADR 0035 pattern). It counts as nothing set up when the only target is the built-in `mail-to-root` and root@pam has no email address. With a BossMox target set up and its last test passed, it's a pass: "Proxmox emails {address} when something fails".

### Setting it up

One window:
1. **Send to:** one or more email addresses.
2. **Send through:** an SMTP server (host, port, security TLS/STARTTLS/none, optional username and password, from address), with a line saying where to find these for common providers in plain words (an app password, not the account password). No provider presets in this piece.
3. **What to send:**
   - **Failures and warnings** (Proxmox's severities warning and error): fenced nodes, failed backups, failed replication. Always on, since that's the point.
   - **New updates are available** (Proxmox's `package-updates`): on by default.
   - **Every backup, including the ones that worked:** off by default.
4. **Save and send a test.** BossMox creates one SMTP target, `bossmox-email`, and one matcher, `bossmox-alerts`, routing the chosen messages to it. Then it calls Proxmox's own test for that target. The window asks "Did the test arrive?" Yes marks it confirmed. No keeps it unconfirmed, with the usual causes (port blocked, app password, from address the server won't accept).

Proxmox's built-in target and matcher are left alone: BossMox adds, never rewrites. **Change** edits `bossmox-email` and `bossmox-alerts`; **Turn off** removes only those two.

### The SMTP password

Proxmox keeps it, in its root-only private config (`/etc/pve/priv/notifications.cfg`), and needs it to send. BossMox passes it to Proxmox once when it's typed. It doesn't store it, doesn't log it, and never sends it back to the page. On Change, an empty password field keeps the one Proxmox has.

### Who can

Changing notification targets needs Proxmox's notification permission (`Mapping.Modify` on `/mapping/notifications`). Without it, Settings shows what's set up and says that permission is needed. The exact privilege gets checked on the lab before building.

## Tests

- **Unit:** "nothing delivers" (only the built-in target and no root email; a disabled BossMox target); the matcher BossMox sends for each choice; the password never in an answer to the page or the audit line; Change with an empty password sends no password.
- **Lab, bmx8:** a mail catcher on VM 906 (Python's built-in debugging SMTP server on port 2525, plain): set up through the page with security none, Send a test, and see the mail arrive at the catcher. Then a real alert: a backup job to a storage that refuses it fails, and its mail arrives. Then Change, and Turn off (only BossMox's two entries go).
- **Not covered by the lab:** a real provider with TLS and a password. Optional, if Rocky wants to point it at a mailbox of his.

## Not in this

Part (b), BossMox's own health-check emails. Proxmox has no API for another program to send through its notification targets, and won't hand back the SMTP password, so (b) needs its own sending. Provider presets; Gotify and webhooks; quiet hours (Proxmox's `match-calendar`).

## Open for Rocky

1. The SMTP password passing through BossMox to Proxmox (not kept by BossMox), or tell people to type it into Proxmox's own screen?
2. Part (b): in 0.2.0, or the next release?
