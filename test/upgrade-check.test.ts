import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { UPGRADE_HELP, attention, blockers, explain, parseChecker } from "../src/upgrade-check.js";

/** pve8to9 --full on a Proxmox 8.4.21 lab node with shared LVM over iSCSI, names and address changed. */
const LAB = readFileSync(new URL("../../test/pve8to9-8.4-shared-lvm.txt", import.meta.url), "utf8");

test("the checker's own counts are read from its summary", () => {
  assert.deepEqual(parseChecker(LAB).summary, { total: 47, passed: 37, skipped: 6, warnings: 3, failures: 0 });
});

test("every finding is read with its level and section, colours and all", () => {
  const run = parseChecker(LAB);
  const count = (l: string) => run.findings.filter((f) => f.level === l).length;
  assert.equal(count("PASS"), 37);
  assert.equal(count("SKIP"), 6);
  assert.equal(count("WARN"), 3);
  assert.equal(count("NOTICE"), 1);
  assert.equal(count("FAIL"), 0);
  assert.ok(
    run.findings.every((f) => !f.text.includes("\u001b")),
    "no terminal colours left",
  );
  assert.equal(run.findings.find((f) => f.level === "WARN")?.section, "VIRTUAL GUEST CHECKS");
});

test("a finding keeps the lines it runs on to, such as the command Proxmox suggests", () => {
  const lvm = parseChecker(LAB).findings.find((f) => f.text.startsWith("Starting with PVE 9, autoactivation"));
  assert.ok(lvm?.text.includes("/usr/share/pve-manager/migrations/pve-lvm-disable-autoactivation"));
  const next = parseChecker(LAB).findings.find((f) => f.text.startsWith("Checking lvm config for thin_check_options"));
  assert.equal(next?.level, "INFO", "the next finding starts fresh");
});

test("what needs attention is explained in plain words, with who deals with it", () => {
  const a = attention(parseChecker(LAB));
  assert.deepEqual(
    a.map((x) => [x.level, x.handling, x.title]),
    [
      ["WARN", "bossmox", "2 guests are running on this node"],
      ["NOTICE", "advice", "Disks with autoactivation on"],
      ["WARN", "fix", "Shared storage: stop every node opening every old VM disk"],
      ["WARN", "advice", "No processor microcode package"],
    ],
  );
});

/** pve8to9 --full on a lab VM after the 9 packages went in, before the restart (2026-11-16), names and address changed. */
const AFTER = readFileSync(new URL("../../test/pve8to9-9.2-after-packages.txt", import.meta.url), "utf8");

test("the 9 checker's missing-microcode failure is advice, so it doesn't stop the restart", () => {
  const run = parseChecker(AFTER);
  assert.equal(run.summary?.failures, 1);
  const fail = attention(run).filter((e) => e.level === "FAIL");
  assert.deepEqual(
    fail.map((e) => [e.handling, e.title]),
    [["advice", "No processor microcode package"]],
  );
  assert.deepEqual(blockers(run), []);
});

test("what blocks: explained blockers, plus any failure the summary counts that wasn't read", () => {
  const unknown = parseChecker("FAIL: something new went wrong\n\n= SUMMARY =\n\nTOTAL: 2\nPASSED: 1\nSKIPPED: 0\nWARNINGS: 0\nFAILURES: 1\n");
  assert.deepEqual(blockers(unknown), ["something new went wrong"]);
  const unread = parseChecker("= SUMMARY =\n\nTOTAL: 2\nPASSED: 1\nSKIPPED: 0\nWARNINGS: 0\nFAILURES: 1\n");
  assert.deepEqual(blockers(unread), ["a failure BossMox couldn't read"]);
  const extra = parseChecker(AFTER.replace(/FAILURES: 1/, "FAILURES: 2"));
  assert.deepEqual(blockers(extra), ["a failure BossMox couldn't read"]);
});

test("a failure BossMox doesn't know still blocks, in Proxmox's words", () => {
  const e = explain({ level: "FAIL", section: "X", text: "something new went wrong\nwith more detail" });
  assert.equal(e.handling, "blocks");
  assert.equal(e.title, "something new went wrong");
  assert.equal(e.detail, "with more detail");
});

