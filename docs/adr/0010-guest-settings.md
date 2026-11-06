# 10. Guest settings are the whole Settings tab

Date: 2026-11-06. Status: accepted.

## Decision

- The Settings tab is the form, replacing a read-only table with a small button and a dialog that covered only name, cores, memory, start at boot, disc and agent.
- Only what changed is sent. Sending every field made every save look like a change to Proxmox.
- A named list of settings is accepted, each checked for its own shape, so a request can't set something like a hook script.
- Options the form doesn't show (CPU flags, display memory, agent options, IOMMU, start delays, other container features) are carried over, not lost.
- Clearing a value removes it from the config, so it falls back to Proxmox's default instead of saving a blank.
- Firmware, machine type and disk controller ask first, because each can stop an installed system from starting.
- Firmware can only change while shut down. Switching to UEFI adds the small settings disk UEFI needs, on the same storage as the system disk.
- Asking for more cores than the node has is refused at save. Proxmox saves it, then refuses to start the guest.
- Changes a running guest can't take straight away show in a "Waiting for a restart" notice above the tabs, read from Proxmox's own pending list.
- The disc drive moved to the Hardware tab, where it sits with what it is.

## Boot menu button

Proxmox has no "force BIOS setup on next boot" setting, so BossMox presses the key itself. **Force BIOS** is on the console bar for running VMs, and **Boot menu** is on a shut-down VM's page, greyed out while it runs.

- A running VM gets a hard reset, after asking, because a soft restart depends on the system inside.
- A shut-down VM is started, given 8 seconds, then reset. Proxmox doesn't answer reliably for a VM that's only just started, and key timing is only dependable after a reset.
- BIOS opens its menu on Esc and also closes it on Esc, so it gets exactly one press, 1.5 seconds after the reset. One press landed anywhere from 0.5 to 3 seconds after a reset.
- UEFI ignores repeats of F2, so F2 is pressed about every 1.2 seconds for 8 seconds.

The first version pressed Esc repeatedly. It passed on test VMs with nothing bootable, then failed for Rocky 4 out of 4 times on a VM with a real system, because the next Esc closed the menu and it carried on from disk. Test boot behaviour on something that can actually boot.

Results through the app on bootable test VMs: running BIOS 5 of 5, running UEFI 5 of 5, shut-down BIOS 5 of 5, shut-down UEFI 5 of 5. A shut-down VM takes about 10 seconds on BIOS and 18 on UEFI to reach the menu.

## Not offered

Hook scripts, raw QEMU arguments, PCI and USB passthrough, cloud-init, and hotplug choices. Passthrough and cloud-init need their own screens. Changing a container's system or privilege type isn't offered because they can't change after it's made.

## Not tested live

An installed Windows or Linux guest surviving a change of machine type or controller. The test VMs have no operating system, so those were tested as saved values only.
