# ADR 0005: Restore makes a copy by default, and Network starts read only

Date: 2026-11-06. Status: accepted.

## Decision

Restoring a backup creates a new, switched-off guest named `<name>-copy`, on the server that holds the backup. Replacing the original is a separate step: the guest must be shut down, must be on the same server as the backup, and the person types `replace`.

The Network app shows each server's switches, ports, addresses and which guests use them. It can't change anything yet.

## Why

- A copy can't lose anything. Someone restoring is often already having a bad day, so the first button shouldn't be able to make it worse.
- Proxmox would erase and rebuild the guest on one call, with no undo. That deserves more friction than a normal confirmation.
- A backup on a server's own storage can only be restored on that server, so BossMox says so instead of letting Proxmox fail partway.
- One wrong network change can cut a server off from BossMox, which is the tool you'd use to fix it. Proxmox's own pending-changes step doesn't protect against that. Editing needs a safety net, such as automatically undoing a change if the server can't be reached afterward, which needs its own design and tests.

## What this costs

- Restoring as a copy needs enough room for a second guest, and two guests with the same address could collide if the copy is started on the same network.
- Network changes still happen in Proxmox's own interface for now.
