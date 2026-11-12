import assert from "node:assert/strict";
import { test } from "node:test";
import { asEjected, compareVersions, guestNeed, parseSize, planMoves, type GuestNeed, type NodeRoom } from "../src/placement.js";

const GB = 1024 ** 3;
const node = (name: string, memGb: number, usedGb: number, extra: Partial<NodeRoom> = {}): NodeRoom => ({
  name,
  version: "9.0.3",
  cpuModel: "Xeon",
  cores: 16,
  cpuLoad: 2,
  memTotal: memGb * GB,
  memUsed: usedGb * GB,
  storages: { shared: { free: 1000 * GB, total: 2000 * GB, shared: true }, "local-lvm": { free: 200 * GB, total: 400 * GB, shared: false } },
  ...extra,
});
const guest = (id: number, name: string, memGb: number, extra: Partial<GuestNeed> = {}): GuestNeed => ({
  id,
  name,
  type: "qemu",
  mem: memGb * GB,
  cores: 2,
  cpuLoad: 0.5,
  storages: ["shared"],
  localDisks: [],
  hostCpu: false,
  stuck: null,
  refused: {},
  discSlots: [],
  ...extra,
});

test("guests spread across nodes when one node can't hold them all", () => {
  // Each target has 64 GB and keeps 9.6 GB free, so about 54 GB of room each. 3 x 24 GB can't all fit on one.
  const plan = planMoves("n1", [guest(1, "a", 24), guest(2, "b", 24), guest(3, "c", 24)], [node("n1", 64, 60), node("n2", 64, 4), node("n3", 64, 4)]);
  assert.deepEqual(plan.problems, []);
  const where = plan.moves.map((m) => m.target);
  assert.equal(where.filter((t) => t === "n2").length + where.filter((t) => t === "n3").length, 3);
  assert.ok(where.includes("n2") && where.includes("n3"), "both targets used");
});

test("the emptiest node is picked first", () => {
  const plan = planMoves("n1", [guest(1, "a", 4)], [node("n1", 64, 30), node("n2", 64, 40), node("n3", 64, 10)]);
  assert.equal(plan.moves[0]?.target, "n3");
});

test("nothing moves when one guest can't be placed, and the reason names the node and the number", () => {
  const plan = planMoves("n1", [guest(1, "small", 2), guest(2, "huge", 50)], [node("n1", 64, 60), node("n2", 64, 30)], 15);
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0] as string, /huge \(50 GB memory\) has nowhere to go: n2 would have 0 GB of memory left, under the 15% it keeps free \(9\.6 GB\)/);
});

test("the memory buffer holds: a guest that fits only by eating the buffer is refused", () => {
  // 64 GB node, 50 GB used: 14 GB free, keeps 9.6, so 4.4 GB of room.
  assert.equal(planMoves("n1", [guest(1, "a", 4)], [node("n1", 64, 1), node("n2", 64, 50)], 15).problems.length, 0);
  assert.equal(planMoves("n1", [guest(1, "a", 5)], [node("n1", 64, 1), node("n2", 64, 50)], 15).problems.length, 1);
});

test("the keep-free setting moves every buffer: 10% by default, adjustable", () => {
  // 64 GB node with 50 used: 14 free. At 10% it keeps 6.4, so 7.6 GB of room; at 20% it keeps 12.8, so 1.2.
  assert.equal(planMoves("n1", [guest(1, "a", 7)], [node("n1", 64, 1), node("n2", 64, 50)]).problems.length, 0, "10% by default");
  assert.match(planMoves("n1", [guest(1, "a", 7)], [node("n1", 64, 1), node("n2", 64, 50)], 20).problems[0] as string, /under the 20% it keeps free \(12\.8 GB\)/);
  // Processor: 16 cores, busy 13 + 1 = 14 = 87.5%. Fine at 10% (90% cap), refused at 15% (85% cap).
  assert.equal(planMoves("n1", [guest(1, "a", 1, { cpuLoad: 1 })], [node("n1", 64, 1), node("n2", 64, 1, { cpuLoad: 13 })]).problems.length, 0);
  assert.match(planMoves("n1", [guest(1, "a", 1, { cpuLoad: 1 })], [node("n1", 64, 1), node("n2", 64, 1, { cpuLoad: 13 })], 15).problems[0] as string, /over 85%/);
});

