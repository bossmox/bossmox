# 23. The installer asks for BossMox's own address

Date: 2026-11-09. Status: accepted. Item 7 of the first-release build order, first half. Rocky (2026-11-09): "updating/changing IP information is crucial".

## Why

A plain install took an address from DHCP. That address can change after a restart, which breaks the bookmark and makes the certificate name wrong. A fixed one needed `--ip` and `--gateway`, which a new user won't know to add.

## Decision

- Run by hand (stdin is a terminal) without `--ip` or `--yes`, `install.sh` asks for a fixed address before its usual summary and "Go ahead?". Pressing Enter keeps the automatic address, with a line saying it can change after a restart.
- Defaults come from the node: without a VLAN, BossMox sits on the node's own network, so a plain address gets the node's network size (from its bridge address) and the gateway prompt is filled with the node's default gateway. With `--vlan`, nothing is guessed: the network size defaults to /24 unless typed, and the gateway must be typed.
- Refused, with a plain reason, and asked again: anything that isn't four numbers up to 255, a network size outside /8 to /30, the node's own address, an address that answers a ping, and a gateway outside the address's network. Five tries, then it stops and points to `--ip`.
- A ping that gets no answer doesn't prove an address is free (some devices ignore pings, and something switched off answers nothing). The prompt asks for an address nothing else uses; the ping check catches the common mistake.
- The summary shows the gateway as well as the address.
- Piped input, `--yes` and `--ip` behave exactly as before, so scripts and the README's option form don't change.

## Not done

The setup wizard's "Keep this address" (pinning a DHCP address from the browser), and moving BossMox to a new address later. Both remain on the build order.

## Tested

On bmx-solo, run through a terminal as a person would: an address already in use (BossMox's own VM), the node's address, `999.1.1.1`, and a gateway on another network were each refused with their reason; then `10.0.30.238/24` with the offered gateway produced the summary "vmbr0, 10.0.30.238/24, gateway 10.0.30.250", and answering no changed nothing. Enter gave "address from DHCP". Piped input wasn't asked. A full install with `10.0.30.238` and the offered gateway made VM 101 with `ip=10.0.30.238/24,gw=10.0.30.250`, its setup page answered at that address, and still did after the VM restarted. That VM was then removed.
