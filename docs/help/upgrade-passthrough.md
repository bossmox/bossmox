# VMs with hardware passed through

## What it is

Passthrough gives a VM a piece of the node's hardware directly, such as a graphics card or a network card. BossMox lists the VMs on this node that have it.

## If you leave it

Nothing stops the upgrade. But some people found VMs with PCI passthrough wouldn't start on Proxmox VE 9's first kernel (6.14).

## What BossMox does

It tells you which VMs to check after the upgrade. If one won't start, Proxmox's workaround is to start the node on the older kernel and pin it so it stays, until a fixed kernel arrives.

## Is it safe?

The upgrade itself is the same. The risk is only to those VMs starting.

## Proxmox's own page

[Host PCI passthrough with kernel 6.14 for virtual machines sometimes broken](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Host_PCI_passthrough_with_kernel_6.14_for_virtual_machines_sometimes_broken)
