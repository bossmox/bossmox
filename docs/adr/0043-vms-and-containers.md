# 0043: VMs and containers, side by side

**Date:** 2026-11-18. **Status:** accepted (Rocky: "Nowhere on the home screen does it mention containers"; picked "VMs and Containers" and "Create" over "Guests" and "Machines"; "we need to be able to sort/filter by VM vs Container and maybe each needs its own icon to show which is which"). Issue #107.

## Context

BossMox has managed containers since the first milestone, in the same screens as VMs: create from a template, start and stop, console, settings, snapshots, clone, move, back up and restore, and change the address (ADR 0024). But the home screen said "Virtual Machines" and "Create a VM", the list didn't mark which guest was which, and a container's Technical details showed a VM's machine type, firmware, disk controller and CPU model, all "(default)". Someone with containers had no sign BossMox handled them.

## Decision

- The apps are called **VMs and Containers** and **Create**. "Guests" is Proxmox's word but few people use it; "Machines" still doesn't say container.
- Each row in the list has a small type icon (a screen for a VM, a box for a container), drawn like the app glyphs, with the type as its accessible name. The detail pane says "Virtual machine" or "Container" under the name.
- The list gets a **type filter** (VMs and containers, VMs only, Containers only) and a **sort** (name, type, node). They combine with the node filter, the All / Running / Needs a look buttons and the search. Name order breaks every tie, and names sort with numbers as numbers (web9 before web10).
- The type and sort are remembered per browser, like the look. A stored value the list doesn't offer falls back to the default. Opening a guest from elsewhere (Health check, after Create) shows every type for that visit, so the guest is never hidden from the list.
- The filter and sort live in `public/guest-list.js`, a plain script loaded before `app.js`, so the tests run the same code the page does (in Node's `vm`, as a script, not a module).
- Wording that covers both says so ("VMs and containers", or no noun: "moves"). VM-only wording stays: the guest agent, Force BIOS and the boot menu, installer discs, NUMA, and the BossMox VM itself.
- A container's Technical details show its Container ID only.

## Consequences

- No new container features in 0.3.1. What containers still can't do from BossMox (firewall, moving a disk to another storage, suspend) is on the coverage checklist like any other operation.
- `public/guest-list.js` is a new file the server serves and the release carries. The linter can't see that `app.js` uses its functions, so `biome.json` turns off the unused-variable rule for that one file.
- The README's desktop and Create screenshots show the new names.
