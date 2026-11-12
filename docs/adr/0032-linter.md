# 32. A linter: Biome

Date: 2026-11-12. Status: accepted. Closes #62 for the linter; a formatter and shellcheck are still open there.

## Context

The November code review (#42) found no linter config. Strict TypeScript already catches much of what a linter catches in plain JavaScript, but a few patterns it doesn't: an async call nobody waits for, code nothing uses, assignments hidden inside expressions. Outside reviewers also read a repo with no linter as one with no guardrails.

ESLint's TypeScript plugin (typescript-eslint 8.72) supports TypeScript only below 6.1, and BossMox builds with TypeScript 7.

## Decision

**Biome 2.6.4**, pinned exactly like every other dependency, as one dev dependency. It has its own parser, so it doesn't depend on the TypeScript version. 2.6.4 is the newest release at least two weeks old on the day it was added.

- **Lint only.** Biome's formatter is off: turning it on rewrites most files at once, which belongs in its own change.
- **Recommended rules, plus `noFloatingPromises`** for the server and tests, where an unhandled rejection can stop the process.
- **Off on purpose:**
  - `noNonNullAssertion`. With `noUncheckedIndexedAccess`, `x[i]!` after a length or `needs()` check is the normal way to tell TypeScript what the code already checked. There are 19 in `src/` and more in the tests.
  - `noFloatingPromises` in `public/`. The 63 hits there are loaders started from a click or a refresh, which catch their own errors; a sample of five confirmed it. Revisit with the split in #60.
  - `noRedundantUseStrict` in `public/`. `setup.js` loads as a classic script, so its `"use strict"` is not redundant there.
- **Where a pattern is intended,** a `biome-ignore` comment says why: the terminal escape-code regexes, and the `??=` that creates a moves entry on first use.
- `npm run lint` runs in CI before the tests.

Fixed while adding it, with no change in behaviour: two unused variables in `app.js`, three assignments split out of expressions, a `forEach` that returned a value, an object spread inside a `reduce`, and Biome's safe fixes (template strings, an optional chain, a type-only import, a regex escape).

## Not done

- A formatter, and shellcheck for `deploy/*.sh` (#62).
- `noFloatingPromises` in `public/` (#60).

## Tested (2026-11-12)

`npm run lint` passes. A file with an un-awaited async call in `src/` makes it fail (exit 1), so the check can fail. `npm test`: 284 of 284 pass. `node --check` parses `app.js` and `setup.js`. Not yet run in a browser.
