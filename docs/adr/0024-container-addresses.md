# 24. Changing a container's address

Date: 2026-11-09. Status: accepted. Part of item 8 of the first-release build order (guest addresses), taken as low-hanging fruit: containers only.

## Decision

- A container's network card on its Hardware tab shows its address (fixed with its gateway, or automatic) and a **Change address** button: Fixed (address with its network size, and the gateway) or Automatic. The window opens filled in with what's set now.
- Only containers. A container's IPv4 address is in its Proxmox settings (`ip=` and `gw=` on `netN`); a VM's is set inside the VM, which Proxmox can't change.
- Only `ip` and `gw` change. Everything else on the card stays as it was: name, MAC, bridge, VLAN, IPv6, firewall, limits. Going back to automatic removes the old gateway.
- Refused with the reason: an address without a network size or with numbers over 255, a size outside /8 to /32, a gateway that isn't an address, is the container's own address, or isn't on the address's network. An empty gateway is allowed, for a network with no router.
- **BossMox's own container is never changed from here.** If BossMox runs in a container (the LXC install), moving its address would cut off everyone using it, this page included. The server compares the container's set address and its live addresses with the network addresses BossMox answers on, leaving out loopback (127.0.0.1), which every guest also has.
- On a running container the change applies right away. The window says that connections to the old address are cut off, and, when it had an automatic address, that it keeps the old one too until it restarts (found in testing: Alpine's DHCP client holds its lease).
- Changing it is a settings change with the person's own rights in Proxmox (VM.Config.Network); the window names the container and the card.

## Not done

VM addresses (needs cloud-init or the guest agent), DNS servers for a container, IPv6, and checking the network for an address already in use (BossMox can't see the network from its own VM reliably). Node and BossMox address changes remain the risky part of item 8, with their own design.

## Tested

- Unit tests: the address is read for containers and not for VMs; a fixed address keeps every other part of the card; automatic drops the gateway; an empty gateway is allowed; each typo is refused with its reason; network maths for /23 and /24.
- Live on the test cluster with a temporary Alpine container (CT 960, removed after): the card read "automatic address"; a gateway on another network was refused with its reason; Fixed 10.0.30.237/24 via 10.0.30.250 finished, the card showed it, Proxmox's settings had `ip=10.0.30.237/24,gw=10.0.30.250` with the MAC, firewall and IPv6 unchanged, inside the container eth0 had 10.0.30.237 with the default route through 10.0.30.250, the node reached it, and it reached the gateway. It also still had its old automatic address until a restart, after which only 10.0.30.237 remained; the window now says so. The window reopened filled in; Automatic finished and the settings went back to `ip=dhcp` without a gateway.
- The first live run caught a bug the unit tests couldn't: every change was refused as "BossMox itself", because loopback counted as a shared address. Fixed and rerun.
- Not shown live: the refusal for BossMox's own container, since the test BossMox runs in a VM.
