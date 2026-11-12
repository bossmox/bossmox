# 33. Review fixes: one check per safety question, testable jobs, updates as their own job

Date: 2026-11-12. Status: accepted. Shipped in 0.1.9.

## Context

An independent review in November ([#42](https://github.com/bossmox/bossmox/issues/42)) found:

- six problems in SECURITY.md's scope;
- real bugs in runs and moves, mostly in timing cases;
- two oversized files with no linter.

The fixes were made across three parallel lanes, then checked by a second review before release. That review found four more must-fix problems.

## Decisions

**One function per safety question, failing closed.**
- **Erasing:** wipe, set up storage, making a pool and deleting a pool all ask one question, `eraseBlocker` in `src/storage.ts`: "can BossMox be sure nothing uses this?" The answer is no when any guest's settings didn't load, or when the account can't see every guest. The disk list carries the reason (`blocked`).
- **Deleting a disc or template:** asks the same question.
- **Delete backup:** only deletes what the storage lists as a backup.
- **The tie-breaker's vote:** decided by `tieBreakerVotes`, for Health check and runs alike.
- **Not knowing means refusing.** The HA guard (`haQuorumBlock`) refuses a restart when Proxmox won't say how many votes there are, or which guests HA looks after.

**Moves and runs live in `src/jobs.ts`, tested against a fake Proxmox.**
- The code that decides moves and runs was inside `server.ts`, untested, and that's where the run bugs were.
- `createJobs` takes Proxmox and the server's settings as a context. `test/jobs.test.ts` drives it with a fake three-node cluster that holds answers mid-flight.
- Fixes follow the rules in `learned_coding.md`:
  - take the lock before the first wait (#45);
  - clean up after Stop in every phase, and test Stop after every step (#44);
  - do irreversible steps last, by planning as if the chosen discs were already ejected (#48);
  - read state again before acting (#49);
  - treat losing sight of a move as "unknown", not "failed" (#50).

**Updates run as their own systemd job.**
- **Why:** apt used to run inside a node's console, so a closed console (a timeout, a network blip, BossMox restarting) could kill it mid-upgrade.
- **What runs:** the install command starts `systemd-run --wait --collect --unit=bossmox-update`. A job already running under that name is never started twice (exit 75).
- **Output:** apt writes to the journal, not the console, so a closed console can't make its writes fail. The output is printed once the job ends.
- **The typed line holds only `$?`:** the console echoes what's typed, and the second review found an echoed result marker being read as a real one.

**`server.ts` is split by area.** The 48 actions live in `src/actions/` and the 27 signed-in GET routes in one table in `src/routes/get.ts`. A route exists exactly when the table has it. Both get what they need from the server through a context. Every refusal is an `HttpError`, mapped to the browser in one place. `AuthError` is kept for sign-in refusals.

**Security problems stay private until a release fixes them,** following SECURITY.md:
- **Branch and commits:** the branch holding the fixes was pushed only on release day.
- **Lanes that merged earlier:** their pull request text and comments named no security item.
- **Disclosure:** the six went public as closed issues (#78 to #83) once 0.1.9 was published.
- **The second review's smaller security gaps:** fixed in 0.1.10 (ADR 0034).

## Not done

- **Tests that call the actions and routes themselves.** The second review found this gap; the split makes it possible now.
- **Smaller gaps from the second review,** kept private (see above).
- **A formatter** (#62).
- **A full container install test** (#58 was proven through how systemd behaves, not through a full install).
- **IPv6 on a real network** (unit tests only).

## Tested

Unit tests, 324 at release. On the 8.4 lab cluster:
- **A restart run, with Stop pressed during the reboot:** the shut-down guest started again.
- **Eject on a run:** the disc came out only after every check, and the VM came home.
- **Backup delete:** refused a guest's disk.
- **Every GET route and a set of actions after the split.**
- **The install command on Proxmox 8:** exit code passed back; a second job refused with 75.

Lane 2 ran the install and update scripts there, and lane 3 checked every front-end fix in a browser.
