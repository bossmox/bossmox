# Roadmap

What's coming to BossMox, in plain words. Each theme is a [GitHub milestone](https://github.com/bossmox/bossmox/milestones), and each item is an issue you can follow or comment on. There are no dates: a release ships when its whole theme is done and tested on a real cluster.

## Next: [Cluster resilience](https://github.com/bossmox/bossmox/milestone/1) (0.1.9)

Next release. Keeping a cluster running through a failure, and hearing about it when something goes wrong.

- [Heartbeat backup link](https://github.com/bossmox/bossmox/issues/31)
- [Keep this guest running (HA)](https://github.com/bossmox/bossmox/issues/32)
- [Tie-breaker for two-node clusters](https://github.com/bossmox/bossmox/issues/33)
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

### [Releases and support](https://github.com/bossmox/bossmox/milestone/4)

How BossMox is delivered and supported.

- [Signed releases](https://github.com/bossmox/bossmox/issues/39)
- [Donate link](https://github.com/bossmox/bossmox/issues/40)

Released work is in the [release notes](https://github.com/bossmox/bossmox/releases), and the reasoning behind each decision is in [docs/adr](docs/adr).
