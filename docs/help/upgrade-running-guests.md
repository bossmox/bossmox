# Guests running on a node

## What it is

A node can't be upgraded while VMs and containers run on it, because it restarts at the end. The checker counts the guests still running.

## If you leave it

Nothing is wrong: BossMox handles it during the upgrade.

## What BossMox does

Before upgrading a node, BossMox moves its running guests to other nodes, the same way it does for updates, keeping the free room you set in **Keep free**. A VM moves while it keeps running. A container restarts on the other node, because Proxmox can't move a running container. When the node is back on the new version, its guests come home. Guests only move to a node on the same or a newer version, never back to an older one.

If there isn't room on the other nodes, BossMox stops before upgrading that node and says which guests didn't fit.

## Is it safe?

Moving guests is what Proxmox recommends before an upgrade. Proxmox says a move from an older version to a newer one always works; a move the other way may not, which is why BossMox never does it. If you press **Stop**, guests stay where they were moved until you use **Move everything back**.

## Proxmox's own page

[Move important Virtual Machines and Containers](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Move_important_Virtual_Machines_and_Containers)
