# 0036: Keep this guest running (HA)

**Date:** 2026-11-12. **Status:** accepted 2026-11-12 with Rocky's answers: both places, and the fencing explanation, aimed at the restart that wasn't needed. Issue #32, 0.2.0 piece 2.

## Context

Proxmox HA restarts a guest on another node when its node fails. Turning it on is one API call (`POST /cluster/ha/resources`, `sid` `vm:ID` or `ct:ID`), but it only works when several things are true, and Proxmox doesn't check them first: enough votes to stay quorate without the failed node, disks every node can reach, nothing tied to one node, and room elsewhere. Get one wrong and the guest isn't protected, or it lands in HA's error state with a reason buried in a log.

Two more things people don't expect:
- **The first HA guest arms fencing on every node.** From then on, a node that loses touch with the majority for about a minute restarts itself (watchdog), so it can't run a guest that another node is also starting. That's what makes HA safe, and it's also what restarted a node on a production cluster on 2026-11-10 (ADR 0028).
- **Shutting every node down at once with the Migrate policy leaves an HA guest half-moved:** locked (`migrate`), then in HA's error state after the next start. It happened on the lab twice on 2026-11-12. That fix was meant for 0.1.9 but didn't ship (0.2.0 prep).

Lab (bmx8, Proxmox 8.4): db (102) is HA-managed; web (101) isn't, and its disk is on shared iSCSI; no HA groups; shutdown policy Migrate (ADR 0031).

## Decision

### Where it lives

- **On each guest's page:** a "Keep this guest running" switch, with its state ("Protected: HA restarts it on another node if this one fails", or why it can't be).
- **Settings → Redundancy** (ADR 0035's section) lists the protected guests with HA's state for each, and a Stop protecting button per guest.

### Turning it on

First, every requirement is checked, and each one that fails is said in plain words, with its fix where BossMox has one:
- **Votes:** three or more, or two nodes and a working tie-breaker. The same count runs use (`haQuorumBlock`, #43/#51).
- **Disks:** every disk on storage every node can reach (shared, or the same name on each node and marked shared). A disc drive (ISO) counts, with Eject as its fix (ADR 0026).
- **Nothing tied to one node:** from Proxmox's own migrate precheck (`local_resources`, `local_disks`): passed-through devices, USB, local disks.
- **Room:** at least one other node could take it, by the same placement BossMox uses for moves.

Then the confirmation names the guest. **The first time on a cluster, it also explains fencing, aimed at what went wrong on 2026-11-10** (Rocky: "the problem we ran into though was that the server restarted on another host when it didn't need to"). There, nothing had failed: live moves filled the heartbeat's only network, node1 lost touch, the watchdog reset it, and eight healthy VMs were hard-restarted elsewhere (ADR 0028). So the window says:

- "From now on, a node that loses touch with the others for about a minute restarts itself, and HA starts its protected guests on another node. That's right when a node has really failed. It's wrong when the node was fine and only its heartbeat network was busy or had a hiccup: then guests that were running fine get restarted."
- Then what this cluster has, checked live, each with where to fix it:
  - **The heartbeat has one network:** "If that network has a hiccup, HA can restart guests that didn't need it. Give it a backup network first (Settings → Redundancy)." When the cluster has no second port, it says that instead (ADR 0035).
  - **Moves share the heartbeat's only network:** "Moves can fill it, which is what restarted guests that didn't need it on 2026-11-10. Health check has the fix." (ADR 0028.)
  - Neither: "The heartbeat has a backup network, and moves don't share its only one. That's what keeps HA from restarting guests that didn't need it."
- These are warnings, not blocks: it's the person's cluster. The window still leads with them, above the Turn on button.

Turning it on sends `state: started` and nothing else: no HA groups (8.x) or rules (9.x), so Proxmox's defaults pick where the guest goes.

### Turning it off

"Stop protecting" deletes the HA resource. The guest keeps running where it is. When it's the last HA guest, the window says fencing stays armed until the nodes' HA services go idle, which Proxmox does by itself after a few minutes.

### HA's error state

A Health check item, **bad**, for each HA guest in `error`: "HA gave up on {guest}". Its detail gives Proxmox's reason when there is one, and whether the guest is locked. **Fix this**, after a confirmation naming the guest:
1. Unlock it if it's locked, from Proxmox's config API with `delete=lock`. That needs root@pam; anyone else gets the same steps written out instead.
2. Set it to disabled under HA, then started again.

It ends with the state HA reports.

### Shutting the whole cluster down

The Migrate policy's Health check item gets one more line: "Before shutting every node down at once, stop the HA guests first. Otherwise HA can leave one half-moved and locked." And when a guest is in HA's error state, the cause above is named if the lock is `migrate`.

## Tests

- **Unit:** the requirement checks (votes, disks, local resources, room); the error-state item; the fencing explanation only the first time, with the right warning for one heartbeat network, moves on it, and neither.
- **Lab, bmx8:**
  1. Protect web (101) from its page. HA reports it started.
  2. Power node3 (web's node) off hard from Maverick (`qm stop 905`). HA restarts web on another node; measure how long. Start 905 again.
  3. A guest that can't be protected (a local disk or a disc on local storage) says why, and nothing is sent to Proxmox.
  4. Error state: lock db (`qm set 102 --lock migrate`) and restart it under HA, so HA can't start it. Health check shows the bad item; Fix this brings it back to started. If HA doesn't reach error that way, use the real cause: shut down every node at once with Migrate, as happened on 2026-11-12.
  5. Stop protecting web: the HA resource is gone and web keeps running.
- Snapshots of 903-905 before step 2 (the `preheartbeat` ones still stand).

## Lab results (2026-11-12/13, bmx8, Proxmox 8.4)

1. **Stop protecting** db from Settings → Redundancy: its HA resource went, db kept running. The cluster then had no HA guests.
2. **Refused:** a disc from node1's own storage put in db. The switch said "The disc test-disc.iso is on local, which only bmx8-node1 has. Take it out first." with Change the disc, and nothing was sent to Proxmox.
3. **Protect** web from its page: the first-time window explained fencing and, checked live, "The heartbeat has one network ... Give it a backup network first: every node has 10.0.31.0/24 on a second port". HA reported web started.
4. **Failover:** node3 (web's node) powered off hard from Maverick. HA: fence at 60 s, starting on node1 at 131 s, **started at 154 s**. node3 rejoined about 20 s after starting it again.
5. **HA's error state:** db protected, locked (`migrate`) and asked to start: error after 50 s. Health check showed "HA gave up on db" with the lock named. **Two bugs found here and fixed:** started was sent 5 s after disabled and refused while HA was still in error; then the wait looked for "disabled", but Proxmox reports HA's own state, "stopped". Now it waits for "not error". Fix this then unlocked db and brought it back started, and the Health item went once the check was read past its cache (a third small fix).
6. **Stop protecting** web from its page: off, web kept running.

Lab left as it was: db protected, web not (web now on node1, where the failover put it).

## Not in this

HA groups and rules (which nodes a guest prefers); max restart and relocate counts; protecting many guests in one go; the shutdown policy itself (ADR 0031 has it).

## Decided (Rocky, 2026-11-12)

- Both places: the switch on the guest's page and the list in Settings → Redundancy.
- The fencing explanation the first time, aimed at the restart that wasn't needed, with the cluster's own heartbeat and move-network state checked live.
