# 11. One-command install

Date: 2026-11-06. Status: accepted, for testing. The public way to fetch it isn't settled.

## Decision

- `deploy/install.sh` runs as root on a Proxmox node and creates one small Alpine VM. It changes nothing else on the node.
- BossMox is written onto the VM's disk before its first boot, so the VM needs no SSH key and no way in from outside. The disk image is mounted on the node through a loop device.
- The VM finishes itself on first boot and removes the first-boot files afterwards.
- The guest agent is installed so the node can read the VM's address and setup code. That lets the installer print both, instead of sending people to the console. Whoever runs it is already root on the node, so this doesn't weaken the setup code.
- Storage defaults to whichever holds VM disks and has the most free space, and `--storage` overrides it. The address defaults to DHCP, and `--ip` with `--gateway` fixes it.
- `deploy/make-release.sh` publishes `install.sh`, `bossmox.tgz` and a checksum to a `release` branch.

## A node that moved networks

Found on the first real home node. Proxmox reports a node's address from `/etc/hosts`, and its certificate keeps the address it was made with, so a node moved to a new network reports a dead address and has a certificate that doesn't list the live one.

- The node BossMox signed in to keeps the address that was typed, because that one is proven to work. Other cluster members keep the address Proxmox reports.
- If a single node's certificate doesn't match that address, BossMox checks it against the node's name and saves that as `PVE_TLS_NAME`. Trust still comes from that node's own certificate authority, read over the fingerprint-pinned connection.
- A cluster gets no fallback, because `PVE_TLS_NAME` is one name and each node's certificate carries its own. Setup stops and says how to correct the address.
- Building a cluster on such a node isn't fixed by this: corosync would use the stale address. The node's `/etc/hosts` still has to be corrected first.

## Open

- A DHCP address that changes breaks sign-in, because BossMox allows only the address it was set up on. Use `--ip` or a DHCP reservation.
- How the public install command is delivered safely. A pasted `curl | bash` on a hypervisor still needs a decision.
- Root accounts with two-factor can't finish the wizard yet.

## Tested

On a fresh single-node Proxmox 9.2.26: refused bad options and a "no" cleanly, 99 seconds from nothing to ready on DHCP, wizard with Stay on one node, sign-in, and a VM restart. On a real single node at home with `--ip` on LVM-thin storage: 78 seconds, page up, first-boot files gone, other guests untouched. `--vlan` and ZFS storage weren't tried.
