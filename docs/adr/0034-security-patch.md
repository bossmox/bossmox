# 0034: 0.1.10, the second review's remaining security gaps, and patch numbers

**Date:** 2026-11-12. **Status:** accepted.

## Context

The second outside review of 0.1.9 left a few smaller security gaps, kept private until a release carried the fix. Every release so far bumped the last version number, features included, so there was no number left for a fix-only release.

## Decision

- **Version numbers are major.minor.patch.** Fixes to a released version bump the last number; significant new features bump the middle one. 0.1.10 is the first release that's a patch by intent, and cluster resilience becomes 0.2.0. There is never a fourth number: the update check compares three, and every install already out there runs that check.
- **Seeing every guest** (used before erasing a disk or deleting from storage) now needs VM.Audit on `/vms` and on every narrower guest or pool path the account has. A NoAccess on one VM or pool used to pass, because only `/vms` was read.
- **Usernames** of other people no longer show in the guests-away list, a run's Stop note, or the "only the person who started it can stop it" message, unless the viewer can change the whole cluster.
- **Setup sign-in:** a sign-in still waiting on Proxmox when someone enters the setup code again is refused, instead of landing after the reset with its password.

- **Console commands never page.** Found on a real cluster the day 0.1.9 shipped: Update all nodes installed on the first node in seconds, then waited, because the install's journalctl opened a pager in the node's console and the done line never printed. Each node would have waited out the 45-minute limit. Every command BossMox types now starts with the pagers off, and the install's journalctl has `--no-pager`.

## Not done

- The storage-erase check still relies on the space allowance for a ZFS dataset made outside Proxmox's storage list; the 120-second storage-setup list and by-ID alias matching are unchanged. Next patch.
- Route and action tests against the fake Proxmox. Next patch.

## Tests

Each fix has a test that fails on 0.1.9 (checked by running the new tests against the old source).
