# 0037: A tie-breaker for two-node clusters

**Date:** 2026-11-13. **Status:** accepted 2026-11-13 (Rocky: the two-node lab, and the person sets up the vote machine). Issue #33, 0.2.0 piece 3.

## Context

A cluster needs a majority of votes to make changes. With two nodes there are two votes, so when one node is down the other has half, not a majority: everything keeps running, but nothing can be started, stopped or changed until the other node is back. With HA it's worse: the surviving node loses quorum and fences itself, so nothing at all survives one failure (ADR 0036 refuses HA with two votes for this reason).

Proxmox's answer is a QDevice: a small vote machine outside the cluster, running `corosync-qnetd`, that gives its vote to whichever side it can still reach. Setup, per Proxmox's docs (pvecm, "Corosync External Vote Support"):
1. On the vote machine: `apt install corosync-qnetd`.
2. On every node: `apt install corosync-qdevice`.
3. On one node: `pvecm qdevice setup <address>`. It connects to the vote machine as root over SSH, which asks for that machine's root password once, and sets up certificates both ways.

Proxmox discourages a QDevice on an odd number of nodes: it can make things worse rather than better. BossMox follows that.

Health check already warns "One node going down would lock the other" for two votes, and "The tie-breaker isn't connected" when one is set up but not voting (#51), with no fix.

## Decision

### Where it lives (the pattern from ADR 0035)

- **Settings → Redundancy** gets "Tie-breaker vote", with Set up when the cluster has an even number of nodes and no tie-breaker.
- **Health check:** the existing two-vote warning gets "Open Settings". On an odd number of nodes, nothing is offered, and Settings says why: "A tie-breaker only helps with an even number of nodes. With three, the cluster already has a majority when one is down."

### Who can

root@pam only: it installs packages and runs `pvecm` in the nodes' consoles, like the heartbeat link.

### The vote machine is the person's

BossMox doesn't create it. It must be outside the cluster, because a vote that goes down with a node is no tie-breaker. A Raspberry Pi, a NAS that runs containers, a small VM on another host, or any Debian or Ubuntu machine on the network will do. The window says that, and refuses an address that is one of the cluster's nodes or one of its guests (from the addresses BossMox knows: guest agents and container settings). It warns when it can't tell.

### Steps, in one window

1. **On the vote machine (the person does this):** BossMox shows two lines to run there as root and a Copy button: `apt install -y corosync-qnetd`, and allowing root SSH logins with a password for the setup (`PermitRootLogin yes`), which can be turned back off afterwards. Then the person types its address and presses Check.
2. **Check, from every node's console:** the address answers a ping, and the qnetd port (TCP 5403) is open (`nc -z`, or bash's `/dev/tcp`). Each failure is said in plain words, naming the node.
3. **Every node gets `corosync-qdevice`,** installed the way updates are (ADR 0027: its own systemd job, pagers off).
4. **`pvecm qdevice setup <address>`** in one node's console, opened in a window the person can type into, with the command already typed in. They press Enter, answer the SSH host-key question, and type the vote machine's root password into the console. **The password never passes through BossMox.**
5. **Check:** `pvecm status` shows the tie-breaker voting (`Qdevice` with a vote, three expected votes). The window ends on that, and on a line saying root SSH logins on the vote machine can be turned back off now.

The confirmation names the cluster and the vote machine, with the typed cluster name, as for the heartbeat link.

### After

Health check: "The cluster can lose a node and keep going: 3 votes, including a tie-breaker" (already there). HA's two-vote refusal (ADR 0036) and the runs' vote check (#43/#51) count the tie-breaker's vote already.

## Tests

- **Unit:** offered only on an even node count with no QDevice; refusing a node's or a guest's address; reading `pvecm status` for the tie-breaker's vote; the steps' messages.
- **Lab:** a **two-node lab** is needed, and the vote machine must be outside it.
  - **Proposed:** two new nested Proxmox VMs on Maverick pve-node3, `bmx2-node1`/`bmx2-node2` (VM IDs 907-908, 10.0.30.251-252, 3 GB each; Rocky OK 2026-11-13), made by the same scripts as bmx8, joined as a cluster `bmx2lab`. The vote machine is the iSCSI target VM 906 (Debian, outside both labs), as the plan said.
  - Steps: set it up through the page. Then power one node off hard: the other keeps quorum and can still start a guest. Then power the vote machine off: the cluster keeps running on two votes and Health check says the tie-breaker isn't connected.
  - Afterwards, bmx2's VMs are shut down (not deleted), like bmxlab.

## Lab results (2026-11-13, bmx2lab: two nodes, Proxmox 8.4; vote machine VM 906, Debian 12)

A BossMox VM 200 (10.0.30.253) was installed inside bmx2lab and pointed at it.
1. Health check: "One node going down would lock the other" with Open Settings. Settings → Redundancy: Tie-breaker vote, Best practice, Set up.
2. A node's own address (10.0.30.251) was refused, naming bmx2-node1.
3. Before the vote machine's lines were run, the check stopped at "the vote service doesn't answer there (port 5403). Run the lines above on the vote machine first."
4. The two lines run on 906 (and a root password set, since 906 had none, like many cloud images). Check and prepare: every node reached port 5403, corosync-qdevice installed on both nodes. The console opened with `pvecm qdevice setup 10.0.30.248` typed in; Enter, yes, the password: Done. `pvecm status`: 3 votes, Quorate Qdevice. Check the vote: "The tie-breaker is voting", with the line to turn root password sign-in off again.
5. **Failover:** bmx2-node2 powered off hard. node1 stayed quorate on 2 of 3 votes and could start a guest. node2 back: 3 votes.
6. **Vote machine down:** qnetd stopped on 906. The cluster ran on 2 votes and Health check said "The tie-breaker isn't connected". qnetd started again: 3 votes.
- Found and fixed: after setup the row showed "Set up" without the reminder to turn password sign-in off on the vote machine; it now shows it, with Check the vote.
- **Test incident:** the lab test script typed the lab root password at the SSH host-key question instead of the password prompt (its screen reader returned nothing), and printed the console, so the lab password reached the session transcript. Lab only. Scripts now report only whether a prompt appeared.
- Afterwards: 906 back to key-only root login with a locked password (qnetd left installed); bmx2lab VMs 907-908 shut down, not deleted.

## Not in this

Removing or replacing a tie-breaker; a vote machine BossMox creates; odd node counts; `--force` over an existing one.

## Open for Rocky

1. ~~OK to create the two-node lab~~ **Yes (Rocky, 2026-11-13).**
2. ~~The vote machine's setup~~ **Decided (Rocky, 2026-11-13): the person runs the two lines there themselves; BossMox never takes that machine's password.** For the lab test, Claude plays the person on VM 906.
