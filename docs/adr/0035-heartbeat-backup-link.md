# 0035: A backup link for the cluster heartbeat

**Date:** 2026-11-12. **Status:** accepted 2026-11-12, with Rocky's changes (only with a second port; set up from Settings; a dismissable best-practice notice). Issue #31, 0.2.0 piece 1.

## Context

Proxmox nodes check on each other over corosync, the heartbeat. Most small clusters give it one network. When that network has trouble (a switch reboots, a cable is pulled, live moves fill it), the nodes lose touch. With HA on, a node that loses touch restarts itself to protect its VMs. A second link on another network lets the heartbeat carry on over that one instead.

Proxmox supports this ("Adding Redundant Links To An Existing Cluster", pve-docs chapter pvecm), but only by hand-editing `/etc/pve/corosync.conf`. The API can read the heartbeat settings (`/cluster/config/nodes`, `/cluster/config/totem`) but can't change them.

Seen on the bmx8 lab (Proxmox 8.4): one link, `ring0_addr` on 10.0.30.x, `link_mode: passive`, knet, and every node also on 10.0.31.0/24.

## Decision

### What it does

Adds one link: the next link number (normally 1), one address per node on a network the person picks. Nothing else. It doesn't change link priorities or remove a link. Without priorities, Proxmox uses the lowest-numbered link that works, so link 0 stays the main one and the new link is the fallback.

### Who can

Only an account that gets a root console from Proxmox (root@pam), because the change is a file edit in a node's console. That's the same path as installing updates (ADR 0027), with the pagers off since 0.1.10. Anyone else sees the Settings entry without its button, and a line saying a root@pam sign-in can do it.

### Only when there's a second link to use (Rocky, 2026-11-12)

"It should just ask if it CAN set up a second heartbeat network IF 2 links exist - if not, the answer is likely no without VLANs etc."

A backup only helps if it doesn't fail with the main one. So BossMox offers it only when **every node has a network on a different physical port** from the heartbeat's: a different network card or bond, worked out from Proxmox's interface list (`/nodes/{node}/network`: a bridge's ports, a bond's members, a VLAN's parent device). A VLAN on the same port doesn't count: the same cable going down takes both.

- **A second port on every node:** Settings offers "Set up a second heartbeat network", naming the network. One network is picked: networks every node has on that second port (from `cluster-net.ts`, ADR 0028), preferring one moves don't use. If the only one is the network moves use, it's still offered, with a line saying the backup will share it with moves. Proxmox's docs allow a busy network as "a low-priority fallback".
- **Not every node has one:** Settings says so and offers no button: "The cluster heartbeat has only one network, and [nodes] have no second network port to give it a backup. A second port on each node, on its own network, would." No VLAN setup.
- IPv4 only, and only when every node's current heartbeat address is an IP rather than a name: the same "can't judge" cases ADR 0028 already has.

### Before changing anything

All of these must hold, or it stops and says which one failed:
- Every node is online, the cluster is quorate, and the heartbeat has exactly one link today.
- Each node's address on the chosen network is found, one per node, on a different port from its heartbeat.
- From each node's console, every other node's new address answers a ping.

### The change

1. BossMox reads the current file in a node's console and keeps its checksum.
2. BossMox writes the new file itself, in TypeScript and not with sed: it adds a `ringN_addr` to every node, adds a `totem` `interface { linknumber: N }`, and raises `config_version` by one. A parser for this file's simple block format, tested on real 8.x and 9.x files.
3. The question shows the change as plain lines ("bmx8-node1 gets 10.0.31.244 as its backup heartbeat address", one per node), with the exact new file under Details. The window explains what a backup heartbeat does and what will change, and the person types the cluster's name to confirm (Rocky, 2026-11-12: "I was fine with the typed name and explanation").
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

### Where it lives: Settings, with a best-practice notice in Health check (Rocky, 2026-11-12)

"I don't mind having a notice in the health checks that says it's 'best practice' to redundant storage, network, heartbeat networks - and the notices should be dismissable - and, it should be something they can set up later - that would go in the settings menu."

- **Settings** gets a Redundancy section: the heartbeat's links, and "Set up a second heartbeat network" when every node has a second port. Set up any time, not only from a notice.
- **Health check** gets best-practice notices, each dismissable, each pointing to Settings: one for the heartbeat (a single link), and, as their own pieces, ones for redundant networking and storage (definitions below, to be confirmed).
- **Dismissing** hides that notice in this browser, like the desktop widget's notices (`readNotices`); it comes back if the situation changes (a new key), and "Bring back dismissed" shows them again. A best-practice notice is a suggestion, not a fault: it reads "Best practice", never a warning colour.
- With a backup link set up, the heartbeat notice becomes a pass: "The heartbeat has a backup link", listing the links.

### Interaction with ADR 0028 (moves and the heartbeat)

A backup link on the network moves use means the heartbeat no longer has only one network, so moves can run several at a time again. That's the right call: moves filling link 1 doesn't matter while link 0 is fine, and link 0 carries no moves. `checkNetworks` must count it that way, and that gets its own test.

## Tests

- **Unit:** parsing and writing corosync.conf (8.x and 9.x fixtures; an unknown block is kept as is; a name instead of an address is refused); which port an address sits on (bridge over a NIC, bridge over a bond, VLAN on a bridge or a NIC); a VLAN on the heartbeat's port isn't offered; picking the network; the checksum guard; the restore file.
- **Lab, bmx8:**
  1. Add link 1 on 10.0.31.0/24. Every node shows both links connected.
  2. Block corosync's port on 10.0.30.x on one node (iptables, not the interface, so SSH survives). The cluster stays quorate over link 1. Unblock.
  3. **Restore path:** block corosync's port on 10.0.31.x on one node first, so ping passes but the link can't connect. BossMox must find link 1 not connected, put the old file back, and the cluster ends quorate on link 0.
  4. Health check before and after.
- Snapshots of the three lab nodes before step 1.

## Not in this

Changing link priorities; removing a link; IPv6; heartbeats given as names; two links at once.

## Decided

- Only offered when every node has a second physical port with a network on it (Rocky, 2026-11-12).
- Typed cluster name and an explanation to confirm (Rocky, 2026-11-12, reversing my reading of "just ask").
- Set up from Settings; Health check carries a dismissable best-practice notice pointing there.
- The network moves use is offered when it's the only second-port network, with the shared-with-moves line.
