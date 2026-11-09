# Contributing to BossMox

BossMox: management app for Proxmox Virtual Environment. Not affiliated with Proxmox Server Solutions GmbH.

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Before you send code

- Open an issue first for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
- Run `npm test`. Every change that affects behaviour comes with a test that fails without it.
- Keep the words on screen plain. BossMox is for people who know Windows, Hyper-V or ESXi, not Linux. Proxmox terms belong in details, not headlines.
- Anything that can erase or change something needs a confirmation that names the thing, and BossMox checks for itself rather than trusting Proxmox to refuse.
- Bigger decisions get a short record in `docs/adr/`.

## License of your contribution

BossMox is licensed under the GNU Affero General Public License, version 3 (see `LICENSE`).

By submitting a contribution (code, documentation, or anything else) to this project, you agree that:

1. Your contribution is licensed under the AGPL-3.0, like the rest of BossMox.
2. You also grant Rocky Lott, the project's maintainer, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify and distribute your contribution under other terms as well, including commercial ones. This keeps the option open to offer BossMox under a different license in future, for example to fund its development.
3. You have the right to make the contribution, and it's your own work or you have permission to submit it.

If you can't agree to that, please open an issue instead of a pull request.

## Security problems

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository instead.
