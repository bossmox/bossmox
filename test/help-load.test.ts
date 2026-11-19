import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HELP_KEYS, loadHelp } from "../src/help.js";

test("only known articles are read; a missing or oversized one is left out and logged", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bmx-help-"));
  try {
    writeFileSync(path.join(dir, "upgrade-checker.md"), "# Checker\n");
    writeFileSync(path.join(dir, "upgrade-ceph.md"), "x".repeat(70 * 1024));
    writeFileSync(path.join(dir, "secret.md"), "not an article");
    const warned: string[] = [];
    const got = loadHelp(dir, (m) => warned.push(m));
    assert.deepEqual(Object.keys(got), ["upgrade-checker"]);
    assert.ok(!("secret" in got), "a file that isn't a known key is never read");
    assert.equal(warned.length, HELP_KEYS.length - 1, "every other key is reported");
    assert.ok(warned.some((w) => /upgrade-ceph is too long/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped articles all load", () => {
  const warned: string[] = [];
  const got = loadHelp(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "docs", "help"), (m) => warned.push(m));
  assert.deepEqual(warned, []);
  assert.deepEqual(Object.keys(got).sort(), [...HELP_KEYS].sort());
});
