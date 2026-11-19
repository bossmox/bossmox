# Pinning the network port names

## What it is

Linux names each network port from the hardware (for example `eno1` or `ens18`). A new kernel can name the same port differently, and Proxmox VE 9 comes with a new kernel. If a port's name changes, the network settings that use the old name stop working, and the node can come back from its restart with no network.

Pinning gives each port a fixed name that a kernel can't change. Proxmox's tool, `pve-network-interface-pinning`, names them `nic0`, `nic1` and so on, and changes the node's network settings, firewall and SDN settings to the new names. So pinning **renames** the ports once, then keeps those names.

## If you leave it

BossMox pins anyway: right before it restarts a node for the upgrade, so the new names and the new kernel arrive together.

## What BossMox does

It runs Proxmox's tool for the ports that need it and checks that each one will get its new name at the restart. If another file would win over the new name (a naming file made by hand or by cloud-init), BossMox takes its pins back out, so the restart can't cut the node off.

**Pin port names now** does the same ahead of time. The names change at the node's next restart, whatever causes it.

## Is it safe?

The bridges and addresses carry over to the new names. Two things to know:

- **Until the restart, a network change is waiting.** Don't press Apply Configuration on that node's network in Proxmox's own interface before it restarts: the waiting settings use names the ports don't have yet.
- **Anything outside Proxmox that uses the old names doesn't follow them**: your own scripts, monitoring, or notes. Check those first.

That's why BossMox's default is to pin during the upgrade itself, one node at a time, right before its restart.

## Proxmox's own page

[Network Interface Name Change](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Network_Interface_Name_Change)
