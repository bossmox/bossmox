import assert from "node:assert/strict";
import { test } from "node:test";
import { type MoveDeps, type MoveRecord, movePercent, runMoveOff } from "../src/moves.js";

test("how far a move is, from Proxmox's own progress lines (formats from its code, 2026-11-19)", () => {
  // A running VM's memory: no percent given, so X of Y.
  assert.equal(movePercent(["2026-11-19 20:44:52 migration active, transferred 512.0 MiB of 2.0 GiB VM-state, 89.4 MiB/s"]), 25);
  // A disk being copied: Proxmox's own percent wins.
  assert.equal(movePercent(["drive-scsi0: transferred 3.2 GiB of 32.0 GiB (10.00%) in 12s"]), 10);
  // Storage copy.
  assert.equal(movePercent(["transferred 1.0 GiB of 4.0 GiB (25.00%)"]), 25);
  // The newest line counts.
  assert.equal(movePercent(["transferred 1.0 GiB of 4.0 GiB (25.00%)", "noise", "transferred 3.0 GiB of 4.0 GiB (75.00%)", "other"]), 75);
  assert.equal(movePercent(["migration status: completed", "average migration speed: 528.8 MiB/s"]), null, "no progress line, no number");
  assert.equal(movePercent(["transferred 9.0 GiB of 4.0 GiB VM-state"]), 100, "never over 100");
  assert.equal(movePercent(["transferred 1 B of 0 B VM-state"]), 100, "a zero total doesn't break it");
  assert.equal(movePercent(["<script> transferred lots of things"]), null);
});

test("a moving guest's percent is kept on the move job while it moves (ADR 0044)", async () => {
  const record: MoveRecord = { away: {}, job: null };
  const percents: (number | undefined)[] = [];
  let reads = 0;
  const lines = ["starting migration", "migration active, transferred 256.0 MiB of 1.0 GiB VM-state, 50 MiB/s", "migration active, transferred 768.0 MiB of 1.0 GiB VM-state, 50 MiB/s"];
  const asked: number[] = [];
  const deps: MoveDeps = {
    plan: async () => ({ moves: [{ id: 101, name: "web", type: "qemu", target: "n3" }], problems: [] }) as never,
    migrate: async () => "UPID:n1:1:2:3:qmigrate:101:root@pam:",
    // Long enough for the log to be read twice: every third check (about 6 s).
    task: async () => ({ finished: ++reads > 6, ok: true, error: "" }),
    progress: async (_n, _u, start) => {
      asked.push(start);
      return lines.slice(start, start + 2);
    },
    where: async () => new Map([[101, "n3"]]),
    stopped: () => null,
    wait: async () => {},
    save: (r) => percents.push(r.job?.guests[0]?.percent),
  };
  await runMoveOff(record, deps, "n1", "root@pam", [{ id: 101, name: "web", type: "qemu", target: "n3" }]);
  assert.ok(percents.includes(25), `saw ${percents.join(",")}`);
  assert.ok(percents.includes(75));
  assert.deepEqual(asked, [0, 2], "each read starts where the last one ended");
  assert.equal(record.job?.guests[0]?.state, "done");
});

test("BossMox's own guest moves after the others, even though each round plans again (review 0.3.2)", async () => {
  const record: MoveRecord = { away: {}, job: null };
  const order: number[] = [];
  const all = [
    { id: 100, name: "bossmox", type: "qemu" as const, target: "n3", mem: 8 },
    { id: 101, name: "web", type: "qemu" as const, target: "n3", mem: 1 },
    { id: 102, name: "db", type: "qemu" as const, target: "n2", mem: 2 },
  ];
  const where = new Map<number, string>([
    [100, "n1"],
    [101, "n1"],
    [102, "n1"],
  ]);
  const deps: MoveDeps = {
    // Planned again each round, biggest first, as the real planner sorts them.
    plan: async (_f, ids) => ({ moves: all.filter((m) => ids.includes(m.id)), problems: [] }) as never,
    migrate: async (m) => {
      order.push(m.id);
      where.set(m.id, m.target);
      return `UPID:n1:1:2:3:qmigrate:${m.id}:root@pam:`;
    },
    task: async () => ({ finished: true, ok: true, error: "" }),
    where: async () => where,
    stopped: () => null,
    wait: async () => {},
    save: () => {},
  };
  await runMoveOff(record, deps, "n1", "root@pam", all, 2, 100);
  assert.equal(order.at(-1), 100, `moved in the order ${order.join(", ")}`);
  assert.equal(order.length, 3);
});
