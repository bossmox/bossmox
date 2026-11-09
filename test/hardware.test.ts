import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotFix, addDiskForm, addNicForm, bootDisk, growForm, pickAddresses, readDisks, readNics, removeDiskForm, removeNicForm } from "../src/hardware.js";

const vm = { boot: "order=scsi0;ide2", scsi0: "local:300/vm-300-disk-0.qcow2,iothread=1,size=32G", scsi1: "local-lvm:vm-300-disk-1,size=512M", ide2: "local:iso/a.iso,media=cdrom,size=67M", net0: "virtio=BC:24:11:00:00:01,bridge=vmbr0,tag=30" };
const ct = { rootfs: "local:200/vm-200-disk-0.raw,size=8G", mp0: "local:200/vm-200-disk-1.raw,mp=/data,size=2G", net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth" };

test("a VM's disks are read, disc drives left out, and the boot disk first", () => {
  const disks = readDisks("qemu", vm);
  assert.deepEqual(disks.map((d) => d.slot), ["scsi0", "scsi1"]);
  assert.equal(disks[0]?.boot, true);
  assert.equal(disks[0]?.sizeGb, 32);
  assert.equal(disks[1]?.sizeGb, 0.5);
  assert.equal(disks[0]?.storage, "local");
});

test("a container's disks show where they appear", () => {
  const disks = readDisks("lxc", ct);
  assert.deepEqual(disks.map((d) => [d.slot, d.mount, d.boot]), [["rootfs", "", true], ["mp0", "/data", false]]);
});

test("network cards are read for both kinds", () => {
  assert.deepEqual(readNics("qemu", vm)[0], { slot: "net0", model: "virtio", mac: "BC:24:11:00:00:01", bridge: "vmbr0", vlan: "30" });
  assert.deepEqual(readNics("lxc", ct)[0], { slot: "net0", model: "eth0", mac: "BC:24:11:00:00:02", bridge: "vmbr0", vlan: "", ip: "dhcp", gw: "" });
});

test("the boot disk can't be removed, whatever it's called", () => {
  assert.throws(() => removeDiskForm("qemu", vm, "scsi0"), /starts from/);
  assert.throws(() => removeDiskForm("lxc", ct, "rootfs"), /starts from/);
  const sata = { boot: "order=sata0", sata0: "local:1,size=1G", scsi0: "local:2,size=1G" };
  assert.equal(bootDisk("qemu", sata), "sata0");
  assert.throws(() => removeDiskForm("qemu", sata, "sata0"), /starts from/);
  assert.deepEqual(removeDiskForm("qemu", sata, "scsi0"), { delete: "scsi0" });
});

test("a disc drive isn't a disk, and made-up slots are refused", () => {
  assert.throws(() => removeDiskForm("qemu", vm, "ide2"), /disc drive/);
  assert.throws(() => removeDiskForm("qemu", vm, "scsi9"), /doesn't exist/);
  assert.throws(() => removeDiskForm("qemu", vm, "name"), /doesn't exist/);
  assert.throws(() => removeDiskForm("qemu", vm, "constructor"), /doesn't exist/);
  assert.deepEqual(removeDiskForm("lxc", ct, "mp0"), { delete: "mp0" });
});

test("growing only adds, and only sensible amounts", () => {
  assert.deepEqual(growForm("qemu", vm, "scsi0", 8), { disk: "scsi0", size: "+8G" });
  assert.throws(() => growForm("qemu", vm, "scsi0", 0), /between/);
  assert.throws(() => growForm("qemu", vm, "scsi0", -5), /between/);
  assert.throws(() => growForm("qemu", vm, "scsi0", 1.5), /between/);
  assert.throws(() => growForm("qemu", vm, "ide3", 1), /doesn't exist/);
});

test("new disks take the next free slot of the right kind", () => {
  assert.deepEqual(addDiskForm("qemu", vm, { storage: "local", sizeGb: 4, mount: "" }), { scsi2: "local:4" });
  assert.deepEqual(addDiskForm("qemu", { sata0: "local:1,size=1G" }, { storage: "local", sizeGb: 4, mount: "" }), { sata1: "local:4" }, "Windows stays on what it can see");
  assert.deepEqual(addDiskForm("lxc", ct, { storage: "local", sizeGb: 4, mount: "/backup" }), { mp1: "local:4,mp=/backup" });
  assert.throws(() => addDiskForm("lxc", ct, { storage: "local", sizeGb: 4, mount: "/" }), /appear/);
  assert.throws(() => addDiskForm("lxc", ct, { storage: "local", sizeGb: 4, mount: "/x,backup=1" }), /appear/);
  assert.throws(() => addDiskForm("qemu", vm, { storage: "local:1,cache=none", sizeGb: 4, mount: "" }), /storage/);
});

test("new network cards match the guest, and can't smuggle options", () => {
  assert.deepEqual(addNicForm("qemu", vm, { bridge: "vmbr0", vlan: "" }), { net1: "virtio,bridge=vmbr0" });
  assert.deepEqual(addNicForm("qemu", { net0: "e1000e=AA,bridge=vmbr0" }, { bridge: "vmbr0", vlan: "30" }), { net1: "e1000e,bridge=vmbr0,tag=30" }, "Windows keeps the card it can see");
  assert.deepEqual(addNicForm("lxc", ct, { bridge: "vmbr0", vlan: "" }), { net1: "name=eth1,bridge=vmbr0,ip=dhcp" });
  assert.throws(() => addNicForm("qemu", vm, { bridge: "vmbr0,firewall=0", vlan: "" }), /network/);
  assert.throws(() => addNicForm("qemu", vm, { bridge: "vmbr0", vlan: "9999" }), /VLAN/);
  assert.deepEqual(removeNicForm(vm, "net0"), { delete: "net0" });
  assert.throws(() => removeNicForm(vm, "net4"), /doesn't exist/);
});

test("addresses leave out what nobody can connect to", () => {
  assert.deepEqual(pickAddresses("lxc", [{ name: "lo", inet: "127.0.0.1/8" }, { name: "eth0", inet: "10.0.30.61/24", inet6: "fe80::1/64" }]), ["10.0.30.61"]);
  const agent = { result: [{ name: "lo", "ip-addresses": [{ "ip-address": "127.0.0.1" }] }, { name: "ens18", "ip-addresses": [{ "ip-address": "10.0.30.5" }, { "ip-address": "fe80::2" }, { "ip-address": "2001:db8::5" }] }] };
  assert.deepEqual(pickAddresses("qemu", agent), ["10.0.30.5", "2001:db8::5"]);
  assert.deepEqual(pickAddresses("qemu", {}), []);
});

test("an added VM disk on a folder or share asks for qcow2, a container's doesn't", () => {
  assert.equal(addDiskForm("qemu", { scsi0: "x" }, { storage: "files", sizeGb: 2, mount: "", fileStorage: true }).scsi1, "files:2,format=qcow2");
  assert.equal(addDiskForm("qemu", { scsi0: "x" }, { storage: "fast", sizeGb: 2, mount: "" }).scsi1, "fast:2");
});

test("raw disks on a folder are the ones to convert for snapshots, and only when that's enough", () => {
  // Measured on bmx-node2: these three as raw files block snapshots, and as qcow2 they don't.
  const types = { files: "dir", fast: "lvmthin", lvm: "lvm" };
  const vm = { scsi0: "files:962/vm-962-disk-1.raw,size=1G", efidisk0: "files:962/vm-962-disk-0.raw,efitype=4m", tpmstate0: "files:962/vm-962-disk-2.raw,size=4M", ide2: "local:iso/x.iso,media=cdrom" };
  assert.deepEqual(snapshotFix(vm, types), ["scsi0", "efidisk0", "tpmstate0"]);
  assert.deepEqual(snapshotFix({ scsi0: "files:962/vm-962-disk-1.raw", scsi1: "fast:vm-962-disk-5" }, types), ["scsi0"]);
  assert.deepEqual(snapshotFix({ scsi0: "files:962/vm-962-disk-1.raw", scsi1: "lvm:vm-962-disk-5" }, types), [], "a thick LVM disk still blocks it, so converting wouldn't help");
  assert.deepEqual(snapshotFix({ scsi0: "files:962/vm-962-disk-1.qcow2" }, types), []);
});

test("a storage named only with dots is refused (pre-public review 2026-11-09)", () => {
  for (const storage of [".", ".."]) assert.throws(() => addDiskForm("qemu", { scsi0: "x" }, { storage, sizeGb: 2, mount: "" }), /Pick a storage/);
  assert.equal(addDiskForm("qemu", { scsi0: "x" }, { storage: "my.pool", sizeGb: 2, mount: "" }).scsi1, "my.pool:2");
});

test("a container's address: fixed or automatic, keeping everything else on the card", async () => {
  const { addressForm } = await import("../src/hardware.js");
  const card = "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,ip6=auto,tag=30,firewall=1";
  const c = { net0: card };
  assert.deepEqual(readNics("lxc", c)[0]!.ip, "dhcp");
  assert.equal(readNics("qemu", { net0: "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0" })[0]!.ip, undefined, "a VM's address isn't in its settings");
  const fixed = addressForm(c, "net0", { mode: "fixed", address: "10.0.30.70/24", gateway: "10.0.30.250" }).net0!;
  assert.equal(fixed, "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip6=auto,tag=30,firewall=1,ip=10.0.30.70/24,gw=10.0.30.250");
  const back = addressForm({ net0: fixed }, "net0", { mode: "dhcp", address: "", gateway: "" }).net0!;
  assert.equal(back, "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip6=auto,tag=30,firewall=1,ip=dhcp", "the old gateway goes with the fixed address");
  assert.match(addressForm(c, "net0", { mode: "fixed", address: "10.0.30.70/24", gateway: "" }).net0!, /ip=10\.0\.30\.70\/24$/, "a network with no router is allowed");
});

test("a container's address: typos are refused with the reason", async () => {
  const { addressForm, sameNetwork } = await import("../src/hardware.js");
  const c = { net0: "name=eth0,bridge=vmbr0,ip=dhcp" };
  const bad = (v: { mode: string; address: string; gateway: string }, why: RegExp, slot = "net0") => assert.throws(() => addressForm(c, slot, v), why);
  bad({ mode: "fixed", address: "10.0.30.70", gateway: "" }, /network size/);
  bad({ mode: "fixed", address: "10.0.30.700/24", gateway: "" }, /network size/);
  bad({ mode: "fixed", address: "10.0.30.70/33", gateway: "" }, /network size/);
  bad({ mode: "fixed", address: "10.0.30.70/24", gateway: "192.168.1.1" }, /isn't on the same network/);
  bad({ mode: "fixed", address: "10.0.30.70/24", gateway: "10.0.30.70" }, /own address/);
  bad({ mode: "fixed", address: "10.0.30.70/24", gateway: "10.0.30" }, /four numbers/);
  bad({ mode: "maybe", address: "", gateway: "" }, /automatic or fixed/);
  bad({ mode: "dhcp", address: "", gateway: "" }, /doesn't exist/, "net1");
  assert.equal(sameNetwork("10.0.31.5", 23, "10.0.30.1"), true, "a /23 spans two of the third numbers");
  assert.equal(sameNetwork("10.0.31.5", 24, "10.0.30.1"), false);
});
