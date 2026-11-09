# deploy/

**For people running BossMox:**

- `install.sh` makes the BossMox VM on a Proxmox node. Normally run as the one-line install in the main README.
- `update-bossmox.sh` updates that VM. Also a one-liner in the main README.

**Used by those two, inside the BossMox VM:** `install-in-alpine.sh`, `update-in-alpine.sh`.

**For developers:**

- `make-release.sh` builds the files a GitHub release carries.
- `update-alpine.sh` copies the working code into a BossMox VM for testing.
- `create-alpine-vm.sh`, `create-lxc.sh`, `install-in-lxc.sh`, `update.sh` and `bossmox.service` are the older manual setups (a VM by hand, or a container), kept for people who prefer them.
