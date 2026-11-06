import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { buildOverview, vmIssues, type RawResource } from "../src/model.js";

const G = 1024 ** 3;

test("flags IDE boot disks but ignores CD drives", () => {
  assert.equal(vmIssues(1, "a", { ide0: "local:vm-1-disk-0,size=32G" })[0]?.kind, "disk-controller");
  assert.equal(vmIssues(1, "a", { ide2: "none,media=cdrom" }).length, 0);
});

test("flags pvscsi only when a SCSI disk exists", () => {
  assert.equal(vmIssues(1, "a", { scsihw: "pvscsi", scsi0: "x,size=1G" }).length, 1);
  assert.equal(vmIssues(1, "a", { scsihw: "pvscsi" }).length, 0);
  assert.equal(vmIssues(1, "a", { scsihw: "virtio-scsi-single", scsi0: "x,size=1G" }).length, 0);
});

test("flags older network cards", () => {
  assert.equal(vmIssues(1, "a", { net0: "e1000=AA:BB,bridge=vmbr0" })[0]?.kind, "network-card");
  assert.equal(vmIssues(1, "a", { net0: "virtio=AA:BB,bridge=vmbr0" }).length, 0);
});

test("builds the overview from real-shaped data", () => {
  const res: RawResource[] = [
    { type: "node", node: "n1", status: "online", cpu: 0.25, maxcpu: 6, mem: 4 * G, maxmem: 16 * G },
    { type: "node", node: "n2", status: "offline" },
    { type: "qemu", vmid: 100, node: "n1", name: "HA", status: "running", cpu: 0.1, maxcpu: 4, mem: G, maxmem: 4 * G, maxdisk: 32 * G },
    { type: "qemu", vmid: 900, node: "n1", name: "tmpl", status: "stopped", template: 1 },
    { type: "storage", storage: "fast", node: "n1", status: "available", disk: 90 * G, maxdisk: 100 * G },
    { type: "storage", storage: "nas", node: "n1", shared: 1, status: "available", disk: G, maxdisk: 10 * G },
    { type: "storage", storage: "nas", node: "n2", shared: 1, status: "available", disk: G, maxdisk: 10 * G },
  ];
  const guests = new Map([
    [100, { config: { ostype: "l26", onboot: 1 }, snapshots: [{ name: "current" }, { name: "pre", snaptime: 5 }] }],
  ]);
  const o = buildOverview(res, guests, [{ vmid: 100 }]);
  assert.equal(o.vms.length, 1, "templates are left out");
  assert.equal(o.vms[0]?.os, "Linux");
  assert.deepEqual(o.vms[0]?.snapshots.map((s) => s.name), ["pre"], "the current marker is not a snapshot");
  assert.equal(o.storage.length, 2, "shared storage is counted once");
  assert.deepEqual(o.issues.map((i) => i.kind), ["server-offline", "no-backup", "storage-full"]);
});

test("refuses to send passwords to Proxmox over plain http", () => {
  assert.throws(() => loadConfig({ PVE_URL: "http://192.0.2.1:8006" }), /https/);
  assert.equal(loadConfig({ PVE_URL: "http://127.0.0.1:9" }).pveUrl.port, "9");
});

test("accepts several Proxmox addresses and checks each one", () => {
  const c = loadConfig({ PVE_URL: "https://192.0.2.1:8006, https://192.0.2.2:8006" });
  assert.deepEqual(c.pveUrls.map((u) => u.hostname), ["192.0.2.1", "192.0.2.2"]);
  assert.throws(() => loadConfig({ PVE_URL: "https://192.0.2.1:8006,http://192.0.2.2:8006" }), /https/);
});

test("refuses to serve a network without HTTPS", () => {
  const base = { PVE_URL: "https://192.0.2.1:8006", HOST: "0.0.0.0" };
  assert.throws(() => loadConfig(base), /plain HTTP/);
  assert.equal(loadConfig({ ...base, BOSSMOX_BEHIND_HTTPS_PROXY: "1" }).behindProxy, true);
  assert.equal(loadConfig({ ...base, BOSSMOX_ALLOW_HTTP: "1" }).allowHttp, true);
  assert.equal(loadConfig({ PVE_URL: "https://192.0.2.1:8006" }).host, "127.0.0.1");
});

test("cluster usage weighs nodes by size and skips offline ones", () => {
  const view = buildOverview([
    { type: "node", node: "big", status: "online", cpu: 0.1, maxcpu: 30, mem: 8 * 1024 ** 3, maxmem: 32 * 1024 ** 3 },
    { type: "node", node: "small", status: "online", cpu: 1, maxcpu: 2, mem: 4 * 1024 ** 3, maxmem: 8 * 1024 ** 3 },
    { type: "node", node: "gone", status: "offline", cpu: 0, maxcpu: 64, mem: 0, maxmem: 512 * 1024 ** 3 },
  ], new Map(), []);
  assert.equal(view.cluster.cores, 32);
  assert.equal(view.cluster.cpuPct, 16);
  assert.equal(view.cluster.memUsedGb, 12);
  assert.equal(view.cluster.memTotalGb, 40);
  assert.equal(view.cluster.memPct, 30);
});

test("shared storage counts once in cluster usage", () => {
  const nas = { type: "storage", storage: "nas", shared: 1, status: "available", disk: 10 * 1024 ** 3, maxdisk: 100 * 1024 ** 3 };
  const view = buildOverview([{ ...nas, node: "a" }, { ...nas, node: "b" }], new Map(), []);
  assert.equal(view.cluster.diskTotalGb, 100);
});

test("only a real disc drive can have its disc changed", () => {
  const vm = (ide2?: string) => buildOverview([{ type: "qemu", vmid: 300, name: "vm", node: "a", status: "stopped" }], new Map([[300, { config: ide2 ? { ide2 } : {} }]]), []).vms[0];
  assert.equal(vm()?.discLocked, false);
  assert.equal(vm("none,media=cdrom")?.discLocked, false);
  assert.equal(vm("local:iso/a.iso,media=cdrom")?.discLocked, false);
  assert.equal(vm("local:100/vm-100-disk-1.raw,size=32G")?.discLocked, true, "a data disk");
  assert.equal(vm("local:410/vm-410-cloudinit.qcow2,media=cdrom")?.discLocked, true, "cloud-init");
});
