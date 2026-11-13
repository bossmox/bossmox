import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCanWipe, buildStorageList, diskStorageForm, eraseBlocker, networkForm, readHardDisks, setupPlan, storageBlockers, usesForm } from "../src/storage.js";

const nfs = { kind: "nfs", id: "nas", host: "10.0.30.244", path: "/srv/nfs/backups", username: "", password: "", domain: "", uses: ["backup", "iso"] };
const smb = { ...nfs, kind: "smb", path: "bmxsmb", username: "bmx", password: "secret" };

test("NFS and SMB shares become the right form", () => {
  assert.deepEqual(networkForm(nfs), { storage: "nas", type: "nfs", server: "10.0.30.244", export: "/srv/nfs/backups", content: "backup,iso" });
  assert.deepEqual(networkForm(smb), { storage: "nas", type: "cifs", server: "10.0.30.244", share: "bmxsmb", content: "backup,iso", username: "bmx", password: "secret" });
  assert.equal(networkForm({ ...smb, username: "", password: "" }).username, undefined);
});

test("nothing can be slipped in through a field", () => {
  assert.throws(() => networkForm({ ...nfs, id: "1bad" }), /starts with/);
  assert.throws(() => networkForm({ ...nfs, id: "a,type=dir" }), /starts with/);
  assert.throws(() => networkForm({ ...nfs, host: "x;rm" }), /address/);
  assert.throws(() => networkForm({ ...nfs, path: "/a,options=rw" }), /shared folder/);
  assert.throws(() => networkForm({ ...smb, path: "a,b" }), /shared folder/);
  assert.throws(() => networkForm({ ...smb, username: "a b" }), /username/);
  assert.throws(() => networkForm({ ...smb, password: "" }), /password/);
  assert.throws(() => networkForm({ ...nfs, kind: "dir" }), /NFS or SMB/);
  assert.throws(() => networkForm({ ...nfs, uses: ["snippets"] }), /at least one/);
});

test("disk-only storage can't be asked to hold files", () => {
  assert.equal(usesForm("zfspool", ["images", "backup", "rootdir"]), "images,rootdir");
  assert.throws(() => usesForm("lvmthin", ["backup"]), /at least one/);
  assert.equal(usesForm("nfs", ["backup", "backup"]), "backup");
  assert.throws(() => usesForm("nfs", "backup"), /at least one/);
});

const raw = [
  { devpath: "/dev/sda", size: 32 * 1024 ** 3, used: "partitions", model: "QEMU_HARDDISK", health: "OK", type: "unknown" },
  { devpath: "/dev/sda1", parent: "/dev/sda", used: "ext4", mounted: 1 },
  { devpath: "/dev/sdb", size: 8 * 1024 ** 3, health: "PASSED", type: "ssd", wearout: 97 },
  { devpath: "/dev/sdc", size: 8 * 1024 ** 3, used: "ext4", health: "UNKNOWN" },
  { devpath: "/dev/sdd", size: 8 * 1024 ** 3, used: "partitions", health: "FAILED" },
  { devpath: "/dev/sdd1", parent: "/dev/sdd", used: "LVM2_member" },
  { devpath: "/dev/sde", size: 8 * 1024 ** 3, used: "ZFS", health: "OK" },
  { devpath: "/dev/sdf", size: 8 * 1024 ** 3, health: "OK" },
  { devpath: "/dev/sdg", size: 8 * 1024 ** 3, health: "OK" },
  { devpath: "/dev/sdh", size: 8 * 1024 ** 3, health: "OK" },
];
const disks = readHardDisks(raw);
const get = (p: string) => disks.find((d) => d.path === p);

test("disks are read with what matters about each", () => {
  assert.equal(disks.length, 8, "partitions aren't disks");
  assert.equal(get("/dev/sda")?.model, "QEMU HARDDISK");
  assert.deepEqual([get("/dev/sdb")?.free, get("/dev/sdb")?.kind, get("/dev/sdb")?.wearLeft], [true, "SSD", 97]);
  assert.equal(get("/dev/sdd")?.failing, true);
  assert.equal(get("/dev/sdc")?.failing, false, "not knowing isn't failing");
});

