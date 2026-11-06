# 8. Guest hardware: what the screens allow and refuse

Date: 2026-11-06. Status: accepted.

## Decision

- The boot disk can't be removed from BossMox. A container's root disk and the first non-disc disk in a VM's boot order count as the boot disk.
- Removing a disk erases it. BossMox clears the leftover `unused` entry so no orphan is left behind, and asks for the typed word `erase`.
- Disks only grow. Shrinking isn't offered because Proxmox doesn't support it safely.
- New disks and network cards copy the type the guest already uses, so a Windows guest doesn't get hardware it has no driver for.
- Clones are always full copies. Linked clones tie the copy to its template forever, which is a surprise to anyone who later deletes the template.
- Containers can't be cloned while running, because Proxmox refuses unless a snapshot is used. BossMox says to shut it down first rather than taking a hidden snapshot.
- ISO uploads stream straight through to Proxmox. The BossMox VM has 256 MB of memory and a small disk, so nothing is buffered.
- Templates are listed alongside guests, and raise no "worth a look" advice because they never run.

## Found while testing

- `/cluster/resources` lags a new guest by several seconds, so a guest's own config supplies its name and template flag when the list hasn't caught up.
- Changes that aren't tasks (adding a disk or card) never cleared the overview cache, so the screen showed the old state. Actions with no task now clear it.
- Proxmox pauses a running VM for a few seconds at the start of a clone on `local` storage, and `paused` read as "Shut down" with a Start button. Paused now counts as on.

## Not tested live

Guest addresses from a VM with the guest agent, because the test VMs have no operating system. The no-agent message and container addresses were tested.
