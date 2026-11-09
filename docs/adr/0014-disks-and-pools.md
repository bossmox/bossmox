# 14. Storage as disks and pools

Date: 2026-11-09. Status: accepted. Plan: `PLAN_STORAGE_VIEW.md` in the vault.

## Why

Rocky (2026-11-09): "we don't think about storage the way it's described in proxmox - we think in disks and pools - not lvm and container spaces and places you can put isos but not vms - most of our experience is going to be Windows, so normal Windows or Hyper-V - or ESXi". The Storage window had a list of Proxmox storage entries and a separate list of raw disks, with nothing connecting them.

## Decision

- **One view per node, shaped like a disk manager.** Each physical disk, with the pools on it underneath. Disks a pool spans (a ZFS mirror) are shown together as "2 disks working together". Then empty disks, disks used by something else, pools BossMox couldn't place, and network storage. The Storage and Disks tabs are gone; every action they had is on this view.
- **Pools are named for their job:** "Pool for VM and container disks", "Folder for files", "Folder for files and disks", "Network share (NFS)". The Proxmox name sits beside it, since Proxmox and its docs use it. LVM, thin pool, ZFS and paths go on a small details line at the bottom.
- **What's using the space, by name:** guests (from their disks), installer discs, templates, backups, and whatever's left over: "Proxmox itself and other files" on the system disk, "Other files" elsewhere.
- **Sizes say what they mean.** A thin pool's disks show as "(32 GB disk)" with the line "Disks here take space only as they fill", because Proxmox doesn't say how much each really takes. A disk kept as a file shows what it really takes ("4 KB of a 16 GB disk"), which Proxmox does report. A thin pool given out past its size gets a warning.
- **Each pool says what it can do:** whether snapshots work, and whether other nodes can use it, so whether guests on it can restart elsewhere. That's the HA tie-in; it only appears in a cluster.
- **Placing is from Proxmox's answers only,** nothing run on the node: volume group members for LVM, pool members for ZFS (by-id links matched to disks), and for a folder on its own mount, the mounted partition with that file system closest in size (within 8%), since Proxmox doesn't say which partition a mount is. The system disk is the `pve` volume group, else `rpool`, else the mounted file system the size of root. When BossMox can't tell, the pool goes under "On this node, disk not identified", never a guess.
- **Dead ends offer the fix.** Upload, template download, backup, schedule and restore used to stop at "no storage set up for this". Now, when a storage could hold it, there's a Let it hold this button; otherwise a way to Storage.

## Two bugs found and fixed on the way

- **VMs BossMox made on a folder, NFS or SMB couldn't be snapshotted.** Proxmox makes those disks raw unless asked, and raw files can't be snapshotted ("snapshot feature is not available", measured on PVE 9.2). Create and Add disk now ask for qcow2 there, for the main disk, the EFI disk and TPM state. A Windows VM set up that way snapshotted, TPM included. VMs made before this keep raw disks.
- **Change use dropped uses BossMox doesn't show.** Saving `local`'s uses removed snippets, because the whole list was replaced. Snippets and imports are now kept as they were.

## Tested

- 165 unit tests. The map is tested on Proxmox's real answers from three nodes: the Tiny (an ordinary LVM install plus a second drive), a lab node with a ZFS mirror, and one with an LVM-thin pool and a folder on their own disks. Backup notes stripped from the fixtures. Proven able to fail: tightening the mount match, and dropping the by-id match, each break tests.
- In the browser on the test BossMox: all three lab nodes came out right, in all three looks, and at phone width without sideways scrolling.
- The dead-end fix for real: `local` set not to hold installer discs, the message offered Let local hold installer discs, one click put it back, snippets kept.

## Not tested

- A ZFS-on-root install (`rpool`), RAID-Z, Ceph, iSCSI and multipath. The lab nodes aren't ISO installs.
- A network share in this view in the browser (unit tested; the lab NAS is off).
- An account that can't read disks: those pools should fall under "disk not identified".
