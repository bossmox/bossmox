# 17. The health check

Date: 2026-11-09. Status: accepted. Item 3 of the first-release build order, in the preview release.

## Decision

- **One window, every check, the passes included,** so someone new sees what healthy looks like, not only what's wrong. Grouped as Nodes, Backups, Storage, Guests and BossMox. Problems first in each group. The desktop's "worth a look" panel links to it and keeps its own quick notices.
- **Each problem carries the fix BossMox already has:** Use the free channel, See updates, Protect everything, Add a NAS, Open Storage, See what happened (tasks), Start them at boot, Open the VM. Nothing new is invented as a fix; where the fix isn't built yet (a tie-breaker, keeping BossMox's address fixed), the text says what to do instead and that it's coming.
- **The checks:** nodes online; cluster votes (warned at two with no tie-breaker, bad when the majority is lost, not shown on a single node); update channel per node; updates waiting; guests not on a backup schedule; schedules saving to a node's own drives; backups failed in the last week; storage unreachable, 90% full (95% bad), or promised past its size; drives failing or with 10% life left; running guests that won't start after a restart; guests on slower disk or network settings; and BossMox's own address coming from DHCP, read from its VM's network file.
- **Start them at boot** is a new action that sets each named guest to start with its node. Nothing changes while they run.
- Everything is read in parallel and a part that can't be read is left out, so one slow node or a limited account doesn't blank the window.

## Tested

- 182 unit tests: a healthy single node on the Tiny's real storage passes every check; each problem shows with its fix; two votes warn, a tie-breaker makes it pass, a lost majority is bad. Proven able to fail: loosening the vote rule breaks a test.
- In the browser on the test BossMox: 9 checks, 7 passed, and the lab's two real problems (four guests unscheduled, two running guests not starting at boot) showed with their buttons. Start at boot set on test VM 951 only. Phone width without sideways scrolling.

## Not tested

- The two-node, lost-majority, failed-backup, full-pool, worn-drive and DHCP cases live: the lab doesn't have them, so they're unit tested.
