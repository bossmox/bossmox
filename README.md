# BossMox

**BossMox: management app for Proxmox Virtual Environment.**

A desktop-style web interface for Proxmox VE, organized around what you came to do. Everyday tasks stay in plain English, and advanced settings stay one click away.

BossMox is an independent project. It is not affiliated with or endorsed by Proxmox Server Solutions GmbH. Proxmox is a registered trademark of Proxmox Server Solutions GmbH.

## Status

Early. Sign in with your normal Proxmox account, including authenticator-app 2FA. You see and do what your Proxmox permissions allow. You can start, stop, create, change, delete and open a console on VMs and containers, take snapshots, back up and restore on a schedule, and update a whole cluster one node at a time. It also shows nodes, storage, network, services and recent activity, and points out things worth a look. It can check a server for updates and install them in a live terminal. Everything it can change is listed in `ACTIONS` and the install route in `src/server.ts`.

Hardware security keys (WebAuthn) and recovery codes don't work in BossMox yet. The setup wizard can't sign in with a one-time code yet, so finish setup as a root account without 2FA.

## Install on a Proxmox node

Run as root on a node, with `bossmox.tgz` beside the script. It creates one small Alpine VM and changes nothing else, then prints the address and a setup code. `--help` isn't needed: the options are at the top of the script.

```sh
bash install.sh --storage local-lvm --ip 192.168.1.20/24 --gateway 192.168.1.1
```

Open the address, enter the code and follow the wizard. Use a fixed address or a DHCP reservation, because BossMox only answers on the address it was set up on.

To update it later, run this as root on the same node, with the new `bossmox.tgz` beside it. Settings stay, everyone is signed out when it restarts, and if the new version doesn't start, the old one goes back.

```sh
bash update-bossmox.sh
```

If a node has moved to a new network since Proxmox was installed, its `/etc/hosts` and certificate still name the old address. BossMox copes on a single node, but correct them before building a cluster.

## Run it yourself

1. Copy `/etc/pve/pve-root-ca.pem` from Proxmox to `./pve-root-ca.pem`.
2. Copy `.env.example` to `.env` and fill in `PVE_URL`.
3. Run:

```sh
docker build -t bossmox .
docker run --rm --env-file .env -e PVE_CA_FILE=/ca.pem -e BOSSMOX_ALLOW_HTTP=1 \
  -v "$PWD/pve-root-ca.pem:/ca.pem:ro" -p 127.0.0.1:8080:8080 bossmox
```

Then open http://localhost:8080.

On a Proxmox cluster, the smallest setup is the Alpine VM in `deploy/`: 256 MB of memory and 1 GB of disk. A VM can move between servers while it runs, so BossMox stays online. List every server in `PVE_URL`, comma separated.

Running BossMox outside the cluster is the most robust choice, because it keeps working when a node restarts.

**Treat wherever BossMox runs like a node.** Every admin's password passes through it at sign-in, so anyone who controls that VM or container could capture them. If it runs on the cluster, give only full admins any rights on it, including console, power, backup and cloud-init rights. Running it off-cluster avoids this.

The first time you visit a self-signed address, your browser warns you. Before you enter the setup code, open the certificate's details in the browser and compare its SHA-256 fingerprint with the one the install command printed, which the VM's console also shows next to the setup code. Clicking through without checking could hand your password to someone in the middle.

Give BossMox its own name or address. Browsers share cookies across every port on a host, so an untrusted site on another port of the same address could interfere with sign-in.

Behind a reverse proxy, pass the original `Host` header through, set `BOSSMOX_TRUSTED_PROXY` to the proxy's address, and add the public name to `BOSSMOX_ALLOWED_HOSTS`. The proxy must add the real client address to `X-Forwarded-For`.

To use it from other machines, it needs HTTPS because passwords pass through it. Set `TLS_CERT_FILE` and `TLS_KEY_FILE`, or put it behind an HTTPS proxy and set `BOSSMOX_BEHIND_HTTPS_PROXY=1`. List the host names you use in `BOSSMOX_ALLOWED_HOSTS`. BossMox refuses to start on a network address without one of those, or `BOSSMOX_ALLOW_HTTP=1`, which is only for a port published to `127.0.0.1` as above.

To try it without Proxmox, run `npm run mock`, and set `PVE_URL=http://127.0.0.1:8079`. Sign in as `demo` with the password `demo`.

## How it's built

Rocky Lott directs the product: what to build, the conventions, and what works and what doesn't. Claude, an AI model from Anthropic, writes much of the code.

## Development

```sh
npm ci
npm test
npm run build && npm start
```

## License

BossMox is free and open source under the [GNU Affero General Public License, version 3](LICENSE). You can use it, change it and share it. If you share a changed version, or run one for other people to use, you have to publish your changes under the same license. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for how, and for the terms they come under.
