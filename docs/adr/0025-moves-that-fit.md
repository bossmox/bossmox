# 25. Moving guests only where they fit, and remembering where they live

Date: 2026-11-10. Status: accepted. Changes ADR 0004 (rolling updates).

## Context

Before this, emptying a node for a restart sent every running guest to one other node, picked by name, with no check for room. On a real cluster that can pile a whole node's memory onto a node that can't hold it. The list of what moved where lived in the browser that did it, so another browser or another person couldn't send the guests home. Rocky, running BossMox on a production cluster, said Update all nodes can't be used until this is fixed.

## Decision

**Placement.** Before anything moves, BossMox plans where each running guest goes, from fresh Proxmox numbers:

- Memory: the target keeps at least 15% of its memory free after the move. A guest counts at its full set memory, because a VM can grow to it. Guests BossMox has just moved also count at their full memory on the node they went to, because one that just arrived shows only what it has touched so far.
- Processor: the target's measured load plus the guest's stays under 80% of the target's cores, and a guest can't have more cores than the target.
- Storage: every storage the guest uses must exist on the target (Proxmox's migrate check, and BossMox's own list as a second check). Disks on a node's own storage are copied, so that storage on the target must keep 10% free after the copy.
- Never to an older Proxmox version. A VM set to the host's exact processor (`cpu: host`) only goes to a node with the same processor model.
- Guests that can't move anywhere are named with the reason: passed-through hardware, a snapshot on local storage, a disc image on local storage, an HA rule.

Biggest guests are placed first, each onto the node with the most memory left after it, so the load spreads. If any guest can't be placed, nothing moves, and the message names the guest, the node and the number that ruled it out.

**The record.** What moved where is kept on the BossMox server in `moves.json`, beside the settings file: each guest's home node, where it went, who moved it and when. Any browser and any person signed in sees it, and Move everything back works from any of them. A guest that someone moves somewhere else afterwards is left alone and dropped from the record.

**The moves run on the server.** One guest at a time, one job at a time across the cluster, so two jobs can't both count the same free memory. Before each guest moves, its target is checked again with fresh numbers; if it no longer fits, the rest are re-planned, and if that fails the job stops with the reason. The job runs on the signed-in person's own Proxmox login and stops starting new moves if they sign out. Closing the page no longer strands a half-done move.

**Update all nodes** plans every node that needs a restart before it starts, and refuses to start if any of them can't be emptied. Guests go home before the next node, as before, so each plan is made against a cluster with one node out.

## What this costs

- The buffers (15% memory, 80% processor, 10% storage) are fixed for now. A cluster that runs hotter than that can't use Update all nodes until there's room or they become a setting.
- Processor load is a moment's reading. A guest that is idle at planning time and busy later isn't caught.
- If ZFS on a node counts its cache as used memory, BossMox sees less room than there really is. That errs safe. ⚠️ Not checked on a ZFS node.
- The installer still needs a person at the page (ADR 0004); only the moves moved to the server.
- A move-back remembered in a browser by 0.1.2 isn't carried over.
- A move job can be stopped by the person who started it: the guest moving now finishes, nothing else starts.
- HA may move guests on its own (its own rules or shutdown policy). BossMox only sends home the guests still where it left them.
