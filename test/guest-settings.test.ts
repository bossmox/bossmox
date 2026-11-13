import assert from "node:assert/strict";
import { test } from "node:test";
import { changesForm, readSettings, waitingChanges } from "../src/guest-settings.js";

const vm = {
  name: "web",
  cores: 2,
  memory: "2048",
  cpu: "x86-64-v2-AES,flags=+aes",
  vga: "qxl,memory=32",
  agent: "1,fstrim_cloned_disks=1",
  scsihw: "virtio-scsi-single",
  scsi0: "local:300/vm-300-disk-0.raw,size=32G",
  startup: "order=3,up=30",
  machine: "pc-q35-8.1,viommu=virtio",
  tags: "a;b",
};
const ct = { hostname: "app", cores: 1, memory: 512, swap: 256, features: "nesting=1,mount=nfs", unprivileged: 1, ostype: "debian" };

test("a VM's settings are read into plain values", () => {
  const s = readSettings("qemu", vm);
  assert.equal(s.name, "web");
  assert.equal("cpu" in s && s.cpu, "x86-64-v2-AES");
  assert.equal("display" in s && s.display, "qxl");
  assert.equal("agent" in s && s.agent, true);
  assert.equal(s.startOrder, 3);
  assert.equal(s.tags, "a b");
  assert.equal("machine" in s && s.machine, "pc-q35-8.1");
  assert.equal("tablet" in s && s.tablet, true, "on unless turned off");
  assert.equal("balloonMb" in s && s.balloonMb, null);
});

test("every way of writing memory reads the same", () => {
  assert.equal(readSettings("qemu", { memory: "current=4096" }).memoryMb, 4096);
  assert.equal(readSettings("qemu", { memory: 4096 }).memoryMb, 4096);
  assert.equal(readSettings("qemu", {}).memoryMb, 512, "Proxmox's default");
});

test("a container's settings are read into plain values", () => {
  const s = readSettings("lxc", ct);
  assert.equal(s.name, "app");
  assert.equal("nesting" in s && s.nesting, true);
  assert.equal("keyctl" in s && s.keyctl, false);
  assert.equal("swapMb" in s && s.swapMb, 256);
});

test("cores, memory and type become Proxmox's words", () => {
  assert.deepEqual(changesForm("qemu", vm, { cores: 4, memoryMb: 4096 }, false), { cores: "4", memory: "4096" });
  assert.deepEqual(changesForm("lxc", ct, { name: "app2", swapMb: 0 }, false), { hostname: "app2", swap: "0" });
});

test("options nobody can see here aren't lost", () => {
  assert.equal(changesForm("qemu", vm, { cpu: "host" }, false).cpu, "host,flags=+aes");
  assert.equal(changesForm("qemu", { cpu: "cputype=kvm64,hidden=1" }, { cpu: "host" }, false).cpu, "host,hidden=1");
  assert.equal(changesForm("qemu", vm, { display: "virtio" }, false).vga, "virtio,memory=32");
  assert.equal(changesForm("qemu", vm, { agent: false }, false).agent, "0,fstrim_cloned_disks=1");
  assert.equal(changesForm("qemu", vm, { startOrder: 7 }, false).startup, "order=7,up=30");
  assert.equal(changesForm("qemu", vm, { machine: "q35" }, false).machine, "q35,viommu=virtio");
  assert.equal(changesForm("lxc", ct, { keyctl: true }, false).features, "nesting=1,mount=nfs,keyctl=1");
  assert.equal(changesForm("lxc", ct, { nesting: false }, false).features, "mount=nfs");
});

test("clearing a setting removes it instead of saving a blank", () => {
  assert.deepEqual(changesForm("qemu", vm, { notes: "", tags: "" }, false), { delete: "description,tags" });
  assert.deepEqual(changesForm("qemu", { cpu: "host" }, { cpu: "" }, false), { delete: "cpu" });
  assert.deepEqual(changesForm("qemu", { balloon: 1024 }, { balloonMb: null }, false), { delete: "balloon" });
  assert.deepEqual(changesForm("qemu", { cpulimit: 2 }, { cpuLimit: 0 }, false), { delete: "cpulimit" });
  assert.deepEqual(changesForm("qemu", { startup: "order=1" }, { startOrder: null }, false), { delete: "startup" });
  assert.deepEqual(changesForm("lxc", { features: "nesting=1" }, { nesting: false }, false), { delete: "features" });
});

test("nothing can be slipped in, and unknown settings are refused", () => {
  assert.throws(() => changesForm("qemu", vm, { hookscript: "local:snippets/x" }, false), /can't be changed/);
  assert.throws(() => changesForm("qemu", vm, { constructor: 1 }, false), /can't be changed/);
  assert.throws(() => changesForm("lxc", ct, { cpu: "host" }, false), /can't be changed/);
  assert.throws(() => changesForm("qemu", vm, { swapMb: 1 }, false), /can't be changed/);
  assert.throws(() => changesForm("qemu", vm, { cpu: "host,flags=+x" }, false), /processor type/);
  assert.throws(() => changesForm("qemu", vm, { machine: "q35,x=1" }, false), /machine type/);
  assert.throws(() => changesForm("qemu", vm, { tags: "a,b=c" }, false), /Tags/);
  assert.throws(() => changesForm("lxc", ct, { dns: "1.1.1.1;rm" }, false), /DNS/);
  assert.throws(() => changesForm("qemu", vm, { name: "a b" }, false), /name uses/);
});

test("numbers have to make sense", () => {
  assert.throws(() => changesForm("qemu", vm, { cores: 0 }, false), /between 1 and 128/);
  assert.throws(() => changesForm("qemu", vm, { cores: null }, false), /between 1 and 128/);
  assert.throws(() => changesForm("qemu", vm, { cores: 1.5 }, false), /between 1 and 128/);
  assert.throws(() => changesForm("qemu", vm, { sockets: 9 }, false), /sockets/);
  assert.throws(() => changesForm("qemu", vm, { memoryMb: 1 }, false), /16 MB/);
  assert.throws(() => changesForm("qemu", vm, { balloonMb: 3000 }, false), /shrink/);
  assert.deepEqual(changesForm("qemu", vm, { balloonMb: 3000, memoryMb: 4096 }, false), { balloon: "3000", memory: "4096" }, "checked against the new memory");
});

test("UEFI brings its own small disk, and only while shut down", () => {
  assert.equal(changesForm("qemu", vm, { bios: "ovmf" }, false).efidisk0, "local:1,efitype=4m,pre-enrolled-keys=0");
  assert.equal(changesForm("qemu", { ...vm, efidisk0: "local:1" }, { bios: "ovmf" }, false).efidisk0, undefined);
  assert.equal(changesForm("qemu", vm, { bios: "seabios" }, false).efidisk0, undefined);
  assert.throws(() => changesForm("qemu", vm, { bios: "ovmf" }, true), /Shut it down/);
  assert.throws(() => changesForm("qemu", {}, { bios: "ovmf" }, false), /Give it a disk/);
});

test("no change is refused rather than sent", () => {
  assert.throws(() => changesForm("qemu", vm, {}, false), /Nothing changed/);
});

test("only real differences count as waiting for a restart", () => {
  assert.deepEqual(
    waitingChanges([
      { key: "memory", value: "2048", pending: "4096" },
      { key: "cores", value: 2 },
      { key: "tablet", value: 1, delete: 1 },
    ]),
    [
      { key: "memory", next: "4096" },
      { key: "tablet", next: "" },
    ],
  );
});
