# 19. Telling people when a newer BossMox is out

Date: 2026-11-09. Status: accepted. Rocky: "we want the ability to update quickly - so maybe it should check every 6 hours?"

## Why

BossMox updates with one command on a Proxmox node, but nothing told anyone a new version existed. Fixes merged on GitHub reached nobody until they happened to look.

## Decision

- **BossMox asks GitHub for the latest release every 6 hours**, the first time a minute after it starts (so a restart loop can't hammer GitHub). It asks `api.github.com/repos/bossmox/bossmox/releases/latest`, the same "latest release" the install and update one-liners download, naming itself only as `BossMox/<version>`. Unauthenticated GitHub allows 60 requests an hour per address; this uses 4 a day.
- **The version number decides.** A release counts as newer only when its numbers (0.1.1 from `v0.1.1-preview`) are higher than the running build's (0.1.0 from `0.1.0-preview.20261109.b55906c`), compared as numbers so 0.1.10 beats 0.1.9. So **every release must raise the version in package.json**; a rebuild under the same number is never offered. Drafts, pre-releases and any link outside `github.com/bossmox/bossmox/releases/` are ignored. A copy with no version (run from the repo, or a test deploy marked `dev-`) never checks.
- **It only tells; it never installs.** A desktop notice ("BossMox 0.1.1 is available", dismissible like the others; a newer version shows again) and a health check line. Both open a window with the update command to copy, a link to what's new, and a button for the console of the node that holds the BossMox VM, since the update script only looks for the VM on the node it runs on. Installing from inside BossMox would mean BossMox running root commands on a node by itself, which nothing else in it does.
- **Health check states:** available (worth a look, "How to update"), up to date (passed), couldn't check (worth a look, says why in plain words, offers turning the check off for a BossMox kept off the internet on purpose), turned off (grey, never passed, "Check for updates"). Nothing shows before the first check.
- **On by default, and can be turned off,** because each check tells GitHub this BossMox's internet address; the confirmation says so. It's a cluster-wide preference beside "We back up another way" (ADR 0018), changed with the same right: Sys.Modify on `/`. Turning it off forgets what it found; turning it on checks straight away.

## Not done

- An automatic install, for the reason above. If wanted later, the console button could open the node's console with the command typed in, waiting for Enter, the way node updates already wait for a person.
- People on 0.1.0 have no check, so they need the update command once; from 0.1.1 on, BossMox tells them.

## Check now (2026-11-10)

Rocky asked for a way to force a check. The health check's BossMox line has a Check now button, also before the first check has run. It asks GitHub at once, then says what it found; a newer version opens How to update. Anyone signed in can press it, since it changes nothing. Within a minute of the last check it answers from what it already has, so repeated clicks can't use up GitHub's 60 requests an hour.

## Tested

- Unit tests, each proven able to fail by breaking its rule: version numbers from tags and builds; only a higher number counts (equal, lower and 0.1.10 against 0.1.9); drafts, pre-releases and foreign links ignored; the request goes to the latest-release address and names BossMox; a refused or unreachable GitHub gives a plain reason and never throws; turned off or with no version it never contacts GitHub; turning off forgets and turning on checks at once; the four health states; a damaged preferences file still checks.
- Live on the test BossMox, 2026-11-09, with its version set to 0.0.9 so the published 0.1.0 preview counted as newer: the first check found it a minute after start; the desktop showed "BossMox 0.1.0-preview is available"; its window showed the command and the link to the release; the health check showed it with How to update and Stop checking; Stop checking (as root) removed the notice and showed "turned off" in grey ("10 checks, 8 passed, 1 turned off"); Check for updates brought the notice straight back. The copy button fell back to selecting the command in the test browser, which has no clipboard permission; a real copy wasn't shown.
