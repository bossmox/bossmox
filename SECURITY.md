# Security

BossMox handles Proxmox sign-ins and can change, erase and restart things on a cluster, so security reports are very welcome.

## Reporting a problem

Please report it privately, not in a public issue: on this repository, open the **Security** tab and choose **Report a vulnerability**. Without a GitHub account, email hello.bossmox@gmail.com instead. You'll get an answer within a few days. Once it's fixed, you're credited in the release notes unless you'd rather not be.

## What's in scope

- The BossMox server and web app in this repository.
- The install and update scripts in `deploy/`, which run as root on a Proxmox node, and the BossMox VM they create.
- Anything that lets someone do more than their own Proxmox account allows, see another person's session, reach the setup wizard without the setup code, or erase something BossMox should have refused.

Problems in Proxmox VE itself belong with the Proxmox project.

## How BossMox is meant to be safe

- Every Proxmox call runs with the signed-in person's own Proxmox ticket, so Proxmox's own permissions apply. There's no general pass-through: BossMox can only do the actions listed in `src/actions/`, and answer the routes listed in `src/routes/get.ts`.
- Anything that erases or changes something needs a confirmation naming it, and BossMox checks for itself rather than trusting Proxmox to refuse.
- Setup is unlocked by a one-time code shown only on the VM's console, and the root password used during setup is never stored.
- The install command and the VM's console show BossMox's certificate fingerprint, so you can check you've reached the right machine before the setup code and a password go through it.

Independent reviews and what came of them are recorded in `docs/adr/`.
