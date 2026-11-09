# 20. Update now: the update command typed into the node's console

Date: 2026-11-09. Status: accepted. Rocky chose this over a fully automatic update ("yes, build option 1").

## Why

The update notice (ADR 0019) said a new version was out, but updating still meant copying a command and finding a node's shell. Rocky wanted updating to be quick, from inside BossMox.

## Decision

- The update window's **Update now** opens a console, inside BossMox, on the node that holds the BossMox VM (found by its name, `bossmox`, as the update script finds it), with the update command typed in and **not run**. The person presses Enter, sees From and To, and answers the script's own "Carry on? [y/N]". That's the same kind of approval node updates already have: a person starts it and watches it in a live terminal.
- The command is typed only once the console shows a shell prompt (`#` or `$` at the end, with colours stripped). A login or password prompt never matches, so nothing is typed into one. If no prompt shows within 20 seconds, nothing is typed and the window says to paste the command.
- The command is the fixed one the server sends (`UPDATE_COMMAND`), the same text as the README and the copy button.
- When BossMox can't tell which node holds its VM (renamed, or the node is offline), Update now isn't offered; the copy button and the instructions remain.

## Why the console closing mid-update is safe

The console runs through BossMox, so it closes when the update restarts BossMox. By then the node script has handed the work to the VM (`update-in-alpine.sh`, started by the guest agent), which installs, checks the new version starts, and puts the old one back if it doesn't, all inside the VM, whatever happens to the node script. The window's words say BossMox restarts near the end and the person signs in again.

What closing does leave: the node script can't remove its working folder in the VM (`/var/tmp/bossmox-update`, root-only, about 11 KB: the result, the log and two scripts). The next update clears and remakes it, so it never builds up. Nothing is left on the node.

## Not done

A fully automatic update (BossMox replacing its own code as root without a person) would give the web app a way to install code on its own. It needs its own security review first.

## Tested

- The prompt matcher on real Proxmox output: a root prompt after the login banner and the bracketed-paste code, a `$` prompt, a title escape, and against a login prompt, a password prompt, the script's own question and a prompt followed by a command already run.
- Live on bmx-solo, 2026-11-09: its BossMox set to a 0.1.0-test build of this change. Signed in as root, the desktop showed "BossMox 0.1.1-preview is available"; the window named bmx-solo; Update now opened "Update BossMox on bmx-solo" with the command sitting at the prompt, not run. Enter: it downloaded from GitHub and showed From 0.1.0-test To 0.1.1-preview and asked. y: it copied, said "Updating", and 18 seconds after Enter the console ended as BossMox restarted. BossMox came back on 0.1.1-preview.20261109.a7ce4c6 and its health check read "BossMox is up to date". In the VM the update's result was "ok".
