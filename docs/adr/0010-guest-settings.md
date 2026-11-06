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

## Not offered

Hook scripts, raw QEMU arguments, PCI and USB passthrough, cloud-init, and hotplug choices. Passthrough and cloud-init need their own screens. Changing a container's system or privilege type isn't offered because they can't change after it's made.

## Not tested live

An installed Windows or Linux guest surviving a change of machine type or controller. The test VMs have no operating system, so those were tested as saved values only.
