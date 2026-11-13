import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import { createHa, diskProblems, fencingWarnings, voteProblem } from "../src/ha.js";
import type { PveClient } from "../src/pve.js";

const shared = new Set(["ISCSI_SHARE"]);

test("disks: shared storage passes; a node's own disk, folder or disc doesn't, and a disc can be ejected (ADR 0036)", () => {
  assert.deepEqual(diskProblems("qemu", { scsi0: "ISCSI_SHARE:vm-101-disk-0,size=1G", ide2: "none,media=cdrom", net0: "virtio=AA" }, shared, "n1"), []);
  const local = diskProblems("qemu", { scsi0: "local-lvm:vm-1-disk-0,size=8G", ide2: "local:iso/debian.iso,media=cdrom", efidisk0: "ISCSI_SHARE:vm-1-disk-1" }, shared, "n1");
  assert.equal(local.length, 2);
  assert.match(local[0]!.text, /scsi0 is on local-lvm, which only n1 has/);
  assert.deepEqual(local[1], { text: "The disc debian.iso is on local, which only n1 has. Take it out first.", fix: "eject" });
  assert.match(diskProblems("lxc", { rootfs: "ISCSI_SHARE:vm-2-disk-0", mp0: "/srv/data,mp=/data" }, shared, "n1")[0]!.text, /mp0 is a folder on n1/);
  assert.deepEqual(diskProblems("qemu", { ide0: "ISCSI_SHARE:vm-1-cloudinit,media=cdrom" }, new Set(), "n1"), [], "the cloud-init drive isn't a disc to eject");
});

test("votes: three, or a tie-breaker's, or HA can't help", () => {
  assert.equal(voteProblem(3, 3), null);
  assert.equal(voteProblem(3, 2), null, "two nodes and a working tie-breaker");
  assert.match(voteProblem(2, 2)?.text ?? "", /only 2 votes/);
  assert.match(voteProblem(1, 1)?.text ?? "", /needs a cluster/);
});

test("the fencing warning names what this cluster has against restarts that weren't needed (Rocky, 2026-11-12)", () => {
  const offer = fencingWarnings({ state: "offer", network: "10.0.31.0/24", addresses: {}, sharesMoves: true, link: 1 }, { known: true, shared: true, moveNet: "10.0.30.0/24", others: [], batch: 1 });
  assert.equal(offer.safe, false);
  assert.match(offer.lines[0]!, /one network.*didn't need it.*10\.0\.31\.0\/24/);
  assert.match(offer.lines[1]!, /2026-11-10/);
  const ok = fencingWarnings({ state: "backed-up", links: 2 }, { known: true, shared: false, moveNet: "10.0.31.0/24", others: [], batch: 3 });
  assert.equal(ok.safe, true);
  assert.match(ok.lines[0]!, /keeps HA from restarting guests that didn't need it/);
  assert.match(fencingWarnings({ state: "no-port", nodes: ["c"] }, null).lines[0]!, /not every node has a second port/);
});

function fake(opts: { disk?: string; lock?: string; hastate?: string; votes?: number; cantMove?: string | null; haGuests?: number; stuck?: boolean } = {}) {
  const calls: string[] = [];
  let hastate = opts.hastate;
  const pve = {
    get: async (path: string) => {
      if (path === "/cluster/resources?type=vm") return [{ type: "qemu", vmid: 101, name: "web", node: "n3", status: "running", ...(hastate ? { hastate } : {}) }];
      if (path === "/cluster/resources?type=storage") return [{ type: "storage", storage: "ISCSI_SHARE", node: "n3", shared: 1 }, { type: "storage", storage: "local-lvm", node: "n3", shared: 0 }];
      if (path === "/nodes/n3/qemu/101/config") return { scsi0: opts.disk ?? "ISCSI_SHARE:vm-101-disk-0", ...(opts.lock ? { lock: opts.lock } : {}) };
      if (path === "/cluster/config/nodes") return Array((opts.votes ?? 3)).fill({ quorum_votes: 1 });
      if (path === "/cluster/config/qdevice") return {};
      if (path === "/cluster/ha/resources") return Array(opts.haGuests ?? 0).fill({ sid: "vm:102" });
      throw new Error(`unexpected ${path}`);
    },
    post: async (path: string, _w: unknown, form: Record<string, string>) => { calls.push(`POST ${path} ${JSON.stringify(form)}`); return null; },
    put: async (path: string, _w: unknown, form: Record<string, string>) => {
      calls.push(`PUT ${path} ${JSON.stringify(form)}`);
      // HA takes the new state on its next cycle, and reports disabled as its own state, stopped. A stuck one stays in error.
      if (path.startsWith("/cluster/ha/resources/") && !opts.stuck) hastate = form.state === "disabled" ? "stopped" : form.state;
      return null;
    },
    delete: async (path: string) => { calls.push(`DELETE ${path}`); return null; },
  } as unknown as PveClient;
  const ha = createHa({ pve, cantMove: async () => opts.cantMove ?? null, heartbeat: async () => ({ state: "backed-up", links: 2 }), netCheck: async () => null, audit: () => {}, wait: async () => {} });
  return { ha, calls };
}
const root = { username: "root@pam", ticket: "T" } as Session;

test("protect: checks everything, then asks Proxmox for vm:101 started and nothing else", async () => {
  const { ha, calls } = fake();
  const c = await ha.check(root, 101);
  assert.deepEqual(c.problems, []);
  assert.equal(c.firstTime, true);
  await ha.protect(root, 101);
  assert.deepEqual(calls, ['POST /cluster/ha/resources {"sid":"vm:101","state":"started"}']);
});

test("protect is refused, with nothing sent, for a local disk, two votes, or nowhere to go", async () => {
  for (const opts of [{ disk: "local-lvm:vm-101-disk-0" }, { votes: 2 }, { cantMove: "No other node has room for it." }]) {
    const { ha, calls } = fake(opts);
    await assert.rejects(ha.protect(root, 101), (e: { status: number }) => e.status === 400);
    assert.deepEqual(calls, []);
  }
  const { ha } = fake({ haGuests: 1 });
  assert.equal((await ha.check(root, 101)).firstTime, false, "another guest is already protected, so fencing is armed");
});

test("recover: unlocks a locked guest as root, then disabled and started under HA; others are told how", async () => {
  const { ha, calls } = fake({ hastate: "error", lock: "migrate" });
  await ha.recover(root, 101);
  assert.deepEqual(calls, [
    'PUT /nodes/n3/qemu/101/config {"delete":"lock","skiplock":"1"}',
    'PUT /cluster/ha/resources/vm%3A101 {"state":"disabled"}',
    'PUT /cluster/ha/resources/vm%3A101 {"state":"started"}',
  ]);
  const other = fake({ hastate: "error", lock: "migrate" });
  await assert.rejects(other.ha.recover({ ...root, username: "admin@pve" } as Session, 101), (e: { status: number; message: string }) => e.status === 403 && /qm unlock 101/.test(e.message));
  assert.deepEqual(other.calls, []);
  await assert.rejects(fake({ hastate: "started" }).ha.recover(root, 101), (e: { status: number }) => e.status === 400);
});

test("recover waits for HA to leave its error state, and says so if it doesn't within a minute (lab, 2026-11-12)", async () => {
  const { ha, calls } = fake({ hastate: "error", stuck: true });
  await assert.rejects(ha.recover(root, 101), (e: { status: number; message: string }) => e.status === 502 && /within a minute/.test(e.message));
  assert.equal(calls.filter((c) => c.includes('"started"')).length, 0, "started is never sent while HA still says error");
});
