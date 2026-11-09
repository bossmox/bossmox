import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildStorageMap, poolItems, type NodeStorageInput } from "../src/storage-map.js";

/** Proxmox's real answers, captured from the Tiny (an ordinary LVM install plus a second drive) and two lab nodes. */
function fixture(name: string): NodeStorageInput {
  const d = JSON.parse(readFileSync(new URL(`../../test/${name}.json`, import.meta.url), "utf8"));
  return { ...d, zfs: d.zfsDetail };
}
const pool = (m: ReturnType<typeof buildStorageMap>, id: string) => m.groups.flatMap((g) => g.pools).find((p) => p.id === id);

test("an ordinary install: local and local-lvm both sit on the system drive, qcow on the second", () => {
  const m = buildStorageMap(fixture("storage-lvm-install"), false);
  assert.equal(m.groups.length, 2);
  const [system, second] = m.groups;
  assert.deepEqual(system!.disks.map((d) => [d.path, d.system, d.kind]), [["/dev/nvme0n1", true, "NVMe SSD"]]);
  assert.deepEqual(system!.pools.map((p) => p.id), ["local", "local-lvm"]);
  assert.deepEqual(second!.disks.map((d) => d.path), ["/dev/sda"]);
  assert.deepEqual(second!.pools.map((p) => p.id), ["qcow"]);
  assert.deepEqual([m.empty, m.unplaced, m.network], [[], [], []]);
});

test("pools are named for their job, and say what's using their space", () => {
  const m = buildStorageMap(fixture("storage-lvm-install"), false);
  const thin = pool(m, "local-lvm")!;
  assert.equal(thin.title, "Pool for VM and container disks");
  assert.equal(thin.thin, true);
  assert.deepEqual(thin.guests.map((g) => [g.vmid, g.gb]), [[100, 32], [101, 1]]);
  const local = pool(m, "local")!;
  assert.equal(local.title, "Folder for files");
  assert.equal(local.otherLabel, "Proxmox itself and other files");
  assert.ok(local.otherGb > 5, "the system's own files show up instead of going missing");
  assert.equal(pool(m, "qcow")!.otherLabel, "Other files");
});