test("a disk holding a system or live data can't be wiped", () => {
  assert.equal(get("/dev/sda")?.canWipe, false, "something on it is mounted");
  assert.equal(get("/dev/sdd")?.canWipe, false, "part of LVM");
  assert.equal(get("/dev/sde")?.canWipe, false, "part of ZFS");
  assert.equal(get("/dev/sdc")?.canWipe, true, "old contents, not in use");
  assert.equal(get("/dev/sdb")?.canWipe, false, "nothing to wipe");
  assert.throws(() => assertCanWipe(disks, "/dev/sda"), /in use/);
  assert.throws(() => assertCanWipe(disks, "/dev/sdb"), /already empty/);
  assert.throws(() => assertCanWipe(disks, "/dev/nope"), /isn't on this node/);
  assert.doesNotThrow(() => assertCanWipe(disks, "/dev/sdc"));
});

const form = (kind: string, devices: string[], raid = "", filesystem = "") => diskStorageForm(kind, disks, { name: "fast", devices, raid, filesystem });

test("each kind of local storage gets the right form", () => {
  assert.deepEqual(form("lvmthin", ["/dev/sdb"]), { name: "fast", device: "/dev/sdb", add_storage: "1" });
  assert.deepEqual(form("directory", ["/dev/sdb"], "", "xfs"), { name: "fast", device: "/dev/sdb", filesystem: "xfs", add_storage: "1" });
  assert.deepEqual(form("zfs", ["/dev/sdb", "/dev/sdf"], "mirror"), { name: "fast", raidlevel: "mirror", devices: "/dev/sdb,/dev/sdf", ashift: "12", compression: "on", add_storage: "1" });
});

test("disks in use, and layouts that can't work, are refused", () => {
  assert.throws(() => form("zfs", ["/dev/sda"], "single"), /already in use/);
  assert.throws(() => form("zfs", ["/dev/sdz"], "single"), /isn't on this node/);
  assert.throws(() => form("zfs", ["/dev/sdb", "/dev/sdb"], "mirror"), /each disk once/);
  assert.throws(() => form("zfs", ["/dev/sdb"], "mirror"), /at least 2/);
  assert.throws(() => form("zfs", ["/dev/sdb", "/dev/sdf"], "raidz"), /at least 3/);
  assert.throws(() => form("zfs", ["/dev/sdb", "/dev/sdf", "/dev/sdg"], "raid10"), /even number/);
  assert.throws(() => form("zfs", ["/dev/sdb", "/dev/sdf"], "single"), /one disk/i);
  assert.throws(() => form("zfs", ["/dev/sdb"], "constructor"), /work together/);
  assert.throws(() => form("lvmthin", ["/dev/sdb", "/dev/sdf"]), /one disk/);
  assert.throws(() => form("directory", ["/dev/sdb"], "", "ntfs"), /ext4 or xfs/);
  assert.throws(() => form("rm", ["/dev/sdb"]), /type of storage/);
  assert.throws(() => diskStorageForm("zfs", disks, { name: "1,x", devices: ["/dev/sdb"], raid: "single", filesystem: "" }), /starts with/);
});

test("the storage list says what each one is and where it's reachable", () => {
  const list = buildStorageList(
    [
      { storage: "nas", type: "nfs", server: "10.0.30.244", export: "/srv/nfs/backups", content: "backup,iso,snippets" },
      { storage: "fast", type: "zfspool", pool: "fast", content: "images,rootdir" },
    ],
    [
      { name: "nas", node: "a", freeGb: 10, totalGb: 20, online: true },
      { name: "nas", node: "b", freeGb: 10, totalGb: 20, online: false },
      { name: "nas", node: "c", freeGb: 10, totalGb: 20, online: true },
    ],
  );
  const nas = list.find((s) => s.id === "nas");
  assert.equal(nas?.kind, "Network share (NFS)");
  assert.equal(nas?.where, "10.0.30.244/srv/nfs/backups");
  assert.deepEqual(nas?.uses, ["backup", "iso"]);
  assert.deepEqual(nas?.missing, ["b"]);
  assert.equal(nas?.freeGb, 10, "a share's space counts once, however many nodes see it");
  assert.deepEqual(list.find((s) => s.id === "fast")?.usesAllowed, ["images", "rootdir"]);
});

test("storage in use says who's using it", () => {
  const guests = [
    { name: "web", usesStorage: ["nas"] },
    { name: "db", usesStorage: ["local"] },
  ];
  assert.deepEqual(storageBlockers("nas", guests, [{ storage: "nas" }]), ["web", "a backup schedule"]);
  assert.deepEqual(storageBlockers("other", guests, [{ storage: "nas" }]), []);
});

test("changing what a storage holds keeps the uses BossMox doesn't show", () => {
  // Found in the lab: saving local's uses dropped snippets, which BossMox doesn't list.
  assert.equal(usesForm("dir", ["iso", "backup"], "backup,images,snippets,rootdir,import"), "iso,backup,snippets,import");
  assert.equal(usesForm("dir", ["iso"]), "iso");
});

const hd = (path: string, sizeGb: number, free = true, canWipe = false) => ({
  path,
  sizeGb,
  model: "",
  kind: "",
  used: free ? "" : "partitions",
  health: "OK",
  failing: false,
  wearLeft: null,
  free,
  canWipe,
  blocked: "",
});

test("Add storage picks the type from what it's for and how many drives", () => {
  const disks = [hd("/dev/sdb", 500), hd("/dev/sdc", 500), hd("/dev/sdd", 500)];
  assert.equal(setupPlan(disks, ["/dev/sdb"], "vms", "fast").kind, "lvmthin");
  const mirror = setupPlan(disks, ["/dev/sdb", "/dev/sdc"], "vms", "fast");
  assert.deepEqual([mirror.kind, mirror.raid], ["zfs", "mirror"]);
  assert.equal(
    mirror.summary,
    "BossMox will make fast on /dev/sdb and /dev/sdc. It will be a mirror, where both drives hold the same data so one can fail without losing anything, and hold VM and container disks, about 500 GB. Everything on these drives is erased.",
  );
  assert.equal(setupPlan(disks, ["/dev/sdb", "/dev/sdc", "/dev/sdd"], "vms", "fast").raid, "raidz");
  const files = setupPlan(disks, ["/dev/sdb"], "files", "backups");
  assert.deepEqual([files.kind, files.filesystem, files.uses], ["directory", "ext4", "iso,vztmpl,backup"]);
  assert.throws(() => setupPlan(disks, ["/dev/sdb", "/dev/sdc"], "files", "backups"), /one drive for backups/);
  assert.throws(() => setupPlan(disks, ["/dev/sdb", "/dev/sdc"], "both", "x"), /pick VMs and containers/);
});

test("a drive with old data is wiped first and named in the summary, a busy one is refused", () => {
  const disks = [hd("/dev/sdb", 500, false, true), hd("/dev/sdc", 500, false, false)];
  const plan = setupPlan(disks, ["/dev/sdb"], "both", "store");
  assert.deepEqual(plan.wipe, ["/dev/sdb"]);
  assert.match(plan.summary, /including the old data on \/dev\/sdb/);
  assert.throws(() => setupPlan(disks, ["/dev/sdc"], "vms", "x"), /won't erase/);
  assert.throws(() => setupPlan(disks, ["/dev/sdb"], "vms", "1bad"), /starts with a letter/);
});

test("drives of different sizes are only as big as the smallest, and the summary says so", () => {
  const plan = setupPlan([hd("/dev/sdb", 500), hd("/dev/sdc", 1000)], ["/dev/sdb", "/dev/sdc"], "vms", "fast");
  assert.match(plan.summary, /aren't the same size/);
});

test("a drive given to a VM, a RAID member or an encrypted drive can't be wiped or used (security review M2)", () => {
  const raw = [
    { devpath: "/dev/sdb", size: 500 * 1024 ** 3, used: "partitions", by_id_link: "/dev/disk/by-id/ata-Disk_B" },
    { devpath: "/dev/sdb1", parent: "/dev/sdb", used: "ntfs" },
    { devpath: "/dev/sdc", size: 500 * 1024 ** 3, used: "linux_raid_member" },
    { devpath: "/dev/sdd", size: 500 * 1024 ** 3, used: "crypto_LUKS" },
    { devpath: "/dev/sde", size: 500 * 1024 ** 3, used: "partitions" },
    { devpath: "/dev/sde1", parent: "/dev/sde", used: "ext4" },
  ];
  const disks = readHardDisks(raw as never, [{ device: "/dev/disk/by-id/ata-Disk_B", guest: "windows-vm" }]);
  const d = (p: string) => disks.find((x) => x.path === p)!;
  assert.deepEqual([d("/dev/sdb").canWipe, d("/dev/sdb").used], [false, "given to windows-vm"]);
  assert.equal(d("/dev/sdc").canWipe, false);
  assert.equal(d("/dev/sdd").canWipe, false);
  assert.equal(d("/dev/sde").canWipe, true, "old data nobody uses can still be wiped");
  assert.throws(() => setupPlan(disks, ["/dev/sdb"], "vms", "x"), /won't erase/);
});

test("when a guest's settings didn't load, or the account can't see every guest, no disk can be wiped or used (review S1)", () => {
  // A VM's raw disk with a filesystem on it. Its owner's settings failed to load, so the disk isn't known to be passed
  // through, and on its own it would look like old data that's fine to wipe.
  const raw = [
    { devpath: "/dev/sdb", size: 500 * 1024 ** 3, used: "partitions" },
    { devpath: "/dev/sdb1", parent: "/dev/sdb", used: "ext4" },
    { devpath: "/dev/sdc", size: 500 * 1024 ** 3 },
  ];
  assert.equal(readHardDisks(raw as never).find((x) => x.path === "/dev/sdb")!.canWipe, true, "without the check it would be wiped");
  for (const [guests, sees, why] of [
    [[{ known: true }, { known: false }], true, /couldn't read every guest's settings/],
    [[{ known: true }], false, /can't see every guest/],
  ] as const) {
    const blocked = eraseBlocker(guests, sees);
    assert.match(blocked ?? "", why);
    const disks = readHardDisks(raw as never, [], blocked);
    assert.deepEqual(
      disks.map((x) => [x.free, x.canWipe]),
      [
        [false, false],
        [false, false],
      ],
      "nothing is free or wipeable",
    );
    assert.throws(() => assertCanWipe(disks, "/dev/sdb"), why, "Wipe refuses");
    assert.throws(() => setupPlan(disks, ["/dev/sdb"], "vms", "x"), why, "Set up storage refuses");
    assert.throws(() => diskStorageForm("lvmthin", disks, { name: "x", devices: ["/dev/sdc"], raid: "", filesystem: "" }), why, "making a pool on a blank disk refuses");
  }
  assert.equal(eraseBlocker([{ known: true }], true), null);
});
