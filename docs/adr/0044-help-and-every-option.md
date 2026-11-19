# 0044: Help, every option in BossMox, and runs that say what they're doing

**Date:** 2026-11-19. **Status:** accepted for building (Rocky, during Maverick's 8 to 9 upgrade: "each warning or item could have a ? icon that leads to a larger information set"; "I think we should always offer all the options"; "I don't want users to have to go to the proxmox interface"; "even if it's just step X of X with check marks"; "let's start on 0.3.2 including security review/pre-planning").

## Context

Rocky upgraded a real three-node cluster from Proxmox VE 8.4 to 9.2 with BossMox 0.3.1. It worked: every node upgraded, every guest came home. But the screens left him guessing at each step:

- "Shared LVM storage: turn off autoactivation first" sounded like turning off HA. Nothing said that running guests and HA aren't touched, or that no disks are created. There was nowhere to read more.
- Only **Upgrade all nodes** could start an upgrade. The one-node button appears only after a stopped run.
- The run showed "Upgrading Proxmox VE and restarting" for ten minutes, and moves showed "moving… done". **Stop after this step** gave no sign it had been heard, though the server recorded it.
- A run stopped before the last node because Keep free (10%) left no room, with no way to adjust and carry on.
- Proxmox VE 9's package installs its paid update source switched on. On a node using the free channel without a subscription, every update check then fails.
- A read of every screen found 12 actions offered only cluster-wide or only per node, 25 places that send people to Proxmox's interface or a shell, 15 texts in Proxmox's jargon, and 13 dead ends.

## Decision

- **Help.** Each upgrade-checker item gets a **?** that opens a Help window at its article, and a Help app on the desktop holds every article. An article answers five questions: what it is, what happens if you leave it, what BossMox does and doesn't touch, whether it's safe with guests running and can be undone, and Proxmox's own page on it. Articles are Markdown files in `docs/help/`, so the app and GitHub show the same words. A small renderer in `public/help.js` handles headings, paragraphs, lists, bold, code and links, escapes everything, and only makes links to `https://` addresses on a short list of Proxmox and GitHub hosts. The server reads the articles once at startup and serves them by name from that list, to signed-in users.
- **Every option.** What BossMox does to the whole cluster, it also offers for one node, and the reverse where it makes sense. **Upgrade this node** is a run of one node on the same run engine as Upgrade all nodes, with the same checks, so there's one path, not two.
- **Runs say what they're doing.** An upgrade shows its six steps (checking, installing, checking again, pinning port names, restarting, confirming) with check marks, a package count while installing when Proxmox's output gives one, and how long ago the node last reported anything. Moves show the amount copied from Proxmox's task log. Stop shows the server's state: "Stopping after this step: <node> finishes, then the run stops." Only numbers are read from task logs; log lines are never shown.
- **A run that can't place guests offers a way forward** in the same window: lower Keep free for this run only (showing what each node would be left with), shut down the named guests that don't fit, or wait and try again.
- **The upgrade keeps the free channel.** Get ready to upgrade reads each node's channel and subscription. When the node is on the free channel without a subscription, it finds which paid sources the new release's packages will add and lists turning them off as a planned step. The upgrade turns them off through Proxmox's repositories API right after installing, one entry at a time, and checks the update check comes back clean.
- **Wiring before new abilities.** This release fixes the audit items that only need BossMox's existing actions connected (Empty this node, Move disk where snapshots or HA need it, the update guard pointing at BossMox's own upgrade, a reason on every upgrade block, unlocking a container in HA Fix this). Items that need new abilities (shutting down nodes, a guided one-node update, subscription keys, permissions, certificates) wait for 0.3.3 and later.
- **Security is designed first.** The plan lists rules R1–R10, drawn from what past reviews found, and the design of each piece against them. An outside reviewer reads the design before any code. The usual outside review after building still runs.

## Consequences

- `docs/help/` is part of the release, and articles are reviewed like code: every fact checked against Proxmox's documentation or the lab before it's written.
- The run screen and its record grow: the server already tracks the upgrade steps; the page shows them.
- Container unlock needs the node's root console (Proxmox's container config has no `skiplock`), so it's root@pam only, like unlocking a VM.
- The coverage checklist (107 of 680 Proxmox operations, last refreshed 2026-11-10) is refreshed in a later release, not this one.
