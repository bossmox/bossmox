import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readMoves, runMoveHome, runMoveOff, stillAway, writeMoves, type MoveDeps, type MoveRecord } from "../src/moves.js";
import type { Move, MovePlan } from "../src/placement.js";

/** A pretend cluster: guests sit on nodes, a move's task finishes on the next check and the guest arrives. */
function cluster(start: Record<number, string>, opts: { plan?: (from: string, ids: number[], only?: string) => MovePlan; failId?: number; aliveFor?: number } = {}) {
  const where = new Map(Object.entries(start).map(([id, n]) => [Number(id), n]));
  const tasks = new Map<string, { move: Move; ok: boolean }>();
  const saves: MoveRecord[] = [];
  const started: string[] = [];
  let checks = 0;
  const names: Record<number, string> = { 1: "a", 2: "b", 3: "c" };
  const deps: MoveDeps = {
    plan: async (from, ids, only) =>
      opts.plan?.(from, ids, only) ?? { moves: ids.filter((id) => where.get(id) === from).map((id) => ({ id, name: names[id] ?? String(id), type: "qemu", target: only ?? (id % 2 ? "n2" : "n3") })), problems: [] },
    migrate: async (move, from) => {
      const upid = `UPID:${from}:${move.id}`;
      started.push(`${move.name}->${move.target}`);
      tasks.set(upid, { move, ok: move.id !== opts.failId });
      return upid;
    },
    task: async (_node, upid) => {
      const t = tasks.get(upid);
      if (t?.ok) where.set(t.move.id, t.move.target);
      return { finished: true, ok: Boolean(t?.ok), error: "migration aborted" };
    },
    where: async () => new Map(where),
    alive: () => opts.aliveFor === undefined || checks++ < opts.aliveFor,
    wait: async () => {},
    save: (r) => saves.push(structuredClone(r)),
  };
  return { deps, where, saves, started };
}
const moves = (...m: [number, string, string][]): Move[] => m.map(([id, name, target]) => ({ id, name, type: "qemu", target }));

test("moving off records each guest's home and where it went, one at a time", async () => {
  const c = cluster({ 1: "n1", 2: "n1" });
  const record: MoveRecord = { away: {}, job: null };
  await runMoveOff(record, c.deps, "n1", "root@pam", moves([1, "a", "n2"], [2, "b", "n3"]));
  assert.deepEqual(c.started, ["a->n2", "b->n3"]);
  assert.deepEqual(record.away.n1?.guests, [{ id: 1, name: "a", type: "qemu", to: "n2" }, { id: 2, name: "b", type: "qemu", to: "n3" }]);
  assert.equal(record.job?.running, false);
  assert.equal(record.job?.error, null);
  // The first finished move is on disk before the second one starts.
  assert.ok(c.saves.some((s) => s.away.n1?.guests.length === 1 && s.job?.guests[1]?.state === "waiting"));
});

test("a failed move stops the job, keeps what already moved, and says why", async () => {
  const c = cluster({ 1: "n1", 2: "n1", 3: "n1" }, { failId: 2 });
  const record: MoveRecord = { away: {}, job: null };
  await runMoveOff(record, c.deps, "n1", "root@pam", moves([1, "a", "n2"], [2, "b", "n3"], [3, "c", "n2"]));
  assert.deepEqual(c.started, ["a->n2", "b->n3"], "c never started");
  assert.deepEqual(record.away.n1?.guests.map((g) => g.name), ["a"]);
  assert.match(record.job?.error ?? "", /couldn't move b: migration aborted/);
  assert.deepEqual(record.job?.guests.map((g) => g.state), ["done", "failed", "waiting"]);
});

test("each move is planned again first, and a node that filled up stops the job", async () => {
  let calls = 0;
  const c = cluster({ 1: "n1", 2: "n1" }, {
    plan: (_from, ids) => (++calls === 2 ? { moves: [], problems: ["b has nowhere to go: n2 would have 1 GB of memory left."] } : { moves: ids.map((id) => ({ id, name: "a", type: "qemu", target: "n2" })), problems: [] }),
  });
  const record: MoveRecord = { away: {}, job: null };
  await runMoveOff(record, c.deps, "n1", "root@pam", moves([1, "a", "n2"], [2, "b", "n2"]));
  assert.deepEqual(c.started, ["a->n2"]);
  assert.match(record.job?.error ?? "", /room changed while moving: b has nowhere to go/);
});

test("signing out stops the job before the next move", async () => {
  const c = cluster({ 1: "n1", 2: "n1" }, { aliveFor: 1 });
  const record: MoveRecord = { away: {}, job: null };
  await runMoveOff(record, c.deps, "n1", "root@pam", moves([1, "a", "n2"], [2, "b", "n3"]));
  assert.deepEqual(c.started, ["a->n2"]);
  assert.match(record.job?.error ?? "", /signed out/);
});

test("moving home sends back only what's still where BossMox left it, then clears the node", async () => {
  // b was moved by someone else to n4 after BossMox put it on n3: it stays there and drops off the record.
  const c = cluster({ 1: "n2", 2: "n4" });
  const record: MoveRecord = { away: { n1: { by: "root@pam", at: 1, guests: [{ id: 1, name: "a", type: "qemu", to: "n2" }, { id: 2, name: "b", type: "qemu", to: "n3" }] } }, job: null };
  assert.deepEqual(stillAway(record, "n1", c.where).map((g) => g.name), ["a"]);
  await runMoveHome(record, c.deps, "n1", "root@pam");
  assert.deepEqual(c.started, ["a->n1"]);
  assert.equal(c.where.get(1), "n1");
  assert.equal(record.away.n1, undefined);
  assert.equal(record.job?.error, null);
});

test("moving home stops when home has no room, and keeps the record", async () => {
  const c = cluster({ 1: "n2" }, { plan: () => ({ moves: [], problems: ["a (8 GB memory) has nowhere to go: n1 would have 2 GB of memory left."] }) });
  const record: MoveRecord = { away: { n1: { by: "root@pam", at: 1, guests: [{ id: 1, name: "a", type: "qemu", to: "n2" }] } }, job: null };
  await runMoveHome(record, c.deps, "n1", "root@pam");
  assert.deepEqual(c.started, []);
  assert.equal(record.away.n1?.guests.length, 1);
  assert.match(record.job?.error ?? "", /nowhere to go/);
});

test("the record survives on disk, and a job cut off by a BossMox restart reads as stopped", () => {
  const dir = mkdtempSync(join(process.cwd(), "moves-test-"));
  try {
    const file = join(dir, "moves.json");
    writeMoves(file, { away: { n1: { by: "root@pam", at: 1, guests: [{ id: 1, name: "a", type: "qemu", to: "n2" }] } }, job: { kind: "off", node: "n1", by: "root@pam", startedAt: 1, finishedAt: null, running: true, error: null, guests: [{ id: 1, name: "a", target: "n2", state: "done" }, { id: 2, name: "b", target: "n3", state: "moving" }] } });
    const back = readMoves(file);
    assert.equal(back.away.n1?.guests[0]?.to, "n2");
    assert.equal(back.job?.running, false);
    assert.match(back.job?.error ?? "", /restarted/);
    assert.deepEqual(back.job?.guests.map((g) => g.state), ["done", "failed"]);
    writeFileSync(file, "not json");
    assert.deepEqual(readMoves(file), { away: {}, job: null });
    assert.deepEqual(readMoves(join(dir, "missing.json")), { away: {}, job: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
