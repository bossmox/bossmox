import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildHealth, type HealthInput } from "../src/health.js";
import { buildStorageMap } from "../src/storage-map.js";

const map = (name: string) => {
  const d = JSON.parse(readFileSync(new URL(`../../test/${name}.json`, import.meta.url), "utf8"));
  return buildStorageMap({ ...d, zfs: d.zfsDetail }, false);
};
/** A healthy single node, the Tiny's real storage. Each test breaks one thing. */
const base = (): HealthInput => ({
  nodes: [{ name: "rockylab", online: true }],
  votes: [],
  tieBreaker: false,
  channels: [{ node: "rockylab", ok: true, headline: "", note: "", offer: null }],
  updates: [{ node: "rockylab", total: 0 }],
  guests: [{ id: 100, name: "HomeAssistant", node: "rockylab", running: true, template: false, startsAtBoot: true, issues: [] }],
  unscheduled: [],
  jobs: [{ id: "nightly", storage: "nas", enabled: true }],
  failedBackups: [],
  maps: [map("storage-lvm-install")],
  ownDhcp: false,
});
const by = (checks: ReturnType<typeof buildHealth>, id: string) => checks.find((c) => c.id === id);

test("a healthy single node passes everything and says so", () => {
  const input = base();
  // The schedule saves to a NAS, so it has to be network storage in the map.
  input.maps[0]!.network.push({ ...input.maps[0]!.groups[0]!.pools[0]!, id: "nas", shared: true });
  const checks = buildHealth(input);
  assert.deepEqual(checks.filter((c) => c.status !== "ok").map((c) => c.title), []);
  assert.equal(by(checks, "votes"), undefined, "a single node isn't told about votes");
  assert.ok(checks.length >= 8);
});

test("two nodes without a tie-breaker are warned, three are fine, a lost majority is bad", () => {
  const two = { ...base(), cluster: { quorate: true }, votes: [{ node: "a", votes: 1 }, { node: "b", votes: 1 }] };
  assert.equal(by(buildHealth(two), "votes")!.status, "warn");
  assert.equal(by(buildHealth({ ...two, tieBreaker: true }), "votes")!.status, "ok");
  assert.equal(by(buildHealth({ ...two, cluster: { quorate: false } }), "votes")!.status, "bad");
});

test("each problem comes with the fix BossMox already has", () => {
  const input = base();
  input.channels = [{ node: "rockylab", ok: false, headline: "Updates can't download", note: "This channel needs a subscription.", offer: "free" }];
  input.unscheduled = [100];
  input.guests[0]!.startsAtBoot = false;
  input.updates = [{ node: "rockylab", total: 13 }];
  input.ownDhcp = true;
  const checks = buildHealth(input);
  assert.deepEqual(by(checks, "channel-rockylab")!.fix, { kind: "channel", label: "Use the free channel", node: "rockylab", channel: "free" });
  assert.equal(by(checks, "scheduled")!.fix!.kind, "protect");
  assert.deepEqual(by(checks, "boot")!.fix!.vmids, [100]);
  assert.equal(by(checks, "updates-rockylab")!.title, "13 updates waiting on rockylab");
  assert.equal(by(checks, "own-address")!.status, "warn");
});

test("backups kept on the node's own drives are warned, and a failed one is bad", () => {
  const input = { ...base(), jobs: [{ id: "nightly", storage: "qcow", enabled: true }], failedBackups: [{ node: "rockylab", guest: "HomeAssistant", at: 1 }] };
  const checks = buildHealth(input);
  assert.equal(by(checks, "backup-place")!.status, "warn");
  assert.match(by(checks, "backup-place")!.detail, /qcow/);
  assert.equal(by(checks, "backup-failed")!.status, "bad");
  assert.match(by(checks, "backup-failed")!.detail, /HomeAssistant on rockylab/);
});

test("a nearly full pool, an over-promised thin pool and a worn drive each show", () => {
  const input = base();
  const thin = input.maps[0]!.groups[0]!.pools.find((p) => p.id === "local-lvm")!;
  thin.usedGb = thin.totalGb * 0.96;
  thin.overGivenGb = thin.totalGb + 50;
  input.maps[0]!.groups[0]!.disks[0]!.wearLeft = 6;
  const checks = buildHealth(input);
  assert.equal(by(checks, "full-rockylab-local-lvm")!.status, "bad");
  assert.equal(by(checks, "over-rockylab-local-lvm")!.status, "warn");
  assert.equal(by(checks, "wear-rockylab-/dev/nvme0n1")!.status, "warn");
  assert.equal(by(checks, "storage"), undefined, "no all-clear line while something's wrong");
});

test("with backups done another way, the schedule check is turned off, never passed, and says how to turn it back on", () => {
  const input = { ...base(), unscheduled: [], backupsElsewhere: true, failedBackups: [{ node: "rockylab", guest: "HomeAssistant", at: 1 }] };
  const checks = buildHealth(input);
  const scheduled = by(checks, "scheduled")!;
  assert.equal(scheduled.status, "off");
  assert.match(scheduled.detail, /Check schedules again/);
  assert.deepEqual(scheduled.fix, { kind: "backups-elsewhere", label: "Check schedules again" });
  assert.equal(by(checks, "backup-failed")!.status, "bad", "failed Proxmox backups are still reported");
});
