# 18. "We back up another way": turning off schedule warnings for the whole cluster

Date: 2026-11-09. Status: accepted. Design approved by Rocky 2026-11-09, handed over from another session.

## Why

BossMox only sees Proxmox's own backup jobs. Anyone backing up with Veeam, a script or a separate backup server was warned about every guest, on the desktop and in the health check. The only way out was the × on each notice, which hid it in that one browser and left the health check flagging it.

## Decision

- **One cluster-wide preference, "We back up another way".** It's kept on the server in `preferences.json`, beside BossMox's `settings.json` (`/var/lib/bossmox/` in the VM), so it applies to everyone using that BossMox, in every browser. It isn't in `settings.json`, because that file's existence is what locks setup. Starting setup over (`bossmox-reset`) clears it. A missing, damaged or odd file reads as off: warning is the safe default.
- **With it on,** no "isn't on a backup schedule" notices appear on the desktop, and the Backups app shows a quiet line in place of the warning, with a way to check schedules again.
- **The health check shows the schedule check as turned off,** a fourth state beside passed, worth a look and needs attention: grey, listed last, never counted as passed ("11 checks, 7 passed, 1 turned off"). It says plainly that BossMox isn't checking schedules, that failed Proxmox backups are still reported, and has the button to check again.
- **Failed Proxmox backup jobs are still reported** with it on, and so is a schedule that saves to a node's own drives.
- **Who can change it:** an account with Sys.Modify on `/`, the right to change the cluster's own settings in Proxmox, read from Proxmox's permissions for that path with the person's own ticket. Anyone signed in can see whether it's on. A limited account gets a plain refusal naming the permission.
- **Turning it on or off asks first,** and says it applies to everyone using this BossMox.
- Changing it invalidates every cached overview and health result, so nobody sees the old warnings after it changes.

## Possible later step

A per-guest switch ("this one is backed up elsewhere"), for clusters where some guests use Proxmox's backups and others don't. Not built: the whole-cluster switch covers the common case.

## Tested

- Unit tests, each proven able to fail: the file lives beside settings.json and survives a reread; a damaged or odd file falls back to warning; no guest is flagged with it on; only Sys.Modify on `/` can change it (a limited account, rights on `/vms` only, and no answer all refused); the health check shows it as turned off, not passed, with the way back, and still reports a failed backup.
- Live on the test BossMox (three-node cluster), 2026-11-09:
  - As root: the health check offered "We back up another way" beside the schedule warning; after confirming, the desktop went from 4 notices to "Everything looks good", the health check read "9 checks, 8 passed, 1 turned off" with the turned-off row, and the Backups app showed the quiet line.
  - The file in the VM read `"backupsElsewhere": true`, and the VM's own login account couldn't read it.
  - After restarting BossMox the setting was still on.
  - A limited account (PVEVMUser on /vms only, made for the test and deleted after) saw the setting applied, and its attempt to change it was refused with 403 and the permission named; the setting stayed on.
  - Root turned it back off with Check schedules again, and the 4 warnings came back.
