# deploy/

**For people running BossMox:**

- `install.sh` makes the BossMox VM on a Proxmox node. Normally run as the one-line install in the main README.
- `update-bossmox.sh` updates that VM. Also a one-liner in the main README.

**Used by those two, inside the BossMox VM:** `install-in-alpine.sh`, `update-in-alpine.sh`.

**For developers:**

- `make-release.sh` builds the files a GitHub release carries.
- `update-alpine.sh` copies the working code into a BossMox VM for testing.
- `create-alpine-vm.sh` makes the same Alpine VM by hand, for testing the installer step by step.

The VM is the one supported install (0.2.1). The container scripts and the Docker image were removed then.
