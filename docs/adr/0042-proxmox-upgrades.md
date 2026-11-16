# 0042: Upgrading Proxmox VE to the next major version

**Date:** 2026-11-13. **Status:** accepted (Rocky's three decisions below); building in 0.3.0. Issue #95. Plan with Proxmox's procedure and gotchas: `PLAN_0.3.0_PROXMOX_UPGRADES.md` in the project notes.

## Context

Rocky: "Ultimately I don't want people to HAVE to go to the Proxmox interface for anything except the initial install." A major upgrade (8 to 9) today means following Proxmox's guide by hand on every node: a checker (`pve8to9`), a source switch, `apt dist-upgrade` with config-file questions, a reboot, then the next node, with gotchas that can leave a node unreachable (port names that change with the new kernel, UEFI-on-LVM boot) or break things afterwards. Since 0.2.1 a normal update refuses a node whose sources already point at the next release (ADR 0039), so the only way through is this, on purpose.

Proxmox VE 8 reached end of life on 2026-08-31. The first real user is Rocky's own cluster: "if I won't use it - I can't expect anyone else to."

## Decision

**One upgrade window per cluster**, which only starts when nothing is failing, and goes one node at a time, oldest first:

1. **Ready:** every node on the latest 8.4 (BossMox's Update all nodes does that), the checker's `--full` run clean of failures, at least 5 GB free on root, the cluster healthy, recent backups. The checker only reads, so BossMox runs it whenever the window opens and shows each finding in plain words with its fix.
2. **Per node:** move guests off (ADR 0025; moving to a node already on the new version is fine, never back to an older one), apply the fixes that keep it reachable, switch its sources, upgrade, re-run the checker, reboot, wait, confirm it's on the new version and healthy. Guests come home only to nodes on the new version.
3. **Stop** works between steps, never in the middle of the package upgrade, which runs as its own job on the node like ADR 0027 and survives a closed console.

**Rocky's decisions (2026-11-13):**

- **Config-file questions are answered unattended** ("unattended would probably be the better option"), following Proxmox's guidance for each file, and every choice is reported per node. dpkg's `--force-confdef --force-confold`, which updates already use, does exactly that: a file nobody changed gets the new version without a question, and a changed one keeps the old version with the new one beside it (`.dpkg-dist`). Files handled by `ucf` (GRUB's defaults among them) need `UCF_FORCE_CONFFOLD=1` as well, and `apt-listchanges` must not page (⚠️ both to confirm on the lab).
- **Port names are always pinned** before each node's reboot ("I think we just always pin"), with Proxmox's `pve-network-interface-pinning`, which is already on 8.4. **Found on the lab (2026-11-13):** the tool only knows its own `50-pve-*.link` files. cloud-init's `/etc/systemd/network/10-eth0.link`, which names the first port by MAC, sorts first and wins, so after the restart the bridge pointed at `nic0`, which never appeared, and the node came back without its main network (reachable only over its second port). A pin made by hand would do the same. So BossMox asks udev, in its read-only test mode, which file names each port; it pins only ports named by the default rules, one at a time (`--interface`); then asks udev again, and if any pinned port doesn't resolve to the new file, takes this run's pins and the pending network config back out before anything can restart. A port another file already names keeps that name: it's already safe from a kernel rename. Proven on the lab: only `ens19` was pinned (to `nic0`), `eth0` kept its name, and after a restart the node was back in 33 seconds with its main network, the heartbeat on `nic0` and both corosync links connected.
- **Ceph below Squid 19.2 is refused**, with the reason, and the Ceph upgrade stays in Proxmox's interface. Upgrading Ceph isn't on the roadmap ("refuse until Ceph is on Squid, we can add that Ceph upgrade is not on the roadmap at this time").

**Keeping people informed** (Rocky: "looking at release notes for gotchas - keeping the user informed about update options and EOL notices etc"):

- **End of life in Health check:** a notice six months ahead, a warning once past. Dates come from Proxmox's FAQ table, kept in BossMox and refreshed with each BossMox release, since Proxmox publishes them nowhere a program can read.
- **The new version's known issues**, kept per Proxmox version in BossMox and matched to the cluster: shared LVM (autoactivation migration, strongly recommended by Proxmox), `/etc/sysctl.conf` settings that stop being read, containers too old for cgroup v2, passthrough VMs, third-party storage plugins. Each shows before the window starts, with Proxmox's fix where there is one.

## Build order

Each piece is proven on the lab before the next starts, read-only first.

1. End-of-life notices in Health check.
2. Readiness: the checker run and read, BossMox's own checks, the known issues matched to the cluster.
3. The fixes that keep a node reachable: pinning, GRUB on UEFI with LVM, removing the `systemd-boot` meta-package, LVM autoactivation migration, moving `sysctl.conf` settings. Each is its own confirmed action.
4. The source switch for one node, with a way back.
5. The upgrade of one node: package upgrade, checker, reboot, verify.
6. The cluster run: moves, one node at a time, Stop, mixed versions.
7. Proof on bmx8lab from 8.4 to 9 (three nodes, an HA guest, shared LVM over iSCSI like Rocky's cluster), again from its snapshots, and on the two-node bmx2lab.

## Consequences

- A node mid-upgrade can't be updated normally (ADR 0039) until this run finishes it.
- What a nested lab can't show is said in the release notes: real hardware port renames, UEFI-on-LVM boot, Ceph, passthrough.
- The tables of end-of-life dates and known issues need updating with each Proxmox major release. A BossMox that hasn't been updated says it doesn't know the newer version, rather than guessing.

## Found on the lab, piece 5 (2026-11-16)

- **What stops an upgrade is what BossMox's explainer marks 'blocks', not Proxmox's raw failure count** (Rocky, 2026-11-16). The 9 checker fails with "unable to determine installed intel-microcode version" wherever that package is missing, which is every VM; 8.4's only warned. It is shown as advice. Any failure BossMox can't read, or doesn't know, still blocks.
- Proxmox 9's pinning tool names its files `50-pmx-<name>.link` (8.4: `50-pve-`). The upgrade pins after the 9 packages are in, so both count as Proxmox's own pin.
- Debian's unattended-upgrades can hold the package lock just after a node starts; apt waits up to 10 minutes for it.
- Proven on bmx8-node2 from the browser: 8.4.21 to 9.2.28, kernel 7.0.14, ens19 pinned to nic0 with its heartbeat address kept, cluster quorate.
- Not handled yet: a node whose packages are on 9 but that hasn't restarted reports 9, so Upgrade won't start again on it and the readiness check runs a checker that doesn't exist. Piece 6 finishes such a node.

## Found building piece 6 (2026-11-16)

- The cluster upgrade is a third kind of run on the same runner as Update all nodes (ADR 0027), not a separate one: it inherits the per-guest choices, placement, Stop, coming home and the record on disk. The one-node upgrade replaces that run's install and restart steps.
- A node whose packages are on the new version but which still runs the old version's kernel counts as unfinished, read from Proxmox's `apt/versions` (`RunningKernel` against the newest installed kernel of another series). The run takes such a node first and finishes it without installing again. A newer kernel of the same series is an ordinary update waiting for a restart, not this.
- The run starts only for root@pam with a readiness check from the last hour that found nothing blocking.
- Proven on bmx8lab from a mixed cluster (one node already on 9): the other two went 8.4.21 to 9.2.28, with BossMox itself and an HA guest moved off and back.

## Proven from 8.4, piece 7 (2026-11-16)

- bmx8lab (three nodes, HA guest, shared LVM over iSCSI) went from 8.4.21 to 9.2.28 entirely from the browser, in two runs: Stop pressed while the second node upgraded let that node finish and stopped before the third; a second run upgraded the third.
- bmx2lab (two nodes and a tie-breaker vote) went from 8.4.21 to 9.2.28 in one run; the vote held quorum while each node restarted.
- After Stop, guests stay where they are; they are not brought home. Decided (Rocky, 2026-11-16): keep it that way, because Stop usually means something looks wrong and BossMox shouldn't keep moving guests after it. The plan screen now says so, and points to Move everything back. It applies to all three kinds of run, which share the runner.
- The node's version in the upgrade window counts only an upgrade that ended after the readiness check: the run's record stays on disk and would otherwise show an old version.