test("guests placed earlier count against the node", () => {
  // n2 has room for one 20 GB guest after the buffer (64 - 20 used - 9.6 = 34.4), not two.
  const plan = planMoves("n1", [guest(1, "a", 20), guest(2, "b", 20)], [node("n1", 64, 1), node("n2", 64, 20)]);
  assert.equal(plan.problems.length, 1);
});

test("processor room: a busy node is passed over", () => {
  const plan = planMoves("n1", [guest(1, "a", 2, { cpuLoad: 4 })], [node("n1", 64, 1), node("n2", 64, 1, { cpuLoad: 11 }), node("n3", 64, 30)]);
  assert.equal(plan.moves[0]?.target, "n3");
  const none = planMoves("n1", [guest(1, "a", 2, { cpuLoad: 4 })], [node("n1", 64, 1), node("n2", 64, 1, { cpuLoad: 11 })]);
  assert.match(none.problems[0] as string, /n2 would be 94% busy, over 90%/);
});

test("a guest with more cores than the node has is refused", () => {
  const plan = planMoves("n1", [guest(1, "a", 2, { cores: 32 })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.match(plan.problems[0] as string, /n2 has 16 cores and a needs 32/);
});

test("a storage the guest uses must exist on the node", () => {
  const plan = planMoves("n1", [guest(1, "a", 2, { storages: ["shared", "fast-zfs"] })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.match(plan.problems[0] as string, /n2 doesn't have the storage fast-zfs/);
});

test("disks on a node's own storage need room on the target, keeping 10% free", () => {
  // local-lvm on n2: 200 GB free of 400, keeps 40, so 160 GB can be copied.
  const ok = planMoves("n1", [guest(1, "a", 2, { storages: ["local-lvm"], localDisks: [{ storage: "local-lvm", bytes: 150 * GB }] })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.deepEqual(ok.problems, []);
  const two = planMoves("n1", [guest(1, "a", 2, { storages: ["local-lvm"], localDisks: [{ storage: "local-lvm", bytes: 100 * GB }] }), guest(2, "b", 2, { storages: ["local-lvm"], localDisks: [{ storage: "local-lvm", bytes: 100 * GB }] })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.equal(two.problems.length, 1, "the second copy doesn't fit once the first is counted");
  assert.match(two.problems[0] as string, /left on local-lvm after copying 100 GB/);
});

test("never to an older Proxmox, and host-processor VMs only to the same processor", () => {
  const older = planMoves("n1", [guest(1, "a", 2)], [node("n1", 64, 1, { version: "9.0.5" }), node("n2", 64, 1, { version: "9.0.3" })]);
  assert.match(older.problems[0] as string, /older Proxmox/);
  const newer = planMoves("n1", [guest(1, "a", 2)], [node("n1", 64, 1, { version: "8.4.1" }), node("n2", 64, 1, { version: "9.0.3" })]);
  assert.deepEqual(newer.problems, []);
  const host = planMoves("n1", [guest(1, "a", 2, { hostCpu: true })], [node("n1", 64, 1), node("n2", 64, 1, { cpuModel: "EPYC" }), node("n3", 64, 30)]);
  assert.equal(host.moves[0]?.target, "n3");
});

test("Proxmox's own refusal for a node wins", () => {
  const plan = planMoves("n1", [guest(1, "a", 2, { refused: { n2: "an HA rule keeps it off (vm:1)" } })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.match(plan.problems[0] as string, /n2 an HA rule keeps it off/);
});

test("a stuck guest stops the plan with its own reason", () => {
  const plan = planMoves("n1", [guest(1, "a", 2, { stuck: "a uses hardware attached to its node, so it can't move." })], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.deepEqual(plan.problems, ["a uses hardware attached to its node, so it can't move."]);
});

test("no other node, no moves", () => {
  assert.match(planMoves("n1", [guest(1, "a", 2)], [node("n1", 64, 1)]).problems[0] as string, /no other online node/);
  assert.deepEqual(planMoves("n1", [], [node("n1", 64, 1)]), { moves: [], problems: [], ejectable: [], unplaced: [], tentative: [] });
});

const sourceStorages = { "local-lvm": { free: 0, total: 0, shared: false }, local: { free: 0, total: 0, shared: false }, nfs: { free: 0, total: 0, shared: true } };
test("guestNeed reads storages, local disks and sizes from the settings", () => {
  const need = guestNeed({
    id: 100, name: "web", type: "qemu", mem: 8 * GB, cores: 4, cpuLoad: 1, hasSnapshots: false, sourceStorages,
    config: { scsi0: "local-lvm:vm-100-disk-0,size=32G", scsi1: "nfs:100/vm-100-disk-1.qcow2,size=100G", efidisk0: "local-lvm:vm-100-disk-2,size=4M", ide2: "none,media=cdrom", cpu: "x86-64-v2-AES" },
    precondition: { local_disks: [{ volid: "local-lvm:vm-100-disk-0", size: 30 * GB }] },
  });
  assert.deepEqual(need.storages.sort(), ["local-lvm", "nfs"]);
  assert.deepEqual(need.localDisks, [{ storage: "local-lvm", bytes: 30 * GB }, { storage: "local-lvm", bytes: 4 * 1024 ** 2 }]);
  assert.equal(need.hostCpu, false);
  assert.equal(need.stuck, null);
});

test("guestNeed: what keeps a guest from moving at all", () => {
  const base = { id: 1, name: "g", type: "qemu" as const, mem: GB, cores: 1, cpuLoad: 0, hasSnapshots: false, sourceStorages, precondition: {} };
  assert.match(guestNeed({ ...base, config: {}, precondition: { local_resources: ["hostpci0"] } }).stuck ?? "", /hardware attached/);
  assert.match(guestNeed({ ...base, config: { ide2: "local:iso/alpine.iso,media=cdrom" } }).stuck ?? "", /Eject the disc/);
  assert.equal(guestNeed({ ...base, config: { ide2: "nfs:iso/alpine.iso,media=cdrom" } }).stuck, null, "a disc on shared storage is fine");
  assert.match(guestNeed({ ...base, config: { ide2: "cdrom,media=cdrom" } }).stuck ?? "", /node's own disc drive/);
  assert.equal(guestNeed({ ...base, config: { ide2: "none,media=cdrom" } }).stuck, null, "an empty drive is fine");
  assert.equal(guestNeed({ ...base, config: { ide2: "local-lvm:vm-1-cloudinit,media=cdrom" } }).stuck, null, "the cloud-init drive moves with the VM");
  assert.match(guestNeed({ ...base, config: { scsi0: "local-lvm:vm-1-disk-0,size=8G" }, hasSnapshots: true }).stuck ?? "", /snapshot/);
  assert.equal(guestNeed({ ...base, config: { cpu: "host" } }).hostCpu, true);
  assert.equal(guestNeed({ ...base, config: { cpu: "cputype=host,flags=+aes" } }).hostCpu, true);
});

test("guestNeed reads Proxmox's refusals, ignoring empty entries, for VMs and containers", () => {
  const base = { id: 1, name: "g", mem: GB, cores: 1, cpuLoad: 0, hasSnapshots: false, sourceStorages, config: {} };
  const vm = guestNeed({ ...base, type: "qemu", precondition: { not_allowed_nodes: { n2: { unavailable_storages: ["fast"] }, n3: {} } } });
  assert.deepEqual(vm.refused, { n2: "doesn't have the storage fast" });
  const ct = guestNeed({ ...base, type: "lxc", config: { rootfs: "local-lvm:vm-1-disk-0,size=8G" }, precondition: { "not-allowed-nodes": { n2: { "blocking-ha-resources": [{ sid: "ct:1", cause: "node-affinity" }] } } } });
  assert.match(ct.refused.n2 ?? "", /HA rule/);
  assert.deepEqual(ct.localDisks, [{ storage: "local-lvm", bytes: 8 * GB }]);
});

test("sizes and versions", () => {
  assert.equal(parseSize("local-lvm:vm-1-disk-0,size=32G"), 32 * GB);
  assert.equal(parseSize("x:y,iothread=1,size=512M"), 512 * 1024 ** 2);
  assert.equal(parseSize("x:y"), 0);
  assert.ok(compareVersions("8.4.1", "9.0.3") < 0);
  assert.equal(compareVersions("9.0.3", "9.0.3"), 0);
  assert.ok(compareVersions("9.0.10", "9.0.3") > 0);
});

test("a VM stuck only by a disc from local storage can be freed by ejecting it, from every drive that holds one", () => {
  const base = { id: 7, name: "APP", type: "qemu" as const, mem: GB, cores: 1, cpuLoad: 0, hasSnapshots: false, sourceStorages, precondition: {} };
  const two = guestNeed({ ...base, config: { ide0: "local:iso/virtio.iso,media=cdrom", ide2: "none,media=cdrom", sata1: "local:iso/b.iso,media=cdrom", scsi0: "nfs:7/vm-7-disk-0.qcow2" } });
  assert.deepEqual(two.discSlots, ["ide0", "sata1"]);
  const plan = planMoves("n1", [two], [node("n1", 64, 1), node("n2", 64, 1)]);
  assert.deepEqual(plan.ejectable, [{ id: 7, name: "APP", slots: ["ide0", "sata1"] }]);
  assert.equal(plan.moves.length, 0, "still nothing moves until it's ejected");
  // A disc on shared storage isn't a problem, and passed-through hardware can't be fixed by ejecting.
  assert.deepEqual(guestNeed({ ...base, config: { ide0: "nfs:iso/virtio.iso,media=cdrom" } }).discSlots, []);
  assert.deepEqual(guestNeed({ ...base, config: { ide0: "local:iso/virtio.iso,media=cdrom" }, precondition: { local_resources: ["hostpci0"] } }).discSlots, []);
  assert.deepEqual(guestNeed({ ...base, config: { ide2: "local:7/vm-7-cloudinit.qcow2,media=cdrom" } }).discSlots, [], "the cloud-init drive moves with the VM");
  assert.deepEqual(guestNeed({ ...base, config: { ide2: "cdrom,media=cdrom" } }).discSlots, ["ide2"], "the node's own drive can be ejected too");
});

test("each guest that can't be placed is named, and the rest still get a place", () => {
  const plan = planMoves("n1", [guest(1, "small", 2), guest(2, "huge", 60), guest(3, "stuck", 1, { stuck: "stuck uses hardware attached to its node, so it can't move." })], [node("n1", 64, 1), node("n2", 64, 30)]);
  assert.deepEqual(plan.moves, [], "all or nothing for a plain move");
  assert.deepEqual(plan.unplaced?.map((u) => u.id).sort(), [2, 3]);
  assert.deepEqual(plan.tentative?.map((m) => `${m.id}->${m.target}`), ["1->n2"]);
});

test("planning as if ejected empties disc drives, keeps cloud-init, and names the slots (#48)", () => {
  const { config, slots } = asEjected({ ide2: "local:iso/setup.iso,media=cdrom", sata1: "cdrom,media=cdrom", ide0: "local-lvm:vm-1-cloudinit,media=cdrom", ide3: "none,media=cdrom", scsi0: "local-lvm:vm-1-disk-0" });
  assert.deepEqual(slots, ["ide2", "sata1"]);
  assert.equal(config.ide2, "none,media=cdrom");
  assert.equal(config.ide0, "local-lvm:vm-1-cloudinit,media=cdrom");
  assert.equal(config.scsi0, "local-lvm:vm-1-disk-0");
});
