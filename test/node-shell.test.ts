import assert from "node:assert/strict";
import { test } from "node:test";
import { askedToLogIn, finished, INSTALL_COMMAND, keptConfigFiles, plainText } from "../src/node-shell.js";

test("the exit code is read from the marker, never from the echoed command", () => {
  const echoed = "root@pve1:~# export DEBIAN_FRONTEND=noninteractive; ... ; echo __BOSSMOX_DONE__:$?\r\n";
  assert.equal(finished(echoed), null, "the typed line has $?, not a number");
  assert.equal(finished(`${echoed}Setting up pve-manager ...\r\n__BOSSMOX_DONE__:0\r\nroot@pve1:~# `), 0);
  assert.equal(finished(`${echoed}E: Sub-process /usr/bin/dpkg returned an error code (1)\r\n__BOSSMOX_DONE__:100\r\n`), 100);
  const chunks = ["Setting up x\r\n__BOSSMOX_DO", "NE__:0\r\n"];
  assert.equal(finished(chunks[0] as string), null);
  assert.equal(finished(chunks.join("")), 0, "a marker split across two pieces of output is found once joined");
});

test("a login prompt means no root shell", () => {
  assert.equal(askedToLogIn("\r\nDebian GNU/Linux 12\r\n\r\npve-node1 login: "), true);
  assert.equal(askedToLogIn("Linux pve-node1 6.8.12-43-pve\r\nroot@pve-node1:~# "), false);
});

test("config files dpkg kept are listed once each", () => {
  const out = "Configuration file '/etc/lvm/lvm.conf'\r\n ==> Modified (by you or by a script) since installation.\r\n ==> Keeping old config file as default.\r\n"
    + "Configuration file '/etc/lvm/lvm.conf'\r\nConfiguration file '/etc/default/grub'\r\n";
  assert.deepEqual(keptConfigFiles(out), ["/etc/lvm/lvm.conf", "/etc/default/grub"]);
  assert.deepEqual(keptConfigFiles("Setting up curl ...\r\n"), []);
});

test("the install keeps existing config files and prints its exit code", () => {
  assert.match(INSTALL_COMMAND, /--force-confold/);
  assert.match(INSTALL_COMMAND, /--force-confdef/);
  // apt runs as its own systemd job, so a closed console can't stop it mid-upgrade, and never twice at once (#59).
  assert.match(INSTALL_COMMAND, /systemd-run --quiet --pipe --wait --collect --unit=bossmox-update /);
  assert.match(INSTALL_COMMAND, /^if systemctl is-active --quiet bossmox-update; then echo __BOSSMOX_DONE__:75; else /);
  assert.match(INSTALL_COMMAND, /dist-upgrade'; echo __BOSSMOX_DONE__:\$\?; fi\n$/);
  assert.equal(plainText("\x1b[1mbold\x1b[0m\r\n"), "bold\n");
});
