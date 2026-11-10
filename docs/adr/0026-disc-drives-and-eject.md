# 26. Every disc drive, and Eject where a disc blocks a move

Date: 2026-11-10. Status: accepted. Builds on ADR 0025.

## Context

A read-only look at a production cluster (Maverick, Proxmox 8.4) found four VMs that BossMox wouldn't move, each holding the virtio-win ISO from a node's `local` storage. Proxmox refuses those moves ("can't migrate local disk ...: local cdrom image", proven on the 8.4 test cluster), so the refusal was right. But BossMox only knew about a disc drive on `ide2`: three of the four had the disc in `ide0`, and BossMox showed their drive as Empty with no way to take the disc out.

## Decision

- A VM's Hardware tab lists every disc drive it has, on any IDE, SATA or SCSI slot, with what's in it (a disc, Empty, or the node's own disc drive), each with its own Change disc. The cloud-init drive isn't listed: it's BossMox's setup disk, not one a person changes. A VM with no disc drive can still be given one on `ide2`, as before; no other slot is ever created.
- Changing a disc names its slot. The server refuses a slot that isn't a disc drive already (a data disk, cloud-init, or nothing there), and adds the slot to the boot order only when it isn't in it.
- The move plan says which VMs are held back only by a disc from a node's own storage, or by the node's own disc drive, and from which drives. The Restart and Update all nodes windows give each an Eject button. Eject confirms with the VM and drives named, empties those drives (the VM keeps running, the disc stays on the node), and the plan is drawn again. A VM also held back by passed-through hardware or a snapshot gets no Eject, since ejecting wouldn't free it.

## Not done

Putting the disc back after the update, and offering to move a shared ISO into place instead.

## Tested

- Unit tests: every disc drive read on any slot, with the node's own drive told apart from an empty one and the cloud-init drive left out; a disc changed on any existing drive, ide2 still added where there's none, a data disk, cloud-init, a missing drive and a non-drive slot refused; which stuck VMs can be freed by ejecting, from which drives, and that passed-through hardware isn't. 239 of 239.
- Live on the 8.4 test cluster, 2026-11-10, with a VM shaped like Maverick's RockyDEV (disk on ISCSI_SHARE, ISO from `local` in ide0, empty ide2): the Hardware tab listed both drives; Restart showed the refusal with Eject, the confirmation named the VM and drive, the disc came out with the VM running, and the plan redrew with it placed. Update all nodes stopped at Not ready with Eject, then after one click ran all three nodes (6 min 34 s) with that VM moving off and on like the rest.
