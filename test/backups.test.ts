import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBackups, describeSchedule } from "../src/backups.js";

test("everyday schedules read as words", () => {
  assert.equal(describeSchedule("21:00"), "Every day at 21:00");
  assert.equal(describeSchedule("sat 02:30"), "Every Saturday at 02:30");
  assert.equal(describeSchedule("daily"), "Every day at midnight");
  assert.equal(describeSchedule("mon..fri 02:00"), "On the schedule mon..fri 02:00", "unusual ones aren't guessed at");
});

const file = (vmid: number, ctime: number, size = 200 * 1024 ** 2, more = {}) => ({ volid: `local:backup/vzdump-lxc-${vmid}-${ctime}.tar.zst`, vmid, ctime, size, ...more });

test("backups group by guest, newest first, across servers", () => {
  const view = buildBackups(
    [
      { node: "a", storage: "local", file: file(200, 100) },
      { node: "b", storage: "nas", file: file(200, 300) },
      { node: "a", storage: "local", file: file(201, 50) },
    ],
    [
      { id: 200, name: "web" },
      { id: 201, name: "db" },
    ],
    [],
    [],
  );
  assert.deepEqual(
    view.groups.map((g) => g.name),
    ["db", "web"],
  );
  const web = view.groups[1];
  assert.deepEqual(
    web?.backups.map((b) => b.node),
    ["b", "a"],
  );
  assert.equal(web?.backups[0]?.size, "200 MB");
});

test("a deleted guest's backups stay visible and say so", () => {
  const view = buildBackups([{ node: "a", storage: "local", file: file(999, 100) }], [{ id: 200, name: "web" }], [], []);
  assert.equal(view.groups[0]?.name, "Deleted guest 999");
  assert.equal(view.groups[0]?.exists, false);
});

test("a backup with no type gets it from the file name", () => {
  const view = buildBackups([{ node: "a", storage: "local", file: { volid: "local:backup/vzdump-qemu-300-x.vma.zst", vmid: "300", ctime: 1 } }], [{ id: 300, name: "vm" }], [], []);
  assert.equal(view.groups[0]?.type, "qemu");
});

test("schedules name their guests and how many they keep", () => {
  const view = buildBackups(
    [],
    [{ id: 200, name: "web" }],
    [
      { id: "a", schedule: "21:00", all: 1, storage: "nas", enabled: 1, "prune-backups": "keep-last=3" },
      { id: "b", schedule: "sun 01:00", vmid: "200,201", storage: "nas", enabled: 0, "prune-backups": { "keep-last": 7 } },
    ],
    [{ vmid: 200 }],
  );
  assert.deepEqual(
    view.schedules.map((s) => s.what),
    ["Everything", "web, Guest 201"],
  );
  assert.deepEqual(
    view.schedules.map((s) => s.on),
    [true, false],
  );
  assert.deepEqual(
    view.schedules.map((s) => s.keep),
    [3, 7],
  );
  assert.deepEqual(view.unscheduled, ["web"]);
});
