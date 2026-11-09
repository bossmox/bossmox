import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canChangeCluster, preferencesPath, readPreferences, scheduleWarnings, writePreferences } from "../src/preferences.js";

test("the setting is kept on the server, beside the settings file, and survives a restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bmx-prefs-"));
  const file = preferencesPath(path.join(dir, "settings.json"));
  assert.equal(path.basename(file), "preferences.json");
  assert.deepEqual(readPreferences(file), { backupsElsewhere: false, updateCheck: true }, "no file means warn, the safe default");
  writePreferences(file, { backupsElsewhere: true, updateCheck: false });
  assert.deepEqual(readPreferences(file), { backupsElsewhere: true, updateCheck: false });
});

test("a damaged or odd file falls back to warning", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bmx-prefs-"));
  const file = path.join(dir, "preferences.json");
  writeFileSync(file, "{not json");
  assert.equal(readPreferences(file).backupsElsewhere, false);
  writeFileSync(file, JSON.stringify({ backupsElsewhere: "yes" }));
  assert.equal(readPreferences(file).backupsElsewhere, false);
  assert.equal(readPreferences(file).updateCheck, true, "an odd file still checks for updates");
});

test("with backups done another way, no guest is flagged for a missing schedule", () => {
  const notBackedUp = [{ vmid: 100 }, { vmid: 101 }];
  assert.deepEqual(scheduleWarnings({ backupsElsewhere: true, updateCheck: true }, notBackedUp), []);
  assert.deepEqual(scheduleWarnings({ backupsElsewhere: false, updateCheck: true }, notBackedUp), notBackedUp);
});

test("only an account that can change the cluster's settings can change it", () => {
  assert.equal(canChangeCluster({ "/": { "Sys.Modify": 1, "Sys.Audit": 1 } }), true);
  assert.equal(canChangeCluster({ "/": { "Sys.Audit": 1, "VM.PowerMgmt": 1 } }), false, "a limited account");
  assert.equal(canChangeCluster({ "/vms": { "Sys.Modify": 1 } }), false, "rights on part of the cluster aren't enough");
  assert.equal(canChangeCluster({}), false);
  assert.equal(canChangeCluster(null), false);
});
