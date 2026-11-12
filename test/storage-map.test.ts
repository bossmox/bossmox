import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildStorageMap, isListedBackup, poolItems, poolRemoval, type NodeStorageInput } from "../src/storage-map.js";

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

test("deleting a pool: only an empty, unused pool on its own drives", () => {
  const input = fixture("storage-thin-and-folder");
  const mounts = [{ path: "/mnt/pve/files", type: "ext4", unitfile: "/etc/systemd/system/mnt-pve-files.mount" }];
  const cfg = (id: string) => input.config.find((c) => c.storage === id);
  const empty = buildStorageMap({ ...input, content: { ...input.content, fast: [] } }, true);
  assert.deepEqual(poolRemoval(empty, "files", cfg("files"), mounts, []), { path: "disks/directory/files?cleanup-config=1&cleanup-disks=1", disks: ["/dev/sdc"] });
  assert.equal(poolRemoval(empty, "fast", cfg("fast"), mounts, []).path, "disks/lvmthin/fast?volume-group=fast&cleanup-config=1&cleanup-disks=1");
  const full = buildStorageMap(input, true);
  assert.throws(() => poolRemoval(full, "fast", cfg("fast"), mounts, []), /still something on it: 1 disk/);
  assert.throws(() => poolRemoval(empty, "fast", cfg("fast"), mounts, ["thin-guest"]), /thin-guest still uses it/);
  assert.throws(() => poolRemoval(empty, "local", cfg("local"), mounts, []), /system disk/);
  assert.throws(() => poolRemoval(empty, "files", cfg("files"), [], []), /wasn't made by Proxmox's disk tools/);
});

test("deleting a ZFS mirror erases the whole pool, never rpool or part of one", () => {
  const input = fixture("storage-zfs-mirror");
  const m = buildStorageMap({ ...input, content: { ...input.content, tank: [] } }, true);
  const tank = input.config.find((c) => c.storage === "tank")!;
  assert.deepEqual(poolRemoval(m, "tank", tank, [], []).disks, ["/dev/sdb", "/dev/sdc"]);
  assert.throws(() => poolRemoval(m, "tank", { ...tank, pool: "tank/data" }, [], []), /part of a bigger ZFS pool/);
});

test("Delete pool won't erase what BossMox can't see (security review M1)", () => {
  const input = fixture("storage-zfs-mirror");
  const tank = input.config.find((c) => c.storage === "tank")!;
  const empty = { ...input, content: { ...input.content, tank: [] } };
  // A pool that didn't mount.
  const down = { ...empty, status: empty.status.map((s) => (s.storage === "tank" ? { ...s, active: 0 } : s)) };
  assert.throws(() => poolRemoval(buildStorageMap(down, true), "tank", tank, [], []), /isn't reachable right now/);
  // Its contents couldn't be read: never taken as empty.
  assert.throws(() => poolRemoval(buildStorageMap({ ...empty, contentUnknown: ["tank"] }, true), "tank", tank, [], []), /couldn't read what's on tank/);
  // Another dataset (tank/photos) uses 3 GB that Proxmox doesn't list.
  const photos = { ...empty, status: empty.status.map((s) => (s.storage === "tank" ? { ...s, used: 3 * 1024 ** 3 } : s)) };
  assert.throws(() => poolRemoval(buildStorageMap(photos, true), "tank", tank, [], []), /doesn't keep track of is using 3 GB/);
});

test("a drive given to a VM directly is never empty in the storage view", () => {
  const input = fixture("storage-thin-and-folder");
  input.disks.push({ devpath: "/dev/sdd", size: 16 * 1024 ** 3, model: "Spare", by_id_link: "/dev/disk/by-id/ata-Spare_123" } as never);
  const m = buildStorageMap({ ...input, passedThrough: [{ device: "/dev/disk/by-id/ata-Spare_123", guest: "nas-vm" }] }, true);
  assert.deepEqual(m.empty.map((d) => d.path), []);
  assert.equal(m.otherDisks.find((d) => d.path === "/dev/sdd")?.givenTo, "nas-vm");
});

test("an account that can't see every guest is never told a disk is left over (security review L4)", () => {
  const list = poolItems(vols, guests, true, false);
  assert.equal(list.find((i) => i.volid === "fast:vm-958-disk-0")!.canDelete, false);
  assert.match(list.find((i) => i.volid === "fast:vm-958-disk-0")!.whyNot, /can't see every guest/);
  assert.equal(list.find((i) => i.volid === "local:iso/old.iso")!.canDelete, true, "a spare disc is still fine");
});

test("Delete backup only deletes a volume its storage lists as a backup (review S4)", () => {
  const volumes = [
    { volid: "nas:backup/vzdump-qemu-100-2026_11_12-01_00_00.vma.zst", content: "backup" },
    { volid: "nas:100/vm-100-disk-0.qcow2", content: "images" },
  ];
  assert.equal(isListedBackup(volumes, "nas:backup/vzdump-qemu-100-2026_11_12-01_00_00.vma.zst"), true);
  assert.equal(isListedBackup(volumes, "nas:100/vm-100-disk-0.qcow2"), false, "a guest's own disk on the same storage");
  assert.equal(isListedBackup(volumes, "local-lvm:vm-100-disk-0"), false, "a volume that storage doesn't hold");
});