test("an old proxmox-ve blocks until Update all nodes has run", () => {
  assert.equal(explain({ level: "FAIL", section: "", text: "proxmox-ve package is too old, please upgrade to >= 8.4-1!" }).handling, "blocks");
  assert.equal(explain({ level: "PASS", section: "", text: "proxmox-ve package has version >= 8.4-0" }).handling, "advice");
});

/** pve8to9 --full lines from a real 8.4 cluster with a Ceph setup nobody used (2026-11-18), exactly as printed. */
const CEPH_LEFTOVER = [
  "FAIL: failed to get 'noout' flag status - got timeout",
  "FAIL: unable to determine Ceph status!",
  "FAIL: Hyper-converged Ceph 17 Quincy is to old for upgrade!",
  "FAIL: unable to determine Ceph daemon versions!",
  "WARN: 'noout' flag not set - recommended to prevent rebalancing during upgrades.",
  "WARN: systemd-boot package installed on legacy-boot system is not necessary, consider removing it",
].join("\n\n");

test("the shared-storage warning says what changes and what doesn't (ADR 0044: it read like turning off HA)", () => {
  const lvm = attention(parseChecker(LAB)).find((e) => e.fixId === "lvm-autoactivation" && e.level === "WARN");
  assert.ok(lvm, "found");
  assert.doesNotMatch(lvm.title, /autoactivation|turn off/i);
  assert.match(lvm.detail, /creates no disks/);
  assert.match(lvm.detail, /running VMs and HA aren't affected/);
  assert.equal(lvm.help, "upgrade-lvm-autoactivation");
});

test("a Ceph setup nobody used is explained, and still blocks the upgrade", () => {
  const run = parseChecker(CEPH_LEFTOVER);
  const fails = attention(run).filter((e) => e.level === "FAIL");
  assert.deepEqual(
    fails.map((e) => [e.handling, e.title, e.help]),
    [
      ["blocks", "Ceph doesn't answer", "upgrade-ceph"],
      ["blocks", "Ceph doesn't answer", "upgrade-ceph"],
      ["blocks", "Ceph 17 (Quincy) is installed and too old for Proxmox VE 9", "upgrade-ceph"],
      ["blocks", "Ceph doesn't answer", "upgrade-ceph"],
    ],
  );
  assert.equal(blockers(run).length, 4, "the same four still stop it");
  assert.equal(explain({ level: "FAIL", section: "", text: "Hyper-converged Ceph 18 Reef is too old for upgrade!" }).title, "Ceph 18 (Reef) is installed and too old for Proxmox VE 9");
  const noout = attention(run).find((e) => e.title === "Ceph's 'noout' flag isn't set");
  assert.equal(noout?.handling, "advice");
});

test("systemd-boot on a BIOS node is advice in plain words, not a blocker, and BossMox says it doesn't remove it", () => {
  const e = attention(parseChecker(CEPH_LEFTOVER)).find((x) => x.help === "upgrade-systemd-boot");
  assert.equal(e?.handling, "advice");
  assert.equal(e?.title, "A boot package this node doesn't use");
  assert.match(e?.detail ?? "", /BossMox doesn't remove it/);
});

test("every item, known or not, names a Help article from the fixed list", () => {
  const all = [...attention(parseChecker(LAB)), ...attention(parseChecker(AFTER)), ...attention(parseChecker(CEPH_LEFTOVER)), explain({ level: "FAIL", section: "", text: "something new" })];
  for (const e of all) assert.ok((UPGRADE_HELP as readonly string[]).includes(e.help), `${e.title}: ${e.help}`);
  assert.equal(explain({ level: "WARN", section: "", text: "something new" }).help, "upgrade-checker");
});

test("one running guest reads as one guest (lab browser check, 2026-11-19)", () => {
  assert.equal(explain({ level: "WARN", section: "", text: "1 running guest(s) detected - consider migrating or stopping them." }).title, "1 guest is running on this node");
});