test("a single node isn't told about other nodes", () => {
  assert.equal(pool(buildStorageMap(fixture("storage-lvm-install"), false), "local-lvm")!.otherNodes, "");
  assert.match(pool(buildStorageMap(fixture("storage-lvm-install"), true), "local-lvm")!.otherNodes, /can't restart on another node/);
});

test("a ZFS mirror shows as one pool on two disks, and says one can fail", () => {
  const m = buildStorageMap(fixture("storage-zfs-mirror"), true);
  const g = m.groups.find((x) => x.pools.some((p) => p.id === "tank"))!;
  assert.deepEqual(g.disks.map((d) => d.path), ["/dev/sdb", "/dev/sdc"]);
  const tank = g.pools[0]!;
  assert.match(tank.layout, /^Mirror of 2 disks/);
  assert.match(tank.otherNodes, /copied to another node on a schedule/);
  assert.equal(tank.snapshots, "Snapshots work.");
});

test("a thin pool and a folder on their own disks each land on the right one", () => {
  const m = buildStorageMap(fixture("storage-thin-and-folder"), true);
  assert.deepEqual(m.groups.map((g) => [g.disks.map((d) => d.path).join(), g.pools.map((p) => p.id).join()]), [
    ["/dev/sda", "local"],
    ["/dev/sdb", "fast"],
    ["/dev/sdc", "files"],
  ]);
  assert.match(pool(m, "files")!.details, /ext4 on \/dev\/sdc1/);
});

test("a NAS shows under network storage, usable by every node", () => {
  const input = fixture("storage-thin-and-folder");
  input.config.push({ storage: "nas", type: "nfs", content: "backup,images", server: "10.0.30.244", export: "/srv/nfs" });
  input.status.push({ storage: "nas", type: "nfs", active: 1, enabled: 1, shared: 1, total: 100 * 1024 ** 3, used: 10 * 1024 ** 3, avail: 90 * 1024 ** 3 });
  const m = buildStorageMap(input, true);
  assert.deepEqual(m.network.map((p) => [p.id, p.title, p.details]), [["nas", "Network share (NFS)", "10.0.30.244/srv/nfs"]]);
  assert.match(m.network[0]!.otherNodes, /restart there if this one fails/);
  assert.ok(!m.groups.some((g) => g.pools.some((p) => p.id === "nas")));
});

test("a thin pool given out past its size says so", () => {
  const input = fixture("storage-thin-and-folder");
  input.content.fast = [{ volid: "fast:vm-951-disk-0", content: "images", size: 6 * 1024 ** 3, vmid: 951 }];
  assert.equal(pool(buildStorageMap(input, true), "fast")!.overGivenGb, 6);
  assert.equal(pool(buildStorageMap(fixture("storage-thin-and-folder"), true), "fast")!.overGivenGb, null);
});

test("an empty disk is offered for storage, and a mount BossMox can't match isn't guessed", () => {
  const input = fixture("storage-thin-and-folder");
  input.disks.push({ devpath: "/dev/sdd", size: 16 * 1024 ** 3, model: "Spare" });
  input.config.push({ storage: "mystery", type: "dir", content: "backup", path: "/mnt/data" });
  input.status.push({ storage: "mystery", type: "dir", active: 1, enabled: 1, total: 1, used: 0, avail: 1 });
  const m = buildStorageMap(input, true);
  assert.deepEqual(m.empty.map((d) => d.path), ["/dev/sdd"]);
  assert.deepEqual(m.unplaced.map((p) => p.id), ["mystery"]);
});

test("a disk kept as a file counts the space it really takes, not its size", () => {
  const m = buildStorageMap(fixture("storage-zfs-mirror"), true);
  const local = pool(m, "local")!;
  assert.deepEqual(local.guests, [{ vmid: 100, gb: 16, usedGb: 0 }]);
  assert.equal(local.otherLabel, "Proxmox itself and other files");
  assert.ok(local.otherGb > 4, "the 16 GB disk no longer hides the system's own files");
  assert.equal(pool(m, "tank")!.guests[0]!.usedGb, null, "a pool doesn't say, so nothing is made up");
});


const vols = [
  { volid: "fast:vm-951-disk-0", content: "images", size: 2 * 1024 ** 3, vmid: 951 },
  { volid: "fast:vm-958-disk-0", content: "images", size: 1024 ** 3, vmid: 958 },
  { volid: "fast:base-700-disk-0", content: "images", size: 1024 ** 3, vmid: 700 },
  { volid: "local:iso/debian.iso", content: "iso", size: 1024 ** 3 },
  { volid: "local:iso/old.iso", content: "iso", size: 1024 ** 3 },
  { volid: "local:backup/vzdump-qemu-951.vma.zst", content: "backup", size: 1024 ** 3, vmid: 951 },
];
const guests = [
  { vmid: 951, name: "thin-guest", known: true, refs: ["fast:vm-951-disk-0", "local:iso/debian.iso"] },
  // A linked clone of a template that's since been deleted still points at the template's base disk.
  { vmid: 701, name: "clone", known: true, refs: ["fast:base-700-disk-0/vm-701-disk-0"] },
];
const item = (list: ReturnType<typeof poolItems>, volid: string) => list.find((i) => i.volid === volid)!;

test("a disk whose guest exists is never deletable, a true leftover is", () => {
  const list = poolItems(vols, guests, true);
  assert.deepEqual([item(list, "fast:vm-951-disk-0").canDelete, item(list, "fast:vm-951-disk-0").whyNot], [false, "It's thin-guest's disk."]);
  assert.deepEqual([item(list, "fast:vm-958-disk-0").canDelete, item(list, "fast:vm-958-disk-0").leftover], [true, true]);
  assert.equal(item(list, "fast:base-700-disk-0").canDelete, false, "a linked clone still needs its base disk");
});

test("a disc in a drive can't go, a spare one can, and backups live in Backups", () => {
  const list = poolItems(vols, guests, true);
  assert.equal(item(list, "local:iso/debian.iso").whyNot, "It's in thin-guest's disc drive.");
  assert.equal(item(list, "local:iso/old.iso").canDelete, true);
  assert.equal(item(list, "local:iso/old.iso").name, "old.iso");
  assert.equal(item(list, "local:backup/vzdump-qemu-951.vma.zst").canDelete, false);
});

test("nothing is deletable while BossMox can't see everything", () => {
  assert.match(item(poolItems(vols, guests, false), "fast:vm-958-disk-0").whyNot, /node is offline/);
  const blind = [...guests, { vmid: 960, name: "unread", known: false, refs: [] }];
  assert.match(item(poolItems(vols, blind, true), "local:iso/old.iso").whyNot, /couldn't read every guest/);
});
