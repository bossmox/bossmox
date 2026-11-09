# 15. What's in a pool, guided Add storage, and deleting a pool

Date: 2026-11-09. Status: accepted. Plan: `PLAN_STORAGE_VIEW.md` part 2, in the vault. Lifts "removing local storage isn't offered yet" from ADR 0009.

## Why

Rocky (2026-11-09): "we don't have a file browser - and what if I wanted to remove/setup existing storage - like imagine a fresh install of Proxmox - with a person who has NO idea what they are doing".

## Decision

- **What's on it, per pool.** Disks by guest, installer discs, templates, imports, backups. Proxmox can only list what it tracks, so this isn't a browser for arbitrary files; the list says so when there's space it can't account for. Backups link to the Backups app, so they keep one home.
- **BossMox decides what's deletable, not Proxmox.** Measured first on bmx-node2: Proxmox's delete-volume call removed `fast:vm-951-disk-0` while VM 951 still used it, with no warning (repaired afterward). So:
  - A disk is deletable only when no guest in the cluster has its ID and no guest's settings name it (a linked clone names its template's base disk). That's a leftover.
  - Discs, templates and imports are deletable unless a guest's settings name them, and the message says whose drive the disc is in.
  - Nothing is deletable while a node is offline, or while any guest's settings couldn't be read, because then BossMox can't be sure.
  - The server works this out again from fresh data on every delete, and refuses with the same reason. Tested by asking it directly to delete thin-guest's disk: refused.
- **Add storage asks, BossMox picks.** Where (a drive in this computer, or a NAS), which drives (empty ones and ones with old data, each labelled), and what for (VMs and containers, backups and discs, or both). One drive for VMs makes a thin pool, two a ZFS mirror, three or more RAID-Z. Backups and discs, or both, take one drive and make a folder. The server writes the summary from the same rules that do the work, so they can't disagree. The person types erase. Drives with old data are wiped first with the same check as Wipe, then the pool is made and set to hold only what was picked. Choose the type myself keeps the old form.
- **Deleting a pool on a local drive.** Only when BossMox can see its drives, never on the system disk, never `rpool`, the `pve` volume group or part of a bigger ZFS pool, never a folder Proxmox's disk tools didn't make, and never while anything is on it or a guest or backup schedule uses it. The person types the pool's name. Proxmox removes the pool and its storage entry and wipes the drives. Network storage keeps Remove, which only unhooks.
- **The system disk explains itself.** With more than one pool on it, it says a fresh install splits it into a folder and a pool for guests, and that both stay. Its pools have no Delete button.

## Tested

- 173 unit tests. Proven able to fail: the guest-owns-it check, the system-disk refusal, and the something-still-on-it refusal each break a test when removed (with the owner check removed, the disk was still protected by the guest's settings naming it, a second layer).
- In the browser on the test BossMox:
  - bmx-node3, two empty drives: Add storage said a mirror, "one can fail without losing anything", about 8 GB. Erase stayed off until typed. Made `vmpool`. Delete with the typed name removed it and left both drives empty. Delete on `local` explained the system disk.
  - bmx-node3, a drive given an ext4 partition first: shown as "has old data", the summary named it, it was wiped, and `backups` was made holding only backups, discs and templates. Left in place for later tests.
  - bmx-node2: a leftover disk for a guest that doesn't exist was labelled and deleted; thin-guest's disk had no Delete, and asking the server directly was refused; the ISO in test2's drive said so; Delete on `fast` said thin-guest still uses it.
  - Phone width: no sideways scrolling.

## Not tested

- The system-disk note with two pools on it in the browser (the lab nodes' system disks hold one pool). Seen in the Tiny's data, not on screen.
- Add storage making RAID-Z (the lab has two spare drives per node), and a NAS through the new Where step (it opens the existing NAS flow).
- Deleting a thin pool or a folder from the browser. Both are unit tested; the delete run in the browser was the ZFS mirror.
