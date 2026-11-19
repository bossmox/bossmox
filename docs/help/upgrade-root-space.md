# Free space on the node's root

## What it is

The upgrade downloads and unpacks the new version's packages onto the node's own system disk (root, `/`). Proxmox asks for at least 5 GB free there, ideally more than 10 GB.

## If you leave it

Under 5 GB, BossMox won't start the upgrade: running out of space in the middle of installing can leave the node half on each version. Between 5 and 10 GB it goes ahead. If BossMox couldn't read the free space at all, it waits rather than guess: run the checker again.

## What BossMox does

It reads the free space on each node when you run the checker. To make room, delete installer discs (ISO images) or backups kept on the node's **local** storage, from BossMox's Storage.

## Is it safe?

Deleting ISO images and old backups you don't need is safe. Check a backup isn't your only copy first.

## Proxmox's own page

[Prerequisites](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Prerequisites)
