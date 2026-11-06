# 9. Storage, disks and Protect everything

Date: 2026-11-06. Status: accepted.

## Decision

- **Adding a share tests it.** Saving a share in Proxmox doesn't prove it works, so BossMox asks a node to use it and removes the entry if the node can't connect within 8 seconds.
- **Removing storage is only an unhooking.** Nothing on it is erased. BossMox refuses while a guest, a disc drive, a left-over disk or a backup schedule still uses it.
- **Wipe is stricter than Proxmox.** A disk that's mounted, has a mounted partition, or belongs to LVM or ZFS can't be wiped from BossMox, on the screen or through the action. A separate LVM data disk holds live guests while showing nothing mounted, so "not mounted" isn't enough. Those have to be cleared in Proxmox.
- **Local storage is built only on empty disks,** and the layouts offered depend on how many disks are picked.
- **Removing local storage isn't offered yet.** Doing it properly means destroying a pool, which needs its own design. Proxmox's own screens do it for now.
- **Protect everything is one schedule covering all guests,** so new guests are covered without anyone doing anything. Proxmox runs it, so BossMox can be off. It suggests shared storage first and warns when the only choice is the node's own disk.
- **A failing disk reaches the desktop.** Disks are checked every 5 minutes and shown as a notice. The check is client side because disk checks are slow, and shouldn't hold up the overview.

## SMB passwords in the node's access log

Proxmox's SMB scan takes the password in the address, and only offers GET. That means it lands in `/var/log/pveproxy/access.log` on the node doing the scan. Accepted, because that log is readable only by root and root can already read saved storage passwords in `/etc/pve/priv/`. BossMox itself doesn't store or log the password.

## Found while testing

- The cluster summary reports a shared storage once, as on "All nodes", and takes a while to notice a new one. Storage is now asked of each node directly.
- A node also lists storage restricted to other nodes, marked as not enabled. Those are left out, otherwise they read as "not available".
- A share's space counts once, however many nodes can see it.
- An SMB scan can succeed with a wrong password, because Samba treats a bad login as a guest. The real test catches it, and Proxmox refuses to add it.

## Not tested live

- A really failing disk: virtual disks always report healthy, so the notice was tested with an injected failure.
- ZFS with 3 or more disks. Test nodes have 2 spare disks each.
