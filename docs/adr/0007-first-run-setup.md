# ADR 0007: First-run setup needs a code from the VM's console

Date: 2026-11-06. Status: accepted, not built.

## Decision

A fresh BossMox starts in setup mode, which serves only a wizard. The first step is a one-time code shown on the VM's console. The wizard then takes one Proxmox address, has the person confirm its certificate fingerprint, and has a Proxmox admin sign in. BossMox finds the other nodes from the cluster, saves its own settings, and locks setup for good. One BossMox manages one cluster.

## Why

- Before setup, BossMox has no Proxmox to check anyone against. If whoever reached it first could finish setup, they could point it at a fake Proxmox and collect the real admin's password at the next sign-in.
- Anyone who can read the VM's console already controls that VM, so the code proves the one thing setup needs to know.
- Asking for one address and finding the rest means nobody types a node list that goes stale.
- Showing a fingerprint means trust in Proxmox's certificate is a decision someone made, not a blind first connection.
- Managing several clusters would change sign-in, sessions and most screens. One cluster now doesn't rule that out later.

## What this costs

- The person needs console access to the VM once. The Proxmox console is enough.
- BossMox has to write its own settings, where today it only reads them.
- This is the one route open before anyone signs in, so it needs its own independent review.
- Self-signed setup still relies on someone actually comparing a fingerprint.

## Detail

The stages and what's still to check are in the project's plan, `PLAN_FIRST_RUN_SETUP.md`, which lives outside this repo.
