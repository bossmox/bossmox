import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildUsage, MAX_POINTS, type RawPoint } from "../src/usage.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../test/${name}.json`, import.meta.url), "utf8")) as RawPoint[];

test("a node's day of minutes is thinned to a chart's worth of points, in time order", () => {
  const raw = fixture("usage-node-day");
  assert.equal(raw.length, 1440);
  const u = buildUsage([...raw].reverse(), "node", "day");
  assert.equal(u.points.length, MAX_POINTS);
  assert.ok(u.points.every((p, i) => i === 0 || p.t > u.points[i - 1]!.t), "oldest first, whatever order Proxmox sent");
  assert.equal(u.cores, 2);
  assert.ok(u.memTotalGb! > 2 && u.memTotalGb! < 4, "the test node has about 3 GB");
  assert.equal("diskRead" in u.points[0]!, false, "Proxmox keeps no disk activity for a node");
  assert.ok(u.points.at(-1)!.memGb! > 1, "a node's memory in use comes from its own field, not a guest's");
});

test("units are the plain ones: percent of the cores, GB, megabits and megabytes a second", () => {
  const u = buildUsage([{ time: 60, cpu: 0.25, maxcpu: 4, mem: 2 * 1024 ** 3, maxmem: 8 * 1024 ** 3, netin: 125000, netout: 250000, diskread: 3e6, diskwrite: 1e6 }], "guest", "hour");
  assert.deepEqual(u.points[0], { t: 60, cpu: 25, memGb: 2, netIn: 1, netOut: 2, diskRead: 3, diskWrite: 1 });
  assert.equal(u.memTotalGb, 8);
  assert.equal(u.cores, 4);
});

test("a gap stays a gap, and a bucket averages only what it has", () => {
  const raw: RawPoint[] = Array.from({ length: 240 }, (_, i) => (i < 4 ? { time: i * 60 } : { time: i * 60, cpu: i % 2 ? 0.1 : 0.3, memused: 1024 ** 3 }));
  const u = buildUsage(raw, "node", "day");
  assert.equal(u.points.length, MAX_POINTS);
  assert.equal(u.points[0]!.cpu, null, "the node was off: no line, not a drop to zero");
  assert.equal(u.points[1]!.cpu, null);
  assert.equal(u.points[2]!.cpu, 20, "0.1 and 0.3 average to 20%");
  assert.equal(buildUsage([{ cpu: 0.5 }], "node", "hour").points.length, 0, "a point with no time is dropped");
});

test("a real guest hour keeps every minute and reports its disk activity", () => {
  const u = buildUsage(fixture("usage-guest-hour"), "guest", "hour");
  assert.equal(u.points.length, 60);
  assert.ok(u.points.every((p) => "diskRead" in p && "diskWrite" in p));
  assert.equal(u.memTotalGb, 2);
});
