# 25. Moving guests only where they fit, and remembering where they live

Date: 2026-11-10. Status: accepted. Changes ADR 0004 (rolling updates).

## Context

Before this, emptying a node for a restart sent every running guest to one other node, picked by name, with no check for room. On a real cluster that can pile a whole node's memory onto a node that can't hold it. The list of what moved where lived in the browser that did it, so another browser or another person couldn't send the guests home. Rocky, running BossMox on a production cluster, said Update all nodes can't be used until this is fixed.

## Decision

**Placement.** Before anything moves, BossMox plans where each running guest goes, from fresh Proxmox numbers:

One setting, **Keep free on each node**, sets every buffer: 10% by default, 5 to 30% (Rocky, 2026-11-10: "set the barriers at 10% with an adjustable option"). It's cluster-wide, kept with the other preferences (ADR 0018), and offered in the Restart and Update all nodes dialogs, where changing it redraws the plan.

- Memory: the target keeps at least that share of its memory free after the move. A guest counts at its full set memory, because a VM can grow to it. Guests BossMox has just moved also count at their full memory on the node they went to, because one that just arrived shows only what it has touched so far.
- Processor: the target's measured load plus the guest's stays under the rest (90% busy at the default), and a guest can't have more cores than the target.
- Storage: every storage the guest uses must exist on the target (Proxmox's migrate check, and BossMox's own list as a second check). Disks on a node's own storage are copied, so that storage on the target must keep the same share free after the copy.
- Never to an older Proxmox version. A VM set to the host's exact processor (`cpu: host`) only goes to a node with the same processor model.
- Guests that can't move anywhere are named with the reason: passed-through hardware, a snapshot on local storage, a disc image on local storage, an HA rule.

Biggest guests are placed first, each onto the node with the most memory left after it, so the load spreads. If any guest can't be placed, nothing moves, and the message names the guest, the node and the number that ruled it out.

**The record.** What moved where is kept on the BossMox server in `moves.json`, beside the settings file: each guest's home node, where it went, who moved it and when. Any browser and any person signed in sees it, and Move everything back works from any of them. A guest that someone moves somewhere else afterwards is left alone and dropped from the record.

**Coming home.** Guests go home one at a time, each checked for room. One that doesn't fit stays where it is, running, still recorded as away, and the rest carry on; Update all nodes doesn't stop for it (Rocky: "bring home what fits... most people don't really care which VMs run on which nodes, they just want things balanced and HA capable"). If a guest that's away gets moved again, for example when the node it's on is updated, its home stays the node it came from.

**The moves run on the server.** One guest at a time, one job at a time across the cluster, so two jobs can't both count the same free memory. Before each guest moves, its target is checked again with fresh numbers; if it no longer fits, the rest are re-planned, and if that fails the job stops with the reason. The job runs on the signed-in person's own Proxmox login and stops starting new moves if they sign out. Closing the page no longer strands a half-done move.

**Update all nodes** plans every node that needs a restart before it starts, and refuses to start if any of them can't be emptied. Guests go home before the next node, as before, so each plan is made against a cluster with one node out.

## What this costs

- Counting guests at full set memory is strict: a node packed past the buffer by set memory refuses new guests even if they'd use little. In the test lab that kept a guest from going home to the node it had lived on. Lowering Keep free is the way out.
- Processor load is a moment's reading. A guest that is idle at planning time and busy later isn't caught.
- If ZFS on a node counts its cache as used memory, BossMox sees less room than there really is. That errs safe. ⚠️ Not checked on a ZFS node.
- The installer still needs a person at the page (ADR 0004); only the moves moved to the server.
- A move-back remembered in a browser by 0.1.2 isn't carried over.
- A move job can be stopped by the person who started it: the guest moving now finishes, nothing else starts.
- HA may move guests on its own (its own rules or shutdown policy). BossMox only sends home the guests still where it left them.

## Tested

- Unit tests: placement (spreading, each buffer and the setting, storage presence and copy room, versions, `cpu: host`, Proxmox refusals, stuck guests), the record and the job (one at a time, a failure keeps what moved, re-planning, Stop, sign-out, blips, coming home with some staying, keeping the real home, a BossMox restart). 235 of 235.
- Live, 2026-11-10, on a new nested test cluster `bmxlab` on Maverick pve-node3 (VMs 900 to 902, 3 GB each, Proxmox 9.2.26), with BossMox installed inside it by the normal installer, so it moved itself:
  - Restart bmx-node1 with four guests (1.5 GB of set memory, more than either other node could hold): spread two and two, moved one at a time including BossMox, without losing the page; node restarted.
  - Move everything back from a fresh sign-in with browser storage wiped: the server's record was used. At 15% one guest didn't fit at home; that led to the decision above. At 10%: two came home, one stayed, no error.
  - Update all nodes with a real kernel update on all three (proxmox-kernel-7.0 held one build back): moved off, installed, restarted and came home node by node, the stayed guest kept bmx-node1 as its home through two more moves, a page reload resumed at the right step, all three on the new kernel and quorate at the end. 4 min 42 s after the first restart.
  - Keep free at 30% removed the move choice with the reasons and numbers; back at 10% it redrew in place.
  - Stop during a move: that guest finished, nothing else started, the record kept it.
- Not shown live: shared storage (NFS, iSCSI), HA-managed guests, VMs set to `cpu: host` across different processors, a disc image on local storage (Proxmox's refusal is from its source, not seen), large disks copying, Proxmox 8 (Maverick runs 8.4; containers there have no migrate check, so BossMox's own storage check is the only one), and BossMox installed as a container, where moving it restarts it and stops the job mid-way.

