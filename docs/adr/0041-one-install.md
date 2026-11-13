# 0041: The VM is the one supported install

**Date:** 2026-11-13. **Status:** accepted (Rocky: "maybe we abandon the container install - just focus on the VM install?", then "I say we just drop the docker and make an OVA or whatever for virtualbox"). Supersedes the Docker part of ADR 0001.

## Context

BossMox could be installed three ways: the Alpine VM from the one-line install, a container (`create-lxc.sh`, `install-in-lxc.sh`, `update.sh`, `bossmox.service`), and a Docker image. Only the VM was ever offered in the README. Every install change (0.2.1's certificate authority, the sealing key, the daily renewal job) had to be written two or three times, and only the VM was tested on a lab.

## Decision

The VM is the one supported install. The container scripts, the Dockerfile and the Docker section of `docs/running-elsewhere.md` are removed in 0.2.1. Running BossMox on your own computer comes back as a VirtualBox (and maybe Hyper-V) image, #97.

## Consequences

- One install to build, test and support. `bossmox-cert` restarts BossMox with OpenRC only.
- Anyone running BossMox in Docker or a container moves to the one-line install; the release notes say so.
- Development still runs from the repository (`npm start`, `npm run mock`).
