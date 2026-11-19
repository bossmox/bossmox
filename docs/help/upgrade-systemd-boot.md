# A boot package the node doesn't use

## What it is

`systemd-boot` is one of the ways a computer can start Linux. Nodes installed from the Proxmox VE 8.1 to 8.4 installers got the `systemd-boot` package even when they start another way, because it carried a tool Proxmox needed. Proxmox VE 9 doesn't need it there, and the package can change the boot setup by itself, so Proxmox says to remove it unless you set up systemd-boot on purpose.

The checker says this node starts the older (BIOS) way, so it doesn't use systemd-boot.

## If you leave it

It's a warning. BossMox goes ahead with the upgrade with the package installed.

## What BossMox does

Nothing: BossMox doesn't remove it, because the test cluster BossMox is proven on doesn't have this setup. It may become a button in a later release.

## Is it safe?

Proxmox's guide says the only reason to keep it is a systemd-boot setup made by hand. If you remove it, `apt install systemd-boot` puts it back.

## Proxmox's own page

[Systemd-boot meta-package changes the bootloader configuration automatically and should be uninstalled](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Systemd-boot_meta-package_changes_the_bootloader_configuration_automatically_and_should_be_uninstalled)
