# ADR 0006: A proxy is trusted only when named, and sign-in limits are per address and per account

Date: 2026-11-06. Status: accepted.

## Decision

`X-Forwarded-For` is read only when the connection comes from an address listed in `BOSSMOX_TRUSTED_PROXY`, and it's read from the right, skipping trusted proxies. Sign-in attempts are limited to 10 per client address and 50 per account in 5 minutes, and each attempt counts before Proxmox answers.

## Why

- Without this, everyone behind a proxy shares one address, so one person's failed sign-ins lock out everybody.
- That header is plain text a client can write, so believing it from anyone would let an attacker pick a new address per guess. Reading from the right matters for the same reason: the proxy appends the real address, and anything to its left came from the client.
- Limiting by address alone lets someone with many addresses keep guessing. Limiting by account alone lets anyone lock `root` out from one machine. With both, one address can't reach the account limit.
- Counting after Proxmox answers meant a burst sent at once all passed the check.

## What this costs

- Someone with more than 5 addresses can still lock an account out for 5 minutes. Proxmox's own console is unaffected.
- Attempts that time out count as guesses, because they may have reached Proxmox. Attempts refused at the connection don't.
