import assert from "node:assert/strict";
import { test } from "node:test";
import { containerForm, CreateError, installerLabel, vmForm, type CreateInput } from "../src/create.js";

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
  assert.throws(() => containerForm(input({ password: "short" })), /at least 8/);
  assert.throws(() => containerForm(input({ installer: "", password: "longenough" })), /template/);
});

test("installers show their file name", () => {
  assert.equal(installerLabel("local:iso/alpine.iso"), "alpine.iso");
});
