# 13. Choosing the update channel

Date: 2026-11-09. Status: accepted.

## Why

A fresh Proxmox install points at the paid (enterprise) update channel, for both Proxmox and Ceph. Without a subscription every check for updates fails with `401 Unauthorized`, and Proxmox's own screen only shows the files. It's the first thing new users search for. BossMox already named the channel; now it can change it. First item of the first-release build order (`ROADMAP_FIRST_RELEASE.md` in the vault).

## Decision

- **Two channels are offered: Free and Enterprise.** Free is Proxmox's no-subscription channel, Enterprise needs an active subscription and BossMox refuses it without one. The test channel stays in Proxmox's interface: it isn't for anyone who'd need BossMox to set it.
- **Ceph follows Proxmox.** A fresh install also has Ceph's paid source turned on, even when Ceph isn't used, and it alone makes every check fail. Switching swaps each Ceph release's source for the same release on the new channel. A node with no Ceph source gets none.
- **Add first, then turn off.** The new channel is added before the old one is turned off, so a failure part way leaves both on, which still downloads, never neither.
- **Only Proxmox's standard calls.** Adding uses the API's standard handles (`no-subscription`, `ceph-squid-enterprise`...), which also turn back on a source that's present but off. Turning off uses the API's enable flag, so the files stay where they are and can be turned back on. BossMox never writes source files itself. Every change carries Proxmox's digest, so a change made somewhere else at the same moment is refused, not overwritten.
- **Only Proxmox and Ceph sources are touched.** Debian's sources and anything else someone added stay as they are.
- **It ends with a check for updates,** shown as the task, so the person sees straight away whether downloads work now.
- **Plain words for the half-broken case.** With the free channel on and Ceph's paid source still on, updates do download (13 listed in the lab), but every check ends in an error. The screen says that, rather than "can't download".
- Per node, from the node's screen, because each node has its own sources. Proxmox needs Sys.Modify on the node; without it the person gets Proxmox's refusal in plain words.

## Plan

1. Pure functions: what to add and what to turn off, given Proxmox's answer and the target. Tested against the real answer captured from a lab node.
2. One named action, `update-channel`, with the target as its only input.
3. The Overview's warning gets a button; the Updates tab's channel line gets one when a switch makes sense.
4. Lab: put a test node back to a fresh install's sources, switch from the browser, check the files and that the update check finishes clean. Then switch back to make sure nothing is left behind.

## Found while building

- Measured on a lab node set to a fresh install's sources (copied from the Tiny's originals): `apt-get update` fails on both paid sources. Adding `no-subscription` creates `proxmox.sources`; adding it again changes nothing; adding it while it's present but off turns it back on. A stale digest is refused with "detected modified configuration". The Ceph free source is added to `ceph.sources` as a second entry.
