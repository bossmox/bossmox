# 0038: Alerts, through Proxmox's own notifications

**Date:** 2026-11-13. **Status:** accepted 2026-11-13 (Rocky: form fields for secrets, encrypted both hops and stored nowhere; email in 0.2.1; part (b) later). Issue #34, 0.2.0 piece 4, part (a).

## Context

Proxmox 8.1+ has its own notification system: **targets** (where a message goes: email by SMTP, the node's local sendmail, Gotify, a webhook) and **matchers** (which messages go to which target, by severity, type and time). Proxmox itself raises the messages that matter most: a node fenced, a backup that failed, replication that failed, new updates. Because Proxmox sends them, they arrive even when BossMox's own VM is down.

**On a fresh install they go nowhere.** Read on the bmx8 lab (8.4), and it's the default: one target, `mail-to-root`, sends through the node's local sendmail to root@pam's email address. Root has no email address set, and the local mail server has no relay. So a failed backup or a fenced node tells no one.

Rocky's call (2026-11-12): (a) Proxmox's own notifications first, then (b) BossMox's own health-check alerts.

## Decision (part a)

### Where it lives

- **Settings → Alerts** (a new section): where alerts go, what's included, Send a test, and Change.
- **Health check:** while nothing can deliver, a best-practice item, "Best practice: get an alert when something fails", that's dismissable and has Open Settings (the ADR 0035 pattern). It counts as nothing set up when the only target is the built-in `mail-to-root` and root@pam has no email address. With a BossMox target set up and its last test passed, it's a pass: "Proxmox sends alerts to {where} when something fails".

### Where alerts go (Rocky, 2026-11-13: "SMTP is basically dead - so we might need a different way")

Plain email by SMTP is still there, but it's no longer the main way: most mail providers now refuse simple password sign-in for sending. Proxmox 8.3+ also has **webhook** targets, which send to any web address and keep a secret (a token) on Proxmox's side, and **Gotify**. Both are on the bmx8 lab (8.4). So the person picks one, and BossMox fills in Proxmox's settings for it. Pasting one link or token is all they do:

| Choice | What the person gives | Proxmox target |
|---|---|---|
| **Phone push with ntfy** (free, no account, can be self-hosted) | a topic name, or their own ntfy server address; an access token if their server needs one | webhook, POST to the topic, token as a Proxmox secret |
| **Discord** | the channel's webhook link | webhook, POST with Discord's message shape |
| **Slack** | the incoming-webhook link | webhook, POST with Slack's shape |
| **Microsoft Teams** | the channel's Workflows webhook link | webhook, POST with Teams' shape |
| **Gotify** | server address and app token | Proxmox's own Gotify target |

**Email is out of 0.2.0** (Rocky, 2026-11-13: "let's just pull the email out for now - and plan that as an upcoming patch like 0.2.1"). Planned for 0.2.1: addresses, and an SMTP server that relays (host, port, security, optional username and password, from address) to Proxmox's SMTP target, under the same rules for secrets.

Each webhook preset's message format (title, message, severity) is checked against the real service before release. ntfy can be checked on the lab: its public server, or one run on VM 906. Discord, Slack and Teams need a test channel, which is Rocky's choice.

One window:
1. **Send alerts to:** one of the choices above, then its one or two fields.
3. **What to send:**
   - **Failures and warnings** (Proxmox's severities warning and error): fenced nodes, failed backups, failed replication. Always on, since that's the point.
   - **New updates are available** (Proxmox's `package-updates`): on by default.
   - **Every backup, including the ones that worked:** off by default.
4. **Save and send a test.** BossMox creates one target, `bossmox-alerts-target`, and one matcher, `bossmox-alerts`, routing the chosen messages to it. Then it calls Proxmox's own test for that target. The window asks "Did the test arrive?" Yes marks it confirmed. No keeps it unconfirmed, with the usual causes (port blocked, app password, from address the server won't accept).

Proxmox's built-in target and matcher are left alone: BossMox adds, never rewrites. **Change** edits `bossmox-alerts-target` and `bossmox-alerts`; **Turn off** removes only those two.

### Passwords, tokens and webhook links (Rocky, 2026-11-13: "form field is fine as long as BossMox passes it encrypted to Proxmox and doesn't store it in any way")

An SMTP password, an ntfy or Gotify token, and a webhook link (for Discord, Slack and Teams the link itself is the secret) are typed into a form field. Proxmox keeps them in its root-only private config (`/etc/pve/priv/notifications.cfg`), because it needs them to send.
- **Encrypted both ways:** the browser reaches BossMox over HTTPS, and BossMox reaches Proxmox's API over HTTPS, checked against Proxmox's own certificate (`src/pve.ts`). When BossMox runs on plain HTTP behind someone's own proxy (`BOSSMOX_BEHIND_HTTPS_PROXY`), the hop from that proxy to BossMox is theirs, and the window says so before asking for a secret.
- **Stored nowhere by BossMox:** not in a file, not in a log or audit line, not in memory past the request, and never sent back to the page. The page shows only that one is set. On Change, an empty field keeps the one Proxmox has.
- A test proves this: the secret appears in no answer, no audit line and no file BossMox writes.

### Who can

Changing notification targets needs Proxmox's notification permission (`Mapping.Modify` on `/mapping/notifications`). Without it, Settings shows what's set up and says that permission is needed. The exact privilege gets checked on the lab before building.

## Tests

- **Unit:** "nothing delivers" (only the built-in target and no root email; a disabled BossMox target); the target and matcher BossMox sends for each choice; secrets never in an answer to the page, an audit line or a file; Change with an empty secret sends none.
- **Lab, bmx8:** ntfy on VM 906 (its single binary), set up through the page, Send a test, and see the message arrive. A real alert: a backup job to a storage that refuses it fails, and its message arrives. Gotify on 906 the same way. Then Change, and Turn off (only BossMox's two entries go).
- **Not covered by the lab:** Discord, Slack and Teams need test channels; a real mail provider with TLS.

## Lab results (2026-11-13, bmx8, Proxmox 8.4)

Probed first: Proxmox refuses a template as the whole webhook URL, so only the private path is a secret (`https://discord.com/{{ secrets.path }}`); header values are base64 even when they hold a secret reference; `{{ json title }}` gives valid JSON. A listener on 906 received the path and token as sent, and neither was in the readable config.

Through the page, with ntfy 2.11.0 (checksum-verified) on VM 906:
1. Health check: "Best practice: get an alert when something fails". Settings → Alerts: Best practice, Set up.
2. Set up ntfy (topic, `http://10.0.30.248:8080`): Proxmox's test arrived at ntfy. The topic is in Proxmox's private config only.
3. "It arrived": Settings "Set up", Health check "Proxmox sends alerts to ntfy when something fails" (a pass).
4. **A real alert:** a container backup into a folder that can't be written failed, and ntfy got "vzdump backup status (bmx8-node1...): backup failed", tagged error.
5. Change, only the choices: the target and its topic stayed, and the next test arrived.
6. Turn off: only BossMox's target and matcher went, and Proxmox's built-in ones stayed.
7. Gotify 2.5.0 on 906, through BossMox's action: the test arrived, and the token wasn't in the readable config.

Not tested end to end: Discord, Slack, Teams (need test channels; the message shapes are unit-tested only). Fixed on the way: the Settings line's list of messages.

## Not in this

Part (b), BossMox's own health-check alerts. Proxmox has no API for another program to send through its notification targets, and won't hand back the SMTP password, so (b) needs its own sending. Provider presets; Gotify and webhooks; quiet hours (Proxmox's `match-calendar`).

## Open for Rocky

1. ~~SMTP password~~ **Decided (Rocky, 2026-11-13):** a form field, encrypted both hops, stored nowhere by BossMox.
2. **Decided (Rocky, 2026-11-13):** email moves to 0.2.1; ntfy, Discord, Slack, Teams and Gotify stay in 0.2.0.
3. **Decided (Rocky, 2026-11-13):** part (b) in a later release.
