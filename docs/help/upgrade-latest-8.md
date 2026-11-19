# Starting from the latest Proxmox VE 8

## What it is

Proxmox's upgrade to 9 starts from the newest 8.4. The checker fails when the `proxmox-ve` package is older than that, or when updates are still waiting.

## If you leave it

BossMox won't start the upgrade.

## What BossMox does

Run **Update all nodes** first. It installs the waiting updates one node at a time. When an update needs a restart, it moves that node's guests off first and brings them back after, like the upgrade does. Then run the checker again.

## Is it safe?

Yes. It's an ordinary update within Proxmox VE 8.

## Proxmox's own page

[Prerequisites](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Prerequisites)
