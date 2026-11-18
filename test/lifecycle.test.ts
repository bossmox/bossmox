import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHealth, type HealthInput } from "../src/health.js";
import { lifeOf, longDate, NOTICE_DAYS } from "../src/lifecycle.js";
import { buildNotice } from "../src/proxmox-notice.js";

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

test("Proxmox VE 8 ended on August 31, 2026: still supported that day, ended the next", () => {
  assert.equal(lifeOf("8.4.21", day("2026-08-31"))?.state, "ending");
  assert.equal(lifeOf("8.4.21", day("2026-09-01"))?.state, "ended");
  assert.equal(longDate("2026-08-31"), "August 31, 2026");
});

test("the notice starts about six months ahead", () => {
  assert.equal(lifeOf("8.4.1", day("2026-02-01"))?.state, "supported");
  assert.equal(lifeOf("8.4.1", day("2026-03-15"))?.state, "ending");
  assert.ok(NOTICE_DAYS >= 180 && NOTICE_DAYS <= 186);
});

test("a version with no announced end is supported, and a newer major than BossMox knows is unknown", () => {
  assert.deepEqual(lifeOf("9.2.26", day("2026-11-13")), { major: 9, state: "supported", endOfLife: null, daysLeft: null, newer: null });
  assert.equal(lifeOf("10.0.1", day("2026-11-13"))?.state, "unknown");
  assert.equal(lifeOf("8.4.21", day("2026-11-13"))?.newer, 9, "it names the version to move to");
  assert.equal(lifeOf("garbage", day("2026-11-13")), null);
});

const base = (versions: { node: string; version: string }[]): HealthInput => ({
  nodes: versions.map((v) => ({ name: v.node, online: true })),
  votes: [],
  tieBreaker: false,
  channels: [],
  updates: [],
  guests: [],
  unscheduled: [],
  jobs: [],
  failedBackups: [],
  maps: [],
  ownDhcp: false,
  versions,
  now: day("2026-11-13"),
});
const eol = (h: HealthInput) => buildHealth(h).filter((c) => c.id.startsWith("eol-"));

test("a cluster on 8.4 today gets one red line naming its nodes and the version to move to", () => {
  const c = eol(
    base([
      { node: "pve-node1", version: "8.4.21" },
      { node: "pve-node2", version: "8.4.21" },
    ]),
  );
  assert.equal(c.length, 1);
  assert.equal(c[0]?.status, "bad");
  assert.equal(c[0]?.title, "Proxmox VE 8 stopped getting updates on August 31, 2026");
  assert.match(c[0]?.detail ?? "", /pve-node1, pve-node2 run 8\.4\.21\. .*Upgrade to Proxmox VE 9\./);
});

test("half way through an upgrade, each version gets its own line", () => {
  const c = eol(
    base([
      { node: "a", version: "8.4.21" },
      { node: "b", version: "9.1.4" },
    ]),
  );
  assert.deepEqual(
    c.map((x) => [x.id, x.status]),
    [
      ["eol-8", "bad"],
      ["eol-9", "ok"],
    ],
  );
  assert.match(c[1]?.detail ?? "", /hasn't announced an end date/);
});

test("the header notice names the oldest ended version and the nodes with updates waiting", () => {
  const n = buildNotice(
    [
      { node: "a", version: "8.4.21", waiting: 12 },
      { node: "b", version: "9.1.4", waiting: 0 },
      { node: "c", version: "8.4.21", waiting: null },
    ],
    day("2026-11-13"),
  );
  assert.equal(n?.ended?.major, 8);
  assert.equal(n?.ended?.text, "Proxmox VE 8 has ended (August 31, 2026)");
  assert.equal(n?.ended?.newer, 9);
  assert.deepEqual(n?.updates, { nodes: ["a"], total: 12 }, "a node whose list couldn't be read isn't counted");
});

test("nothing to say means no notice at all", () => {
  assert.equal(buildNotice([{ node: "b", version: "9.1.4", waiting: 0 }], day("2026-11-13")), null);
  assert.equal(buildNotice([{ node: "a", version: "8.4.21", waiting: 0 }], day("2026-08-31")), null, "the last day of updates isn't ended yet");
});
