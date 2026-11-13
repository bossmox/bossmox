# Roadmap

What's coming to BossMox, in plain words. Each theme is a [GitHub milestone](https://github.com/bossmox/bossmox/milestones), and each item is an issue you can follow or comment on. There are no dates: a release ships when its whole theme is done and tested on a real cluster.

Version numbers: fixes to a released version bump the last number (0.2.0 to 0.2.1); new features bump the middle one (0.1.x to 0.2.0). 1.0 is the first release called stable.

## Next: [Email alerts](https://github.com/bossmox/bossmox/milestone/7) (0.2.1)

0.2.0 sends Proxmox's alerts to ntfy, Discord, Slack, Teams or Gotify. 0.2.1 adds email.

- [Alerts by email](https://github.com/bossmox/bossmox/issues/34)

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
- [Donate link](https://github.com/bossmox/bossmox/issues/40)

Cluster resilience shipped in [0.2.0](https://github.com/bossmox/bossmox/releases/tag/v0.2.0-preview). Next: email alerts in 0.2.1. Released work is in the [release notes](https://github.com/bossmox/bossmox/releases), and the reasoning behind each decision is in [docs/adr](docs/adr).
