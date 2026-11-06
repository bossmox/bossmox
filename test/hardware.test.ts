import assert from "node:assert/strict";
import { test } from "node:test";
import { addDiskForm, addNicForm, bootDisk, growForm, pickAddresses, readDisks, readNics, removeDiskForm, removeNicForm } from "../src/hardware.js";

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
  assert.deepEqual(readNics("lxc", ct)[0], { slot: "net0", model: "eth0", mac: "BC:24:11:00:00:02", bridge: "vmbr0", vlan: "" });
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
