# 12. Updating an installed BossMox

Date: 2026-11-06. Status: accepted for the one-command update. The Update button isn't decided.

## Decision

- `deploy/update.sh` runs as root on the node holding the BossMox VM, next to `bossmox.tgz`, the same way as the install. No SSH into the VM is needed.
- The files go through the guest agent in pieces, because Proxmox takes 1 MiB at a time, and each file's checksum is compared inside the VM before anything changes.
- Inside the VM, `deploy/update-in-alpine.sh` copies the running version aside, reruns `install-in-alpine.sh`, and waits for the page to answer. If it doesn't, the old version goes back.
- Settings in `/var/lib/bossmox`, the HTTPS certificate and the finished setup all stay.
- A VM set up by `deploy/update-alpine.sh` keeps its Proxmox details in `/etc/bossmox/env`, which installing rewrites, so the update refuses those.
- A release now carries a `VERSION` file, dated so people can tell which is newer, with the commit so it says exactly what's in it.

## Not covered

- Going back restores the app in `/opt/bossmox`. It doesn't undo Alpine package updates, or the service and console files `install-in-alpine.sh` writes.
- An Update button in BossMox. It would run from a process that can't write to its own files, on the strength of something it downloaded, so it needs signed releases and a small privileged helper. That belongs to the first public release.
- Updating is one version to the next. Nothing migrates settings yet, because their format hasn't changed.
