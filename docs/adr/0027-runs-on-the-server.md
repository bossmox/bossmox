# 27. Updates and restarts run on the server

Date: 2026-11-10. Status: accepted. Changes ADR 0004 (rolling updates) and ADR 0025 (moves).

## Context

Rocky ran Update all nodes on a production cluster and asked for four things: it should keep going if the window closes by accident, moves should be faster on 10 Gb links, he wants to choose per VM whether it moves or shuts down, and the Virtual Machines window should filter by node. Until now the open page drove the run, step by step, and a person typed Y in each node's updater (ADR 0004).

## Decision

**A run lives on the server.** Restart and Update all nodes both start a run, kept in `runs.json` beside the settings and driven by the BossMox server, one at a time. Any browser, any signed-in person, sees it and can stop it. Stop finishes the step under way and starts nothing new; the person who started it signing out does the same. A run that was going when BossMox itself restarted is marked stopped, with where it was, and doesn't resume on its own.

**Approval moves to the start.** The start window shows every node's updates, and the person approves once by typing `confirm`. BossMox then installs on each node through that node's root console with `apt-get dist-upgrade -y`, keeping existing config files where a package ships a new one (`--force-confdef --force-confold`, as Debian's unattended upgrades do). New copies apt leaves beside them are listed at the end. A node that still has updates after the install stops the run. This needs an account that gets a root shell from the node console (root@pam); one that doesn't is told so before anything moves.

**Per-VM choices.** For each running VM on a node that restarts: Move or Shut down. Move is the default where the plan can place it; Shut down where it can't (a disc from local storage, passed-through hardware, no room), so one VM no longer blocks the whole update. VMs BossMox shut down are started again once the node is back. BossMox's own VM is found by its network card's MAC and always moves; if it can't, the run can't start.

**Moves in batches.** Up to 3 VMs move at once, the batch planned together so their room is counted together; the room is checked again before each batch. Coming home works the same way, and what doesn't fit still stays where it is.

**Node filter.** The Virtual Machines window gets a node picker beside All, Running and Needs a look.

## What this costs

- Unattended installs mean nobody reads apt's questions. Keeping the old config file is the safe answer for a running cluster, but a changed default in a new config file isn't applied until someone merges it. The end of the run lists those files.
- The run uses the starting person's Proxmox login, renewed while it runs, so it ends with their session (12 hours).
- Three moves at once share the migration network. On 1 Gb links that's slower per VM, not overall.

## Tested (2026-11-11, 8.4 lab, 3 nested nodes on shared LVM-over-iSCSI)

- **Update all nodes, browser closed:** 2 real updates per node including a kernel. db (HA) chosen Shut down, web chosen "Eject its disc, then move" (a local ISO), cache (container) Move, BossMox moving itself. Closed the browser 20 s in; node1 installed through its root console and restarted with no page open. A fresh sign-in mid-run opened the run window on its own, and the desktop line showed the current step. All three nodes ended on 0 updates.
- **Restart, mixed choices, Stop:** Stop during emptying finished the step, restarted nothing, started the shut-down container again, and listed the rest as "Not moved". A full restart then shut down and started cache, moved db out and home, and left BossMox away because node1 would have gone under its 10% (correct on 3 GB nodes).
- **Node filter:** each node shows only its VMs.

The first run found four problems, all fixed before release:

1. A VM chosen to move that wasn't moved was marked failed and **the run carried on to install and restart**. Now the run stops before the install.
2. An old moved-away record brought a container home to node1 before node2's turn, so node2 had nothing to move and showed "Problem". The run now asks Proxmox where each VM is.
3. **A VM that stayed on node3 after node1's turn went down with node3's restart**, because each node's list was fixed at the start. The run now reads what's running on a node at its turn, and moves off anything that arrived.
4. web didn't come home because node1 read 97% processor right after its boot. Coming home now waits up to 5 minutes for the node to drop under the cap. Not seen engaging live: the lab's second restart settled before it was needed.

Not shown: an install that asks a question despite the settings, or one that fails partway; a run that outlasts its 12-hour login.
