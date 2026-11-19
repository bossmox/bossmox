# Ceph and the upgrade

## What it is

Ceph is storage spread across the nodes, built into Proxmox. When Ceph is set up on the cluster, Proxmox VE 9 needs it on Ceph 19.2 (Squid) **before** the upgrade, and the checker also asks Ceph for its state.

The checker fails when Ceph is older than Squid, or when Ceph doesn't answer. That can mean two different things:

- **The cluster keeps data in Ceph**, and Ceph is old or down.
- **Ceph was set up once and never used.** Its packages and settings are still there, so the checker treats the cluster as running Ceph, and the monitor it asks no longer exists.

## If you leave it

BossMox won't start the upgrade while these failures stand.

## What BossMox does

BossMox doesn't upgrade or remove Ceph. To tell which case you have, look in BossMox's **Storage**: if no storage shows as Ceph or CephFS, nothing keeps data in Ceph.

**If Ceph holds data**, upgrade it to Squid in Proxmox's own interface first, following Proxmox's Ceph upgrade guide.

**If nothing uses it**, the leftover can be removed. These are the steps proven on a test cluster with the same failures. They need a root shell on each node, one node at a time:

1. `pveceph purge --crash --logs`
2. Remove the Ceph server packages, not the client libraries Proxmox needs: `apt-get purge ceph ceph-base ceph-mon ceph-mgr ceph-mgr-modules-core ceph-osd ceph-mds ceph-volume`. Try it with `-s` first: it should list only those packages.
3. Once for the cluster, keep a copy of `/etc/pve/ceph.conf`, `/etc/pve/priv/ceph.*` and `/etc/pve/ceph/`, then remove them, and remove `/etc/ceph/ceph.conf` on each node.

Then run the checker again: its Ceph section should be skipped.

**Ceph's 'noout' flag** (a warning) stops Ceph copying data between nodes while one restarts. It only matters if Ceph holds data.

## Is it safe?

Removing Ceph is only safe when nothing uses it: check first. On the test cluster, guests kept running throughout and no restart was needed.

## Proxmox's own page

[Prerequisites](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Prerequisites), [Update the Ceph Package Repository](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Update_the_Ceph_Package_Repository), and [pveceph](https://pve.proxmox.com/pve-docs/pveceph.1.html)
