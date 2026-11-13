import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { ShellResult } from "../src/node-shell.js";
import { createUpgradeFixes, LVM_COMMAND, PORTS_COMMAND, pinCommand, readLvm, readPin, readPorts } from "../src/upgrade-fixes.js";

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

test("both fixes need root@pam and the confirmation", async () => {
  const s = setup({});
  await assert.rejects(s.fixes.lvm({ username: "admin@pve", ticket: "t" } as Session, "lvm-autoactivation"), /root@pam/);
  await assert.rejects(s.fixes.lvm(root, "yes"), /confirmed/);
  await assert.rejects(s.fixes.pin(root, "node1", "node2"), /node's name/);
});

/** What udev says on the lab nodes: cloud-init names eth0, ens19 has only the default rules. */
const LAB_PORTS = "BMXPORT ens19 bc:24:11:46:2b:12 /usr/lib/systemd/network/99-default.link no\nBMXPORT eth0 bc:24:11:b7:ff:8b /etc/systemd/network/10-eth0.link yes\n";
const ENS19_PINNED =
  "Name for link 'ens19' (enp0s19) will change to 'nic0'\nSuccessfully generated .link files in '/usr/local/lib/systemd/network/'\nSuccessfully updated Proxmox VE configuration files.\n";

test("the ports udev names are read from the listing, not from the echoed command", () => {
  const ports = readPorts(`${PORTS_COMMAND}\n${LAB_PORTS}`);
  assert.deepEqual(
    ports.map((p) => [p.name, p.named]),
    [
      ["ens19", false],
      ["eth0", true],
    ],
  );
});

function pinSetup(afterPorts: string) {
  const typed: string[] = [];
  let listings = 0;
  const fixes = createUpgradeFixes({
    console: async (_node, _s, line) => {
      typed.push(line);
      if (line === PORTS_COMMAND) return out(listings++ === 0 ? LAB_PORTS : afterPorts);
      if (line.startsWith("test -e")) return out("", 1);
      if (line === pinCommand("ens19")) return out(ENS19_PINNED);
      return out("");
    },
    onlineNodes: async () => ["node3"],
    audit: () => {},
  });
  return { fixes, typed };
}

test("only the port nothing else names is pinned, and udev is asked again before it counts", async () => {
  const s = pinSetup("BMXPORT ens19 bc:24:11:46:2b:12 /usr/local/lib/systemd/network/50-pve-nic0.link yes\nBMXPORT eth0 bc:24:11:b7:ff:8b /etc/systemd/network/10-eth0.link yes\n");
  const r = await s.fixes.pin(root, "node3", "node3");
  assert.equal(r.ok, true);
  assert.deepEqual(r.renames, [{ from: "ens19", to: "nic0" }]);
  assert.deepEqual(r.kept, [{ name: "eth0", file: "/etc/systemd/network/10-eth0.link" }], "eth0 keeps the name another file gives it");
  assert.ok(!s.typed.includes(pinCommand("eth0")), "eth0 is never pinned");
  assert.equal(s.typed.filter((t) => t === PORTS_COMMAND).length, 2);
});

test("if another file would still win, the pins are taken back out before anything restarts", async () => {
  const s = pinSetup("BMXPORT ens19 bc:24:11:46:2b:12 /etc/systemd/network/05-mine.link yes\nBMXPORT eth0 bc:24:11:b7:ff:8b /etc/systemd/network/10-eth0.link yes\n");
  const r = await s.fixes.pin(root, "node3", "node3");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /ens19 \(named by \/etc\/systemd\/network\/05-mine\.link\)/);
  assert.equal(s.typed.at(-1), "rm -f /usr/local/lib/systemd/network/50-pve-nic0.link && rm -f /etc/network/interfaces.new");
});

test("a node whose ports are all named already needs nothing", async () => {
  const s = pinSetup("");
  const fixes = createUpgradeFixes({ console: async () => out("BMXPORT eth0 aa:bb /etc/systemd/network/10-eth0.link yes\n"), onlineNodes: async () => [], audit: () => {} });
  const r = await fixes.pin(root, "node3", "node3");
  assert.equal(r.already, true);
  assert.equal(s.typed.length, 0);
});
