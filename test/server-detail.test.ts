import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServerDetail, friendlyUptime, groupUpdates, taskResult, updateChannel, type RawRepositories } from "../src/server-detail.js";

const repo = (uri: string, component: string, enabled = true): RawRepositories => ({
  files: [{ repositories: [{ Enabled: enabled, URIs: [uri], Components: [component] }] }],
});
const PVE = "http://download.proxmox.com/debian/pve";
const ENT = "https://enterprise.proxmox.com/debian/pve";

test("a kernel update means a reboot, others don't", () => {
  const withKernel = groupUpdates([
    { Package: "proxmox-kernel-7.0", Origin: "Proxmox" },
    { Package: "pve-manager", Origin: "Proxmox" },
    { Package: "curl", Origin: "Debian" },
  ]);
  assert.equal(withKernel.rebootNeeded, true);
  assert.deepEqual([withKernel.kernel.length, withKernel.proxmox.length, withKernel.other.length], [1, 1, 1]);
  assert.equal(groupUpdates([{ Package: "curl", Origin: "Debian" }]).rebootNeeded, false);
});

test("the update channel is named in plain words", () => {
  assert.equal(updateChannel(repo(PVE, "pve-no-subscription")).name, "Free (no subscription)");
  assert.equal(updateChannel(repo(PVE, "pve-no-subscription", false)).ok, false, "a disabled channel doesn't count");
});

test("the enterprise channel without a subscription is flagged", () => {
  assert.equal(updateChannel(repo(ENT, "pve-enterprise"), { status: "notfound" }).ok, false);
  assert.equal(updateChannel(repo(ENT, "pve-enterprise"), { status: "Active" }).ok, true);
});

test("uptime reads naturally", () => {
  assert.equal(friendlyUptime(90061), "1 day, 1 hour");
  assert.equal(friendlyUptime(3720), "1 hour, 2 minutes");
});

test("task results", () => {
  assert.equal(taskResult({ upid: "x" }), "running");
  assert.equal(taskResult({ upid: "x", status: "OK", endtime: 2 }), "ok");
  assert.equal(taskResult({ upid: "x", status: "WARNINGS: 1", endtime: 2 }), "warning");
  assert.equal(taskResult({ upid: "x", status: "unable to do thing", endtime: 2 }), "failed");
});

test("a limited account gets empty sections instead of a failure", () => {
  const no = { available: false } as const;
  const d = buildServerDetail("n1", { available: true, value: { pveversion: "pve-manager/9.2.2/abc", uptime: 60 } }, no, no, no, no, no);
  assert.equal(d.summary?.proxmoxVersion, "9.2.2");
  assert.equal(d.updates, null);
  assert.equal(d.channel, null);
});
