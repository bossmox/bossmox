import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { ShellResult } from "../src/node-shell.js";
import { createUpgradeFixes, LVM_COMMAND, PIN_COMMAND, readLvm, readPin } from "../src/upgrade-fixes.js";

const root = { username: "root@pam", ticket: "t" } as Session;
const out = (output: string, exitCode = 0): ShellResult => ({ exitCode, output, tail: output, keptConfig: [] });

/** Worded the way Proxmox's tool prints it (pve_network_interface_pinning.pm, 8.4). */
const PINNED = `This will generate name pinning configuration for all interfaces - continue (y/N)?
Name for link 'ens18' (enp0s18) will change to 'nic0'
Name for link 'ens19' will change to 'nic1'
Successfully generated .link files in '/usr/local/lib/systemd/network/'
Updating /etc/network/interfaces.new
Successfully updated Proxmox VE configuration files.

Please reboot to apply the changes to your configuration
`;

test("the pinning tool's renames are read, altnames or not", () => {
  const r = readPin("node1", out(PINNED));
  assert.equal(r.ok, true);
  assert.deepEqual(r.renames, [
    { from: "ens18", to: "nic0" },
    { from: "ens19", to: "nic1" },
  ]);
  assert.equal(r.already, false);
});

test("already pinned is fine; a refusal or a non-zero exit isn't", () => {
  assert.deepEqual(readPin("node1", out("This will generate ... (y/N)?\nNothing to do, aborting.\n")), { node: "node1", ok: true, renames: [], already: true, error: null });
  const r = readPin("node1", out("There already exists a pin for NIC 'ens18' - aborting.\n", 255));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /already exists a pin/);
  assert.equal(readPin("node1", out(PINNED, 1)).ok, false, "a non-zero exit fails even if it printed success");
});

test("the LVM script's own PASS/INFO/WARN lines are kept, and its exit code decides", () => {
  const text =
    "INFO: Starting with PVE 9, autoactivation will be disabled...\nDisable autoactivation on 3 guest volumes on storage 'ISCSI_SHARE'? (y/N)? Assuming 'yes' because '--assume-yes' was passed.\nINFO: disabling autoactivation for vg/vm-101-disk-0 on storage 'ISCSI_SHARE'...\nPASS: all guest volumes on storage 'ISCSI_SHARE' now have autoactivation disabled\n";
  const r = readLvm("node1", out(text));
  assert.equal(r.ok, true);
  assert.equal(r.lines.at(-1), "PASS: all guest volumes on storage 'ISCSI_SHARE' now have autoactivation disabled");
  assert.equal(readLvm("node1", out(text, 1)).ok, false);
});

function setup(answers: Record<string, ShellResult>) {
  const typed: string[] = [];
  const fixes = createUpgradeFixes({
    console: async (node, _s, line) => {
      typed.push(`${node}: ${line}`);
      return answers[node] ?? out("PASS: nothing to do\n");
    },
    onlineNodes: async () => ["node1", "node2", "node3"],
    audit: () => {},
  });
  return { fixes, typed };
}

test("the LVM fix runs Proxmox's command on each node in turn and stops at the first failure", async () => {
  const s = setup({ node2: out("FAIL: could not disable autoactivation\n", 1) });
  const r = await s.fixes.lvm(root, "lvm-autoactivation");
  assert.deepEqual(s.typed, [`node1: ${LVM_COMMAND}`, `node2: ${LVM_COMMAND}`]);
  assert.deepEqual(
    r.map((x) => x.ok),
    [true, false],
  );
  assert.equal(s.fixes.last().lvm?.length, 2);
});

test("both fixes need root@pam and the confirmation, and pinning names the node", async () => {
  const s = setup({ node1: out(PINNED) });
  await assert.rejects(s.fixes.lvm({ username: "admin@pve", ticket: "t" } as Session, "lvm-autoactivation"), /root@pam/);
  await assert.rejects(s.fixes.lvm(root, "yes"), /confirmed/);
  await assert.rejects(s.fixes.pin(root, "node1", "node2"), /node's name/);
  const r = await s.fixes.pin(root, "node1", "NODE1");
  assert.equal(r.renames.length, 2);
  assert.deepEqual(s.typed, [`node1: ${PIN_COMMAND}`]);
  assert.equal(s.fixes.last().pins.node1?.ok, true);
});
