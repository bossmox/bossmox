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
