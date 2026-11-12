# 30. Fix this, for moves on the heartbeat's network

Date: 2026-11-12. Status: accepted. Builds on ADR 0028 and 0029.

## Context

0.1.7 warned "VM moves and the cluster heartbeat share one network" and offered Open Settings. After updating his production cluster, Rocky saw the warning and asked for a way to fix it from the warning itself: "either a link to Proxmox with the steps or we need a wizard that helps resolve this".

On his cluster, the only other network every node shares (10.0.100.0/24, one 10 Gb port per node) also carries the Synology's iSCSI storage. Settings recommended no speed limit once moves had their own network, which is wrong when that network carries the disks.

## Decision

**A Fix this button on the warning, opening one screen.** The screen shows:

- the networks every node shares that the heartbeat doesn't use, with any network storage on each;
- a speed limit, already on and set to 250 MB/s when the chosen network carries storage;
- a "What changes" line naming exactly what Proxmox will be set to.

Make the change writes the settings through the same action as the Settings switches. It then reads them back from Proxmox and says what is set, not what was asked.

**Without a second network, the screen gives the steps:** add a port on its own switch or VLAN on each node, give every node an address on that network in Proxmox, then come back to Fix this. Until then it offers the 50 MB/s limit.

**Settings knows which networks carry storage.** BossMox reads iSCSI portals and NAS addresses from Proxmox's storage list. Host names are skipped, because a name can't be matched to a network. If the network moves use also carries storage, the speed limit is recommended at 250 MB/s, about 2 Gbps of a 10 Gb link, and the move network row says so.

The wizard is a single screen rather than a multi-step wizard. There's one decision (which network), plus a limit that follows from it.

## Not done

- **A second heartbeat link.** Still a hand edit of corosync.conf (ADR 0028).
- **Telling 1 Gb from 10 Gb.** The 250 MB/s default assumes storage networks are fast. On a 1 Gb network that also carries storage, 250 MB/s is no limit at all.

## Tested (2026-11-12, 8.4 lab)

Set up the lab like the production cluster:

- Cleared the move network and speed limit.
- Gave the lab's iSCSI server an address on the lab's second network (10.0.31.248).
- Added it as storage SAN-FAST.

Health check warned and showed Fix this. The screen offered 10.0.31.0/24 "Also carries SAN-FAST", with the limit on at 250 MB/s. Make the change wrote `migration: secure,network=10.0.31.0/24` and `bwlimit: migration=256000` (250 × 1024 KiB/s) to datacenter.cfg. The result read back "Moves now run on 10.0.31.0/24 … limited to 250 MB/s", and Health check then passed.

Settings showed both rows as recommended, with the storage reason. The no-second-network screen was checked in the browser with sample data, since every lab node has a second network.

SAN-FAST and the extra address were removed afterwards.
