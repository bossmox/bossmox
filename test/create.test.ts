import assert from "node:assert/strict";
import { test } from "node:test";
import { containerForm, CreateError, discDownload, installerLabel, settingsForm, vmForm, type CreateInput } from "../src/create.js";

const input = (more: Partial<CreateInput> = {}): CreateInput => ({
  id: "500", name: "web", cores: 2, memoryMb: 2048, diskGb: 32, storage: "local", bridge: "vmbr0", installer: "local:iso/a.iso", os: "linux", start: false, password: "", ...more,
});

test("a Linux VM boots from its disk, then the installer", () => {
  const f = vmForm(input());
  assert.equal(f.scsi0, "local:32");
  assert.equal(f.ide2, "local:iso/a.iso,media=cdrom");
  assert.equal(f.boot, "order=scsi0;ide2");
  assert.equal(f.net0, "virtio,bridge=vmbr0");
  assert.equal(f.ostype, "l26");
  assert.equal(f.start, undefined);
});

test("a VM can be made with no installer", () => {
  const f = vmForm(input({ installer: "" }));
  assert.equal(f.ide2, undefined);
  assert.equal(f.boot, "order=scsi0");
});

test("Windows gets hardware its installer can see, and what Windows 11 requires", () => {
  const f = vmForm(input({ os: "windows" }));
  assert.equal(f.sata0, "local:32");
  assert.equal(f.scsi0, undefined);
  assert.match(f.net0 ?? "", /^e1000e/);
  assert.equal(f.bios, "ovmf");
  assert.match(f.tpmstate0 ?? "", /version=v2.0/);
  assert.match(f.efidisk0 ?? "", /pre-enrolled-keys=1/);
});

test("a container runs unprivileged, with nesting, on DHCP", () => {
  const f = containerForm(input({ installer: "local:vztmpl/debian.tar.zst", password: "longenough" }));
  assert.equal(f.unprivileged, "1");
  assert.equal(f.features, "nesting=1");
  assert.equal(f.rootfs, "local:32");
  assert.match(f.net0 ?? "", /ip=dhcp/);
  assert.equal(f.hostname, "web");
});

test("bad settings are refused in plain words, and can't smuggle in extra options", () => {
  assert.throws(() => vmForm(input({ name: "has space" })), CreateError);
  assert.throws(() => vmForm(input({ name: "-dash" })), CreateError);
  assert.throws(() => vmForm(input({ cores: 0 })), CreateError);
  assert.throws(() => vmForm(input({ memoryMb: 1 })), CreateError);
  assert.throws(() => vmForm(input({ storage: "local:32,format=raw" })), CreateError);
  assert.throws(() => vmForm(input({ bridge: "vmbr0,firewall=0" })), CreateError);
  assert.throws(() => vmForm(input({ installer: "local:iso/a.iso,media=disk" })), CreateError);
  assert.throws(() => vmForm(input({ os: "beos" })), CreateError);
  assert.throws(() => vmForm(input({ os: "constructor" })), CreateError, "a built-in property isn't an operating system");
  assert.throws(() => containerForm(input({ password: "short" })), /at least 8/);
  assert.throws(() => containerForm(input({ installer: "", password: "longenough" })), /template/);
});

const edit = (more = {}) => ({ name: "web", cores: 2, memoryMb: 2048, startsAtBoot: true, disc: null, ...more });

test("settings use each kind's own word for the name", () => {
  assert.equal(settingsForm("qemu", edit()).name, "web");
  assert.equal(settingsForm("lxc", edit()).hostname, "web");
  assert.equal(settingsForm("lxc", edit()).onboot, "1");
  assert.equal(settingsForm("lxc", edit({ startsAtBoot: false })).onboot, "0");
});

test("adding a disc also adds it to the boot list, once", () => {
  const f = settingsForm("qemu", edit({ disc: "local:iso/a.iso" }), { boot: "order=scsi0" });
  assert.equal(f.ide2, "local:iso/a.iso,media=cdrom");
  assert.equal(f.boot, "order=scsi0;ide2");
  assert.equal(settingsForm("qemu", edit({ disc: "local:iso/a.iso" }), { boot: "order=scsi0;ide2" }).boot, undefined);
});

test("a disc can be taken out, and left alone", () => {
  assert.equal(settingsForm("qemu", edit({ disc: "" })).ide2, "none,media=cdrom");
  assert.equal(settingsForm("qemu", edit()).ide2, undefined);
  assert.equal(settingsForm("lxc", edit({ disc: "local:iso/a.iso" })).ide2, undefined, "containers have no disc drive");
});

test("a cloud-init drive is never replaced with a disc", () => {
  assert.throws(() => settingsForm("qemu", edit({ disc: "local:iso/a.iso" }), { ide2: "local:410/vm-410-cloudinit.qcow2,media=cdrom" }), /setup disk/);
});

test("a data disk on the disc drive's slot is never rewritten", () => {
  assert.throws(() => settingsForm("qemu", edit({ disc: "" }), { ide2: "local:100/vm-100-disk-1.raw,size=32G" }), /has a disk/);
  assert.throws(() => settingsForm("qemu", edit({ disc: "local:iso/a.iso" }), { ide2: "local:100/vm-100-disk-1.raw,size=32G" }), /has a disk/);
  assert.equal(settingsForm("qemu", edit(), { ide2: "local:100/vm-100-disk-1.raw,size=32G" }).ide2, undefined, "other settings still save");
  assert.equal(settingsForm("qemu", edit({ disc: "" }), { ide2: "none,media=cdrom" }).ide2, "none,media=cdrom");
});

test("disc downloads must be a plain .iso from the web", () => {
  assert.deepEqual(discDownload("https://example.com/a/alpine-3.iso"), { url: "https://example.com/a/alpine-3.iso", filename: "alpine-3.iso" });
  assert.throws(() => discDownload("file:///etc/passwd.iso"), /https/);
  assert.throws(() => discDownload("http://example.com/a.iso"), /https/, "plain http could be swapped on the way");
  assert.throws(() => discDownload("https://example.com/setup.exe"), /\.iso/);
  assert.throws(() => discDownload("https://example.com/..%2F..%2Fetc%2Fx.iso"), /\.iso/);
  assert.throws(() => discDownload("nonsense"), CreateError);
});

test("installers show their file name", () => {
  assert.equal(installerLabel("local:iso/alpine.iso"), "alpine.iso");
});
