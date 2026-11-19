# Proxmox's upgrade checker

## What it is

Before a major upgrade, Proxmox runs a checker on each node (`pve8to9` for 8 to 9). It only reads: nothing on the node changes. It reports each check as passed, a warning or a failure. BossMox runs it on every node, one at a time, and puts what it finds in plain words.

## If you leave it

A **failure** stops BossMox from starting the upgrade, because Proxmox expects it fixed first. A **warning** doesn't stop it, but each one is worth reading. A finding BossMox doesn't recognise is shown in Proxmox's own words, and if it's a failure it still blocks.

## What BossMox does

For each finding, BossMox says who deals with it: BossMox during the upgrade, a fix BossMox can run for you, advice only, or something that must be fixed first. Run the checker again after any change; it takes about half a minute per node.

## Is it safe?

Yes. The checker only reads.

## Proxmox's own page

[Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
