# ADR 0004: Rolling updates are guided, and a person approves each install

Date: 2026-11-06. Status: accepted.

## Decision

Update all servers works through a cluster one server at a time, oldest Proxmox version first. For each server, BossMox opens the normal updater for a person to approve. If the updates include a kernel, it first moves running guests off, then restarts the server once nothing is left to install and moves the guests home. Without a kernel update, guests stay put and nothing restarts. It checks the cluster before each server. Any failure stops the run and leaves later servers untouched.

The run is the guided restart with two extra phases, kept in the same saved plan, so it carries on after a page reload.

## Why

- Proxmox has no API call that installs updates. Its only route is the `upgrade` terminal, the same one its own interface uses.
- That updater can stop to ask about changed config files. Sending Y on someone's behalf could answer a question nobody read, on the servers that run everything else.
- Guests should only move to the same or a newer version. Going oldest first, and preferring a finished server as the move target, keeps to that.
- Sending guests home before the next server means only one server is ever out of normal service.

## What this costs

- A person has to stay at the screen, once per server. An unattended run would need its own design for those config questions.
- The run is driven by the open browser page. If the page closes, the current step's Proxmox work finishes, but the next step waits until the page is opened again.
- Servers with nothing to install are skipped, so a server waiting only for a restart isn't picked up.

## Votes

A cluster with fewer than three votes can't make changes while a server is down. That gets a warning, not a refusal: its guests keep running, and a two-server home cluster may have no third vote to add.
