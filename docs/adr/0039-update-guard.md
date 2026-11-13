# 0039: Updates refuse a node whose sources point at another release

**Date:** 2026-11-13. **Status:** accepted 2026-11-13 (Rocky). Issue #94, 0.2.1.

## Context

Update all nodes and the Install updates button run `apt-get dist-upgrade` (ADR 0027) with whatever update sources a node has. While those sources name the Debian release the node runs, that stays inside its Proxmox version. Once someone points them at the next release (for example `trixie` on a Proxmox 8 node that runs `bookworm`), the same update carries out the whole major upgrade, unattended: no `pve8to9` check, every config question answered "keep the old file". Proxmox says to run that upgrade by hand, one node at a time. Major upgrades are planned for 0.3.0 (#95).

## Decision

Rocky: "if the repos are not pointed at repos for the currently installed version, it would refuse to run - that stops it in perpetuity and forces using the actual Upgrade tool". Only the sources a Proxmox upgrade depends on count: Debian's and Proxmox's own (Ceph included). Others, such as Docker's, are ignored, so one left on an older release never blocks updates.

- **Proxmox does the comparing.** `GET /nodes/{node}/apt/repositories` already checks every source's suite against the release the node runs and lists each mismatch in `infos` (property `Suites`, kind `warning`, or `ignore-pre-upgrade-warning` for the next release). It also names each source's origin: `Debian` or `Proxmox`, read from the downloaded lists, or from the address when there are none. BossMox refuses a node when any enabled Debian or Proxmox source has such a flag, and shows Proxmox's own wording. BossMox keeps no table of versions, so the guard needs no change for 9 to 10. Read from `proxmox-apt` (`check_suites`, `origin_from_uris`), 2026-11-13.
- **A source switched but not yet downloaded still counts:** an address on `debian.org` or `proxmox.com`, or Debian's `mirror+file:///etc/apt/mirrors/debian*`, is treated as Debian or Proxmox even without an origin.
- **Fails closed.** Sources BossMox can't read, or files Proxmox couldn't parse, refuse the node with the reason.
- **One check, every path:** the run plan (before any guest moves), again right before each node installs (the sources can change during a long run), and the single-node Install updates button.

## Consequences

- A node mid-way through a hand upgrade, or with sources switched early, can't be updated from BossMox until the upgrade is finished or the sources are put back. That's the point.
- A source Proxmox flags for another reason in the same property (a Debian security source with the wrong suffix) also refuses. Rare, and Proxmox's wording says what to fix.
- **Proof:** unit tests from Proxmox's real response shape; on an 8.4 lab node with its sources switched to trixie, the run and the button must refuse it, then run once the sources are back.
