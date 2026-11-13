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

test("moves sharing the heartbeat's only network are warned, with the network to use; their own network passes", () => {
  const three = { ...base(), cluster: { quorate: true }, votes: ["a", "b", "c"].map((node) => ({ node, votes: 1 })) };
  const shared = by(buildHealth({ ...three, network: { known: true, shared: true, moveNet: "10.0.0.0/24", others: ["10.0.100.0/24"], batch: 1 } }), "move-network")!;
  assert.equal(shared.status, "warn");
  assert.match(shared.detail, /Moves run on 10\.0\.0\.0\/24/);
  assert.match(shared.detail, /Every node is also on 10\.0\.100\.0\/24\. Fix this gives moves that network/);
  assert.match(shared.detail, /one VM at a time/);
  assert.equal(shared.fix!.kind, "move-network");
  const lonely = by(buildHealth({ ...three, network: { known: true, shared: true, moveNet: "10.0.30.0/24", others: [], batch: 1 } }), "move-network")!;
  assert.match(lonely.detail, /second network card/);
  const own = by(buildHealth({ ...three, network: { known: true, shared: false, moveNet: "10.0.100.0/24", others: [], batch: 3 } }), "move-network")!;
  assert.equal(own.status, "ok");
  assert.match(own.detail, /up to 3 VMs/);
  assert.equal(by(buildHealth({ ...three, network: { known: false, shared: false, moveNet: null, others: [], batch: 1 } }), "move-network"), undefined, "can't tell: says nothing");
  assert.equal(by(buildHealth(base()), "move-network"), undefined, "a single node isn't told");
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

test("the BossMox version check: newer available, up to date, couldn't check, and turned off", () => {
  const u = { on: true, checkedAt: 1, available: null, failed: null, running: "version 0.1.0-preview" };
  const v = (update: HealthInput["update"]) => by(buildHealth({ ...base(), update }), "bossmox-version");
  assert.equal(v({ ...u, available: { version: "0.1.1-preview" } })!.status, "warn");
  assert.equal(v({ ...u, available: { version: "0.1.1-preview" } })!.fix!.kind, "bossmox-update");
  assert.equal(v(u)!.status, "ok");
  assert.equal(v({ ...u, failed: "BossMox couldn't reach GitHub" })!.status, "warn");
  const off = v({ ...u, on: false, checkedAt: null })!;
  assert.equal(off.status, "off", "never counted as passed");
  assert.equal(off.fix!.kind, "update-check");
  assert.equal(v(u)!.fix!.kind, "check-now", "up to date offers Check now");
  const before = v({ ...u, checkedAt: null })!;
  assert.equal(before.status, "ok", "not checked yet isn't a problem");
  assert.equal(before.fix!.kind, "check-now", "but it can be asked to check now");
  assert.equal(v(undefined), undefined, "a copy with no version");
});

test("HA guests with Proxmox's default shutdown policy are warned, with Fix this; Migrate passes; no HA guests says nothing", () => {
  const three = { ...base(), cluster: { quorate: true }, votes: ["a", "b", "c"].map((node) => ({ node, votes: 1 })), nodes: ["a", "b", "c"].map((name) => ({ name, online: true })) };
  const warn = by(buildHealth({ ...three, ha: { policy: "conditional", guests: 16 } }), "ha-shutdown")!;
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /16 guests are managed by HA/);
  assert.equal(warn.fix!.kind, "ha-policy");
  assert.equal(by(buildHealth({ ...three, ha: { policy: "migrate", guests: 1 } }), "ha-shutdown")!.status, "ok");
  assert.equal(by(buildHealth({ ...three, ha: { policy: "conditional", guests: 0 } }), "ha-shutdown"), undefined);
  assert.equal(by(buildHealth({ ...base(), ha: { policy: "conditional", guests: 2 } }), "ha-shutdown"), undefined, "a single node has nowhere to move them");
});

test("leftover disks are listed with their guest and size, and offered for removal", () => {
  const disk = { vmid: 124, guest: "AT-VDM-SW", node: "pve-node3", type: "qemu" as const, slot: "unused1", volume: "FILE:124/vm-124-disk-0.qcow2", sizeGb: 32 };
  const one = by(buildHealth({ ...base(), leftover: [disk] }), "leftover")!;
  assert.equal(one.status, "warn");
  assert.equal(one.title, "1 leftover disk is taking up space");
  assert.match(one.detail, /AT-VDM-SW: FILE:124\/vm-124-disk-0\.qcow2 \(32 GB\)/);
  assert.match(one.detail, /frees 32 GB/);
  assert.deepEqual(one.fix!.disks, [disk]);
  const unknown = by(buildHealth({ ...base(), leftover: [disk, { ...disk, slot: "unused2", volume: "nas:9/x.raw", sizeGb: null }] }), "leftover")!;
  assert.match(unknown.detail, /frees at least 32 GB/);
  assert.equal(by(buildHealth(base()), "leftover"), undefined);
});

test("a tie-breaker that's set up but not connected gives no vote, and says why (#51)", () => {
  const two = { ...base(), cluster: { quorate: true }, votes: [{ node: "a", votes: 1 }, { node: "b", votes: 1 }] };
  const down = by(buildHealth({ ...two, tieBreaker: false, tieBreakerDown: true }), "votes")!;
  assert.equal(down.status, "warn");
  assert.equal(down.title, "The tie-breaker isn't connected");
  assert.match(down.detail, /2 votes.*port 5403/);
  assert.equal(by(buildHealth({ ...two, tieBreaker: true }), "votes")!.status, "ok");
});

test("the heartbeat: a best-practice tip with a way to Settings, a tip without one, or a pass (ADR 0035)", () => {
  const cluster = (heartbeat: HealthInput["heartbeat"]) => buildHealth({ ...base(), nodes: [{ name: "a", online: true }, { name: "b", online: true }, { name: "c", online: true }], cluster: { quorate: true }, votes: [{ node: "a", votes: 1 }, { node: "b", votes: 1 }, { node: "c", votes: 1 }], heartbeat });
  const offer = by(cluster({ state: "offer", network: "10.0.31.0/24", addresses: {}, sharesMoves: false, link: 1 }), "heartbeat");
  assert.equal(offer?.status, "tip");
  assert.match(offer?.title ?? "", /^Best practice/);
  assert.equal(offer?.fix?.kind, "settings");
  const noPort = by(cluster({ state: "no-port", nodes: ["c"] }), "heartbeat");
  assert.equal(noPort?.status, "tip");
  assert.match(noPort?.detail ?? "", /c doesn't have one/);
  assert.equal(noPort?.fix, undefined, "nothing to set up without a second port");
  assert.equal(by(cluster({ state: "backed-up", links: 2 }), "heartbeat")?.status, "ok");
  assert.equal(by(cluster({ state: "unknown", why: "x" }), "heartbeat"), undefined, "nothing claimed when it can't be told");
  assert.equal(by(buildHealth(base()), "heartbeat"), undefined, "a single node says nothing");
});

test("HA gave up on a guest: bad, with the lock named and Fix this (ADR 0036)", () => {
  const input = { ...base(), nodes: [{ name: "a", online: true }, { name: "b", online: true }, { name: "c", online: true }], cluster: { quorate: true } };
  input.guests = [{ ...input.guests[0]!, name: "db", id: 102, node: "a", ha: "error", lock: "migrate" }];
  const item = by(buildHealth(input), "ha-error-102");
  assert.equal(item?.status, "bad");
  assert.equal(item?.title, "HA gave up on db");
  assert.match(item?.detail ?? "", /locked \(migrate\).*every node shutting down at once/);
  assert.deepEqual(item?.fix, { kind: "ha-recover", label: "Fix this", vmids: [102], node: "a" });
});

test("two votes and no tie-breaker: the warning opens Settings; a disconnected one or an odd count gets no button (ADR 0037)", () => {
  const two = (over: Partial<HealthInput>) => by(buildHealth({ ...base(), nodes: [{ name: "a", online: true }, { name: "b", online: true }], cluster: { quorate: true }, votes: [{ node: "a", votes: 1 }, { node: "b", votes: 1 }], ...over }), "votes");
  assert.deepEqual(two({})?.fix, { kind: "settings", label: "Open Settings" });
  assert.match(two({})?.detail ?? "", /set up in Settings/);
  assert.equal(two({ tieBreakerDown: true })?.fix, undefined);
});
