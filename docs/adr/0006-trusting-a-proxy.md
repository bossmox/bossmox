# ADR 0006: A proxy is trusted only when named, and sign-in limits are per address and per account

Date: 2026-11-06. Status: accepted.

## Decision

`X-Forwarded-For` is read only when the connection comes from an address listed in `BOSSMOX_TRUSTED_PROXY`, and it's read from the right, skipping trusted proxies. Sign-in attempts are limited to 10 per client address and 50 per account in 5 minutes, and each attempt counts before Proxmox answers.

## Why

- Without this, everyone behind a proxy shares one address, so one person's failed sign-ins lock out everybody.
- That header is plain text a client can write, so believing it from anyone would let an attacker pick a new address per guess. Reading from the right matters for the same reason: the proxy appends the real address, and anything to its left came from the client.
- Limiting by address alone lets someone with many addresses keep guessing. Limiting by account alone lets anyone lock `root` out from one machine. So an IPv6 /64 counts as one client, and an address that has signed in as an account skips that account's limit, which keeps someone's usual machine working during an attack. That list lives in memory, so it empties on a restart.
- Counting after Proxmox answers meant a burst sent at once all passed the check.

## What this costs

- Someone with more than 5 separate addresses can still hold an account out for 5 minutes from any address it hasn't signed in from. Proxmox's own console is unaffected.
- Attempts that time out after connecting count as guesses, because they may have reached Proxmox. Attempts that never connected, or that Proxmox answered with an error of its own, don't.
