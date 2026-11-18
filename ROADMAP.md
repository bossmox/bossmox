# Roadmap

What's coming to BossMox, in plain words. Each theme is a [GitHub milestone](https://github.com/bossmox/bossmox/milestones), and each item is an issue you can follow or comment on. There are no dates: a release ships when its whole theme is done and tested on a real cluster.

Version numbers: fixes to a released version bump the last number; new features bump the middle one (0.2.x to 0.3.0). 1.0 is the first release called stable.

## Next: [VMs and containers](https://github.com/bossmox/bossmox/milestone/9) (0.3.1)

BossMox already manages containers in the same screens as VMs, but the home screen only ever said "VM". The app becomes VMs and Containers, every guest shows whether it's a VM or a container, and the list filters and sorts by type.

- [Show and filter by type](https://github.com/bossmox/bossmox/issues/107)

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

Upgrading Ceph isn't on the roadmap at this time. A cluster that uses Ceph needs Ceph Squid (19.2) before it can upgrade to Proxmox VE 9; BossMox says so and stops, and Ceph is upgraded in Proxmox's own interface.

Proxmox upgrades (8 to 9) shipped in [0.3.0](https://github.com/bossmox/bossmox/releases/tag/v0.3.0-preview), email alerts, the update guard and the sponsor link in [0.2.1](https://github.com/bossmox/bossmox/releases/tag/v0.2.1-preview), and cluster resilience in [0.2.0](https://github.com/bossmox/bossmox/releases/tag/v0.2.0-preview). Released work is in the [release notes](https://github.com/bossmox/bossmox/releases), and the reasoning behind each decision is in [docs/adr](docs/adr).
