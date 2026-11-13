# Roadmap

What's coming to BossMox, in plain words. Each theme is a [GitHub milestone](https://github.com/bossmox/bossmox/milestones), and each item is an issue you can follow or comment on. There are no dates: a release ships when its whole theme is done and tested on a real cluster.

Version numbers: fixes to a released version bump the last number; new features bump the middle one (0.2.x to 0.3.0). 1.0 is the first release called stable.

## Next: [Proxmox upgrades](https://github.com/bossmox/bossmox/milestone/8) (0.3.0)

Upgrade a cluster to the next major version of Proxmox VE (for example 8 to 9) from BossMox, one node at a time, without Proxmox's own interface or a shell. BossMox runs Proxmox's upgrade checker and explains what it finds, moves guests off each node before it upgrades, and keeps the cluster working while some nodes are on the old version and some on the new.

Since 0.2.1, a normal update already refuses a node whose sources point at the next release, so an upgrade only ever happens on purpose.

- [Upgrade to the next major version of Proxmox VE](https://github.com/bossmox/bossmox/issues/95)

## Later, in no particular order

### [Addresses](https://github.com/bossmox/bossmox/milestone/2)

Changing addresses safely from BossMox, with a way back if the change cuts the connection.

- [Keep this address, in setup](https://github.com/bossmox/bossmox/issues/35)
- [Change a node's, BossMox's or a VM's address](https://github.com/bossmox/bossmox/issues/36)

### [Hardware and nodes](https://github.com/bossmox/bossmox/milestone/3)

More hardware a guest can use, and growing the cluster after setup.

- [USB passthrough](https://github.com/bossmox/bossmox/issues/37)
- [Add a node after setup](https://github.com/bossmox/bossmox/issues/38)

### [Code structure](https://github.com/bossmox/bossmox/milestone/6)

Splitting the browser app into modules.

- [Split public/app.js into modules](https://github.com/bossmox/bossmox/issues/60)

### [Releases and support](https://github.com/bossmox/bossmox/milestone/4)

How BossMox is delivered and supported.

- [Signed releases](https://github.com/bossmox/bossmox/issues/39)
- [An image for running BossMox on your own computer (VirtualBox, maybe Hyper-V)](https://github.com/bossmox/bossmox/issues/97)

Email alerts, the update guard and the sponsor link shipped in [0.2.1](https://github.com/bossmox/bossmox/releases/tag/v0.2.1-preview), and cluster resilience in [0.2.0](https://github.com/bossmox/bossmox/releases/tag/v0.2.0-preview). Next: Proxmox upgrades in 0.3.0. Released work is in the [release notes](https://github.com/bossmox/bossmox/releases), and the reasoning behind each decision is in [docs/adr](docs/adr).
