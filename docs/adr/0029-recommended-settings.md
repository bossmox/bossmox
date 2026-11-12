# 29. Settings app: recommended settings as switches

Date: 2026-11-12. Status: accepted. Builds on ADR 0028 (moves and the heartbeat).

## Context

ADR 0028 warned when VM moves share the heartbeat's only network, and set the move network only during first-run setup. Rocky then asked: "can we have the option to set the migration option in BossMox - and like a 'recommended changes' or 'recommended settings' with switches?" He chose a Settings app of its own on the desktop, and three more switches beside the move network: a move speed limit, HA moving its guests before a node shuts down, and starting guests at boot.

## Decision

**A Settings app, with Recommended settings as its first section.** Each row is a switch, the plain-words reason, and a tag: "Recommended on", "Recommended off" or "As recommended". Some rows lean neither way, so they get no tag (a speed limit when BossMox can't tell the networks; HA policy with no HA guests).

**The settings are Proxmox's own, read fresh each time.** BossMox keeps nothing: the switches read and write `/cluster/options` (`migration`, `bwlimit`, `ha`) or each guest's `onboot`. So they hold however the cluster is managed, and Proxmox's own screens show the same values.

**Each switch changes only its own part.**
- **The move network** keeps the move type (secure or insecure). Turning it off clears the network, removing the setting when the type is Proxmox's default.
- **The speed limit** keeps any other limits (restore, clone) and is written in KiB/s.
- **HA** keeps other `ha` keys.
- **The heartbeat's network is never offered for moves.** NetCheck now lists the heartbeat networks so the picker can leave them out.

**Every flip asks first and names the change** (rule 3). Changing the pick while a switch is on asks too.

**What each switch recommends:**

| Switch | Recommended |
|---|---|
| Move network | Always on. It can't be switched on without a free network every node shares; the row says a second network card is needed. |
| Speed limit | On while moves share the heartbeat's network (50 MB/s, about half a 1 Gb port). Off when moves have their own network, since it only slows them. |
| HA policy (Migrate) | On when HA manages any guest. The row says BossMox's own restarts move guests first either way, and that a guest that can't move holds up the shutdown. |
| Start at boot | On, and switches on only. Turning it off is per guest, on each guest's page. |

**Who can flip them.** Cluster options need Sys.Modify on `/`. Without it, the switches show locked, with that reason.

**Health check links here.** The shared-network warning's fix is now "Open Settings", in place of directions to Proxmox's Datacenter screen.

## Not done, and why

- **Recommending a speed for a given port.** Proxmox's API doesn't give port speeds (ADR 0028). The 50 MB/s default assumes the worst case, 1 Gb.
- **Watching an HA shutdown with Migrate.** On the lab, the setting was written and read back, but no node was shut down outside BossMox to watch HA move a guest. That is Proxmox's own behavior, documented by Proxmox.
- **The setup wizard's move-network step** still lists every shared network, including another heartbeat network on a cluster with two heartbeat links. It only shows when moves share the heartbeat's only network, so it hasn't mattered yet.

## Tested (2026-11-12, 8.4 lab)

Opened Settings on the lab BossMox and flipped each switch through the browser, checking `datacenter.cfg` after each:

- **Move network off:** the `migration` line was removed. Health check warned, named 10.0.31.0/24, and its Open Settings button brought Settings to the front.
- **Speed limit on at 50:** wrote `bwlimit: migration=51200`. A live move of web then logged "migration speed limit: 50.0 MiB/s" and "use dedicated network address … (10.0.31.246)". Changing the pick to 100 while on asked first, then wrote 102400. Off removed the line.
- **HA on:** wrote `ha: shutdown_policy=migrate`.
- **Move network on with 10.0.31.0/24:** wrote `migration: type=secure,network=10.0.31.0/24`.
- **Start at boot:** set `onboot: 1` on db and web, then showed on and locked.

Checked in the Daylight and Dusk looks. The locked view for an account without Sys.Modify is covered by unit tests only.
