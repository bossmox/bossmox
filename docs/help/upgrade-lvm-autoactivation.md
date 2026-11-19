# Old VM disks opened on every node

## What it is

On LVM storage, each VM disk is a slice of the disk that holds the storage. A node has to open (activate) a slice before it can use it. Disks made before Proxmox VE 9 carry a setting, *autoactivation*, that tells every node to open every slice it can see when it starts. Proxmox VE 9 makes new disks with that setting off: Proxmox opens a disk itself, on the node running the VM, when the VM starts or moves there.

This is a setting on each disk. It has nothing to do with HA.

## If you leave it

**On storage the nodes share** (an iSCSI or Fibre Channel disk all nodes see), every node that restarts opens every old VM disk. Proxmox's bug report describes what goes wrong: when a VM's disk is later deleted, the other nodes keep a stale entry for it, so creating a disk with the same name, or moving a VM live, can fail with "Device or resource busy". Proxmox strongly recommends the fix on shared storage.

**On storage only one node uses**, it does no harm. The fix is optional.

## What BossMox does

**Turn it off** runs Proxmox's own script, `pve-lvm-disable-autoactivation`, on each node in turn. It changes the setting on each existing VM disk. On shared storage the setting is stored on the shared disk, so the first node changes it for everyone.

It creates no disks, copies or moves no data, and doesn't close any disk that's in use.

## Is it safe?

Yes, with guests running: running VMs, HA and backups aren't affected, and VMs start normally afterwards because Proxmox opens their disks itself. Proxmox VE 9 expects the setting off.

## Proxmox's own page

[LVM/LVM-thin storage has guest volumes with autoactivation enabled](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#LVM/LVM-thin_storage_has_guest_volumes_with_autoactivation_enabled), and the bug report: [Bug 4997](https://bugzilla.proxmox.com/show_bug.cgi?id=4997)
