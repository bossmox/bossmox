import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { attention, explain, parseChecker } from "../src/upgrade-check.js";

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
      ["WARN", "fix", "Shared LVM storage: turn off autoactivation first"],
      ["WARN", "advice", "No processor microcode package"],
    ],
  );
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
