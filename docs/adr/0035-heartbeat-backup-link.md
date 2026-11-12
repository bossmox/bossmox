# 0035: A backup link for the cluster heartbeat

**Date:** 2026-11-12. **Status:** proposed (Rocky reads before any code). Issue #31, 0.2.0 piece 1.

## Context

Proxmox nodes check on each other over corosync, the heartbeat. Most small clusters give it one network. When that network has trouble (a switch reboots, a cable is pulled, live moves fill it), the nodes lose touch. With HA on, a node that loses touch restarts itself to protect its VMs. A second link on another network lets the heartbeat carry on over that one instead.

Proxmox supports this ("Adding Redundant Links To An Existing Cluster", pve-docs chapter pvecm), but only by hand-editing `/etc/pve/corosync.conf`. The API can read the heartbeat settings (`/cluster/config/nodes`, `/cluster/config/totem`) but can't change them.

Seen on the bmx8 lab (Proxmox 8.4): one link, `ring0_addr` on 10.0.30.x, `link_mode: passive`, knet, and every node also on 10.0.31.0/24.

## Decision

### What it does

Adds one link: the next link number (normally 1), one address per node on a network the person picks. Nothing else. It doesn't change link priorities or remove a link. Without priorities, Proxmox uses the lowest-numbered link that works, so link 0 stays the main one and the new link is the fallback.

### Who can

Only an account that gets a root console from Proxmox (root@pam), because the change is a file edit in a node's console. That's the same path as installing updates (ADR 0027), with the pagers off since 0.1.10. Anyone else sees the Health check item without Fix this, and a line saying a root@pam sign-in can do it.

### Which networks it offers

Networks every node has an address on, other than the one the heartbeat already uses, worked out by `cluster-net.ts` (ADR 0028). A network moves run on is offered last, with a line saying the backup link will share it with moves. That's fine for a fallback (Proxmox's docs allow a busy network as "a low-priority fallback"), but not ideal. Offered only on IPv4, and only when every node's current heartbeat address is an IP rather than a name: the same "can't judge" cases ADR 0028 already has.

### Before changing anything

All of these must hold, or it stops and says which one failed:
- Every node is online, the cluster is quorate, and the heartbeat has exactly one link today.
- Each node's address on the chosen network is found, one per node.
- From each node's console, every other node's new address answers a ping.

### The change

1. BossMox reads the current file in a node's console and keeps its checksum.
2. BossMox writes the new file itself, in TypeScript and not with sed: it adds a `ringN_addr` to every node, adds a `totem` `interface { linknumber: N }`, and raises `config_version` by one. A parser for this file's simple block format, tested on real 8.x and 9.x files.
3. The window shows the change as plain lines ("bmx8-node1 gets 10.0.31.244 as its backup heartbeat address", one per node), with the exact new file under Details. The person types the cluster's name to confirm.
4. In one node's console, a short script:
   - checks the file's checksum is still the one read, so nothing changed in between;
   - writes `corosync.conf.new`;
   - copies the current file to `corosync.conf.bak`;
   - moves `.new` into place.

   Proxmox copies the file to every node, and corosync reloads it by itself.

### After

- Within 60 seconds, every node's `corosync-cfgtool -s` must show the new link connected to every other node.
- If it doesn't, BossMox puts the `.bak` content back with `config_version` raised once more (corosync only reloads a higher version), checks the cluster is quorate on link 0, and says what it saw.
- The window ends on what each node reports.

### Health check

"The heartbeat has a backup link" passes, and lists the links. With one link, it warns "The cluster heartbeat has only one network", with Fix this. A single node that isn't in a cluster says nothing.

### Interaction with ADR 0028 (moves and the heartbeat)

A backup link on the network moves use means the heartbeat no longer has only one network, so moves can run several at a time again. That's the right call: moves filling link 1 doesn't matter while link 0 is fine, and link 0 carries no moves. `checkNetworks` must count it that way, and that gets its own test.

## Tests

- **Unit:** parsing and writing corosync.conf (8.x and 9.x fixtures; an unknown block is kept as is; a name instead of an address is refused); picking the networks; the checksum guard; the restore file.
- **Lab, bmx8:**
  1. Add link 1 on 10.0.31.0/24. Every node shows both links connected.
  2. Block corosync's port on 10.0.30.x on one node (iptables, not the interface, so SSH survives). The cluster stays quorate over link 1. Unblock.
  3. **Restore path:** block corosync's port on 10.0.31.x on one node first, so ping passes but the link can't connect. BossMox must find link 1 not connected, put the old file back, and the cluster ends quorate on link 0.
  4. Health check before and after.
- Snapshots of the three lab nodes before step 1.

## Not in this

Changing link priorities; removing a link; IPv6; heartbeats given as names; two links at once.

## Open for Rocky

1. Typing the cluster's name to confirm, like a restart's typed name. Or is naming the network and each node's address enough?
2. When the only other network is the one moves use: offer it with that warning line, or don't offer it at all?
