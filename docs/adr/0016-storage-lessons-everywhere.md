# 16. The storage lessons, applied to the rest of BossMox

Date: 2026-11-09. Status: accepted.

## Why

After the storage work (ADRs 0014, 0015), Rocky asked to "take into consideration what I just asked you to do with storage - see if we need to make similar changes to any of the other features". Every area was checked against the same five things: plain words, dead ends that offer the fix, guided choices over raw fields, BossMox checking for itself instead of trusting Proxmox to refuse, and being able to see what's there. Nodes, updates, restarts, moves, Network, snapshots, schedules and setup held up. Eight things didn't.

## Decision

1. **Deleting a guest says what's true about its backups.** It used to always say "Backups stay, so it can be restored from one". Now it asks for the backup list fresh and says how many there are and the newest, or "It has no backups, so once it's deleted there's no getting it back", or that it couldn't check.
2. **A template a linked clone still needs** is refused by BossMox first, naming the clone, on the screen and on the server. Proxmox does refuse too (measured: the task fails with "base volume ... is still in use by linked cloned"), but only as a failed task in its own words.
3. **Proxmox's error messages are put into plain words** (`src/plain-errors.ts`): a guest busy with a backup, move or snapshot, a full storage, a protected item, a running guest, a missing permission, an unreachable storage, a linked clone. The original stays on the end in brackets, since it's what to search for. Unknown messages pass through unchanged.
4. **Every storage picker says where the storage is:** "local, on the system disk, 24 GB free", "files, on QEMU HARDDISK (/dev/sdc), 7 GB free", or a network share's address, plus "no snapshots" where that's so. Create, Add disk, Clone, Restore, Upload, Back up now, schedules, Protect everything and the restart backup. Storage maps load in the background to make this possible. Where backups are saved, a line warns when that's the system disk or another drive in the same computer, and it follows the pick.
5. **Network pickers say what a virtual switch is:** "vmbr0, the network the node itself is on", "connected to eno2", or "guests only".
6. **"Snapshots aren't available" offers the fix when there is one.** VMs made before ADR 0014's qcow2 fix have raw disk files. When converting them is enough, the advice offers Make snapshots work, which converts each disk to qcow2 where it is (Proxmox's move-disk to the same storage). Only with the VM shut down, which is what was tested.
7. **The guest agent explains itself:** what it is, how to install it on Debian, Ubuntu and Windows, whether its setting is on, and a button to turn the setting on.
8. **Delete and Make template stay visible while a guest runs,** and say to shut it down first, instead of disappearing.

## Tested

- 177 unit tests, including the error wording on messages seen in the lab, linked-clone detection that doesn't confuse 960 with 9600, and which raw disks to convert (and not when a thick LVM disk would still block snapshots).
- In the lab first: Proxmox refused deleting a template with a linked clone and a protected backup, each as a failed task. Converting a raw VM's disk, EFI disk and TPM state to qcow2 on a folder turned snapshots on, and a snapshot then included the TPM state.
- In the browser on the test BossMox: each of the eight, on lab VMs made for it and removed afterward. The backup warning changed with the pick.

## Not tested

- Make snapshots work on a running VM (not offered), and on NFS or SMB (the same Proxmox call, but only a folder was tried).
- Each plain-words rule against a live failure; most are matched against messages captured or known from Proxmox's source wording.
