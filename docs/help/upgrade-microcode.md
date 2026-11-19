# Processor microcode package

## What it is

Microcode is a small update for the processor itself, loaded each time the node starts. Intel and AMD release it to fix security problems and serious processor bugs. Debian ships it as `intel-microcode` or `amd64-microcode`, in its firmware section, which isn't turned on by default.

## If you leave it

The node keeps working and the upgrade goes ahead. The processor runs with the microcode its firmware (BIOS) carries, without the newer fixes. Proxmox VE 9's checker counts it as a failure; BossMox shows it as advice, because it says nothing about whether the upgrade will work.

## What BossMox does

Nothing yet: BossMox doesn't install it. On a virtual machine (a test node, for example) the package does nothing.

## Is it safe?

Installing it is safe any time. It only takes effect after the node restarts, so the upgrade's own restart is a good moment.

## Proxmox's own page

[CPU Microcode Updates](https://pve.proxmox.com/wiki/Firmware_Updates#CPU_Microcode_Updates)
