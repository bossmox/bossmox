# Keeping the free update channel

## What it is

Proxmox has two update channels. The **enterprise** channel is for nodes with a paid subscription. The **free** channel (no-subscription) gets the same software, sooner and with less testing.

Proxmox VE 9's main package brings its own file for the enterprise channel, `pve-enterprise.sources`, switched on. On Proxmox VE 8 that channel was in a file with another name, so if you had turned it off there, the upgrade still adds the new one switched on.

## If you leave it

On a node without a subscription, the enterprise channel can't download anything. Free updates still arrive, but every check for updates ends in an error about the paid server.

## What BossMox does

Before upgrading a node, BossMox reads its update sources and its subscription. When the node uses the free channel and has no subscription, it notes which paid sources are already on, and Get ready to upgrade says it will keep the free channel.

Right after the new packages are in, BossMox reads the sources again and turns off only paid sources that are new: one at a time, through Proxmox's own setting, reading each one back. It doesn't delete anything, and it doesn't touch a paid source that was on before the upgrade, or any other source.

A node with a subscription, or one not on the free channel, is left exactly as Proxmox sets it.

## Is it safe?

Yes. Turning a source off is the same switch as Proxmox's Repositories screen, and it can be turned back on there or with BossMox's update channel. If BossMox can't turn it off, the upgrade still finishes and the node's Updates tab offers the switch.

## Proxmox's own page

[Add the Proxmox VE 9 Package Repository](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Add_the_Proxmox_VE_9_Package_Repository)
