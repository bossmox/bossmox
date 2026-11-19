# Storage from outside Proxmox

## What it is

Some storage comes from a plugin someone else makes, not from Proxmox. BossMox lists any it finds.

## If you leave it

Nothing stops the upgrade, but Proxmox says to wait until the plugin's maker has adapted it for Proxmox VE 9. Without that, the storage, and the guests on it, may not work after the upgrade.

## What BossMox does

It tells you which plugins to check. Ask the plugin's maker whether their version supports Proxmox VE 9 before upgrading.

## Is it safe?

Only once the plugin supports the new version.

## Proxmox's own page

[Third-party Storage Plugins](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Third-party_Storage_Plugins)
