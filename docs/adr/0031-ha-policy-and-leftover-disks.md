# 31. Health check: HA shutdown policy and leftover disks

Date: 2026-11-12. Status: accepted. With ADR 0030, this makes up 0.1.8, a cluster health release.

## Context

Rocky asked for fewer, fuller releases ("it does seem wild that version changes are like - 1 little thing"), and agreed to 0.1.8 as a cluster health release built from what his production cluster showed:

- **HA guests stop on a manual restart.** Sixteen guests there are HA-managed, and Proxmox's default shutdown policy stops them when a node is restarted by hand, as on 2026-11-10. Only Settings (ADR 0029) offered Migrate.
- **A leftover disk from the ESXi import.** A detached 32 GB disk on the FILE share, which nothing pointed out.
- **A setup gap.** The setup step for the move network could offer a heartbeat network on a cluster whose heartbeat has two links (noted in ADR 0029).

## Decision

**HA shutdown policy in Health check.** On a cluster with HA-managed guests, a policy other than Migrate warns "HA stops its guests when a node restarts outside BossMox". Fix this asks first and sets Migrate, through the same action as the Settings switch. With Migrate it passes. A cluster with no HA guests, or a single node, gets no item.

**Leftover disks in Health check.** Each guest's `unusedN` entries are listed by guest name, disk name and size. The size is asked of the storage that holds the disk; an unknown size shows as "at least" in the total.

Review and remove opens a list with every disk ticked. Unticking one keeps it, and the red button counts the disks that will go. Each removal deletes that `unusedN` entry, which makes Proxmox delete the disk file.

The server checks that the slot still holds the disk the person saw before removing it. A disk that has changed is not removed. Removal stops at the first failure and says which disk.

**Setup only offers networks the heartbeat doesn't use.** `freeNets` moved into cluster-net and is used by setup as well as Settings.

## Not done

- **Unused disks with no entry in any guest's config** (orphaned files on storage). Telling those apart from something else's files needs care, so it's a separate check.
- **A second heartbeat link.** Still a hand edit of corosync.conf (ADR 0028).

## Tested (2026-11-12, 8.4 lab)

Set the lab up like the production cluster:

- Cleared the move network, the speed limit and the HA policy.
- Left a leftover disk on VM web (it became `unused0` after a failed hot-unplug).
- Left another on container cache (a mount point deleted).

Health check showed all three warnings, each with its button. Then:

- **HA:** Fix this asked first, then wrote `ha: shutdown_policy=migrate`, and the item passed.
- **Leftover disks:** the list showed both disks at 1 GB. Unticking cache's disk changed the button to "Remove 1 disk". Removing it took web's `unused0` entry out and deleted vm-101-disk-1 from storage, and cache's disk stayed. A second Review and remove deleted cache's disk (the container path in Proxmox), and the item went away.
- **Move network:** Fix this offered 10.0.31.0/24 with no storage on it, so no limit. It wrote `migration: type=secure,network=10.0.31.0/24`, and the item passed.

The setup filter is covered by a unit test only: the lab's heartbeat has a single link.
