# 28. VM moves and the cluster heartbeat

Date: 2026-11-11. Status: accepted. Changes ADR 0027 (three moves at a time).

## Context

Rocky updated his production cluster (three nodes, Proxmox 8.4) by hand on 2026-11-10, starting several live moves at once. A read of the node logs the next day showed node1 fenced at 18:06. Up to six moves had been running together over vmbr0, a 1 Gb port that was also the only link for corosync, the heartbeat that tells nodes the others are alive. From 18:03:54 the heartbeat kept missing its deadline. Node1 dropped out four times in two minutes, and its cluster filesystem couldn't rejoin. HA's watchdog then reset it, and eight VMs were hard-restarted on the other nodes. The nodes also had 10 Gb ports on 10.0.100.x (the iSCSI network), but Proxmox's Migration setting was empty, so moves used the node addresses on the 1 Gb network.

Rocky: "This is one of those 'how would you ever know' problems." Proxmox's screens show neither port speeds nor that an empty Migration setting means "the heartbeat's network." He wants BossMox to "handle, or warn if set up on an existing cluster."

## Decision

**Judge by networks, not speeds.** Proxmox's API lists each node's addresses (`/nodes/{node}/network`) but not port speeds, so BossMox can't tell 1 Gb from 10 Gb. It can tell what matters: the heartbeat links (`ring{n}_addr` in `/cluster/config/nodes`), the network moves use (the Migration setting in `/cluster/options`, or else the network of each node's first heartbeat address), and the other networks every node is on. Moves "share" when, on any node, every heartbeat link sits on the network moves use. When it can't judge (one node, a heartbeat given as a host name, a node offline, IPv6), it says nothing and moves carefully.

**Existing clusters: warn.** Health check warns "VM moves and the cluster heartbeat share one network" and names the fix. If every node is on another network, it says to set Datacenter, then Options, then Migration Settings to that network in Proxmox. If not, it says another network card is needed. With moves on their own network it passes and says so.

**Moves at once follow the check.** Runs and Move everything move one VM at a time while moves share the heartbeat's network, and up to three when they don't. The start window says which, and why.

**New clusters: handle.** The setup wizard reads the networks once the cluster has two or more nodes. If moves would share the heartbeat's only network and the nodes have another network in common, it asks which network moves should use (suggesting the first one, and saying to pick the faster one if known), or leaving it as is. Choosing one sets the Migration setting, keeping the move type (secure or insecure) as it was.

## Not done, and why

- **A second heartbeat link.** Proxmox takes extra corosync links when a cluster is created or a node joins (`link1`), and every node then needs an address on that network. Getting it wrong stops a node joining. Adding a link to an existing cluster means editing corosync.conf by hand. Both wait for their own decision and a lab with two networks per node.
- **Port speeds.** Reading `/sys/class/net/*/speed` through a node's root console would work for root@pam only, and opens a console on every health check. Not worth it until a second heartbeat link or a faster-network suggestion needs it.
- **Changing the Migration setting on an existing cluster from Health check.** Rocky asked for a warning there. The setting is one line in Proxmox and easy to reverse, so a button could come later.
- **Moves on the storage network.** On Rocky's cluster the 10 Gb network also carries iSCSI. Moves there compete with disk traffic. That's still far safer than competing with the heartbeat, but it's his call, so the warning names the network and leaves the choice to him.
