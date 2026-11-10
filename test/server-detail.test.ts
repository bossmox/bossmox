import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMovePlan, buildRebootPlan, buildRollingPlan, buildTaskFeed, buildTaskLog, buildServerDetail, friendlyUptime, groupUpdates, taskResult, taskView, updateChannel, type RawRepositories, type RawService, type Section } from "../src/server-detail.js";

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

test("having both channels on counts as free, but flags the failing checks without a subscription", () => {
  const both: RawRepositories = { files: [{ repositories: [
    { Enabled: true, URIs: [ENT], Components: ["pve-enterprise"] },
    { Enabled: true, URIs: [PVE], Components: ["pve-no-subscription"] },
  ] }] };
  // Measured in the lab: updates still download, but apt-get update exits 100 and the task fails.
  const c = updateChannel(both, { status: "notfound" });
  assert.equal(c.name, "Free (no subscription)");
  assert.equal(c.ok, false);
  assert.equal(c.headline, "Every check for updates ends in an error");
  assert.equal(updateChannel(both, { status: "Active" }).name, "Enterprise");
});

test("corosync being off is only normal on a standalone server", () => {
  const no = { available: false } as const;
  const svc: Section<RawService[]> = { available: true, value: [{ service: "corosync", state: "dead", "unit-state": "enabled" }] };
  const standalone = buildServerDetail("n", no, no, no, no, svc, no, { available: true, value: [{ type: "node" }] });
  const clustered = buildServerDetail("n", no, no, no, no, svc, no, { available: true, value: [{ type: "cluster" }, { type: "node" }] });
  assert.equal(standalone.services?.[0]?.enabled, false);
  assert.equal(clustered.services?.[0]?.enabled, true);
});

test("uptime reads naturally", () => {
  assert.equal(friendlyUptime(90061), "1 day, 1 hour");
  assert.equal(friendlyUptime(3720), "1 hour, 2 minutes");
  assert.equal(friendlyUptime(60), "1 minute");
});

test("following a task reports running, success and failure", () => {
  assert.equal(taskView({ status: "running" }, []).finished, false);
  const long = Array.from({ length: 500 }, (_, i) => ({ t: `line ${i}` }));
  assert.equal(taskView({ status: "running" }, long).lines.length, 200, "following a task keeps just the end");
  assert.equal(taskView({ status: "running" }, long, 20000).lines.length, 500, "reading one keeps it all");
  assert.equal(taskView({ status: "stopped", exitstatus: "OK" }, [{ t: "done" }]).result, "ok");
  const failed = taskView({ status: "stopped", exitstatus: "command failed" }, [{ t: "no content" }, { t: "E: boom" }]);
  assert.equal(failed.result, "failed");
  assert.equal(failed.message, "command failed");
  assert.deepEqual(failed.lines, ["E: boom"]);
});

test("a reboot plan lists running jobs and usable backup storage", () => {
  const plan = buildRebootPlan(
    { available: true, value: [{ upid: "x", type: "vzdump", id: "100" }] },
    { available: true, value: [{ storage: "qcow", avail: 2 * 1024 ** 3, active: 1, enabled: 1 }, { storage: "off", active: 0 }] },
  );
  assert.deepEqual(plan.busy, ["Backup on 100"]);
  assert.deepEqual(plan.backupStorages, [{ name: "qcow", freeGb: 2, shared: false }]);
  assert.equal(buildRebootPlan({ available: false }, { available: false }).busyKnown, false);
});

test("a move plan only offers servers that can take the guest", () => {
  const plan = buildMovePlan("qemu", "a", ["a", "b", "c"], { allowed_nodes: ["b"], not_allowed_nodes: { c: { unavailable_storages: ["fast"] } }, local_disks: [{}] }, true);
  assert.deepEqual(plan.targets, ["b"]);
  assert.deepEqual(plan.blocked, [{ name: "c", storages: ["fast"] }]);
  assert.equal(plan.localDisks, true);
  assert.equal(plan.interrupts, false);
});

test("an empty not-allowed entry doesn't block a move", () => {
  const plan = buildMovePlan("qemu", "a", ["a", "b"], { allowed_nodes: ["b"], not_allowed_nodes: { b: {} } }, true);
  assert.deepEqual(plan.targets, ["b"]);
  assert.deepEqual(plan.blocked, []);
});

test("running containers are interrupted by a move", () => {
  assert.equal(buildMovePlan("lxc", "a", ["a", "b"], {}, true).interrupts, true);
  assert.deepEqual(buildMovePlan("lxc", "a", ["a", "b"], {}, false).targets, ["b"]);
});

test("task results", () => {
  assert.equal(taskResult({ upid: "x" }), "running");
  assert.equal(taskResult({ upid: "x", status: "OK", endtime: 2 }), "ok");
  assert.equal(taskResult({ upid: "x", status: "WARNINGS: 1", endtime: 2 }), "warning");
  assert.equal(taskResult({ upid: "x", status: "unable to do thing", endtime: 2 }), "failed");
});

test("a limited account gets empty sections instead of a failure", () => {
  const no = { available: false } as const;
  const d = buildServerDetail("n1", { available: true, value: { pveversion: "pve-manager/9.2.2/abc", uptime: 60 } }, no, no, no, no, no, no);
  assert.equal(d.summary?.proxmoxVersion, "9.2.2");
  assert.equal(d.updates, null);
  assert.equal(d.channel, null);
});

const rolling = (name: string, version: string, updates: number | null = 1, more = {}) => ({ name, online: true, version, updates, rebootNeeded: false, busy: [] as string[], cantMove: [] as string[], ...more });
const healthy = { available: true as const, value: true };
const voteOn = { available: true as const, value: { State: "Connected" } };

test("rolling updates start with the oldest server, by number and not by text", () => {
  const plan = buildRollingPlan([rolling("a", "9.10.1"), rolling("b", "9.2.26"), rolling("c", "9.2.26")], healthy, voteOn);
  assert.deepEqual(plan.servers.map((s) => s.name), ["b", "c", "a"]);
});

test("servers with nothing waiting are left out of a rolling update", () => {
  const plan = buildRollingPlan([rolling("a", "9.2.26", 0), rolling("b", "9.2.26", 3)], healthy, voteOn);
  assert.deepEqual(plan.servers.map((s) => s.name), ["b"]);
  assert.deepEqual(plan.blocked, []);
});

test("a rolling update won't start on an unhealthy cluster", () => {
  assert.match(buildRollingPlan([rolling("a", "9"), rolling("b", "9", null, { online: false })], healthy, voteOn).blocked.join(), /back online first: b/);
  assert.match(buildRollingPlan([rolling("a", "9"), rolling("b", "9")], { available: true, value: false }, voteOn).blocked.join(), /lost its majority/);
  assert.match(buildRollingPlan([rolling("a", "9"), rolling("b", "9")], { available: false }, voteOn).blocked.join(), /can't tell/);
  assert.match(buildRollingPlan([rolling("a", "9", null), rolling("b", "9")], healthy, voteOn).blocked.join(), /can't read the updates on: a/);
  assert.match(buildRollingPlan([rolling("a", "9", 1, { busy: ["Backup"] }), rolling("b", "9")], healthy, voteOn).blocked.join(), /a is busy/);
});

test("two servers keep their majority only with a working tie-breaker", () => {
  const two = [rolling("a", "9"), rolling("b", "9")];
  assert.equal(buildRollingPlan(two, healthy, voteOn).keepsMajority, true);
  assert.equal(buildRollingPlan(two, healthy, { available: false }).keepsMajority, false);
  assert.equal(buildRollingPlan(two, healthy, { available: true, value: { State: "Disconnected" } }).keepsMajority, false, "a dead tie-breaker casts no vote");
  assert.equal(buildRollingPlan([...two, rolling("c", "9")], healthy, { available: false }).keepsMajority, true);
});

test("a guest that can't move only blocks a server that's going to restart", () => {
  const stuck = { cantMove: ["tiny-vm can't move."] };
  assert.deepEqual(buildRollingPlan([rolling("a", "9", 1, stuck), rolling("b", "9")], healthy, voteOn).blocked, []);
  assert.deepEqual(buildRollingPlan([rolling("a", "9", 1, { ...stuck, rebootNeeded: true }), rolling("b", "9")], healthy, voteOn).blocked, stuck.cantMove);
  assert.deepEqual(buildRollingPlan([rolling("a", "9", 0, { ...stuck, rebootNeeded: true }), rolling("b", "9")], healthy, voteOn).blocked, [], "nothing to install means it won't restart");
});

const task = (upid: string, type: string, starttime: number, more = {}) => ({ upid, type, starttime, status: "OK", endtime: starttime + 5, node: "a", ...more });

test("the task feed puts running work first, then the newest", () => {
  const feed = buildTaskFeed([
    task("old", "aptupdate", 100),
    task("new", "vzdump", 300),
    task("live", "qmigrate", 200, { status: undefined, endtime: undefined }),
  ], []);
  assert.deepEqual(feed.items.map((t) => t.upid), ["live", "new", "old"]);
  assert.equal(feed.running, 1);
});

test("the task feed leaves out console sessions and names guests", () => {
  const feed = buildTaskFeed([
    task("a", "vncproxy", 300, { id: "300" }),
    task("b", "vncshell", 290),
    task("c", "qmstart", 200, { id: "300" }),
    task("d", "qmstart", 100, { id: "999" }),
  ], [{ id: 300, name: "tiny-vm" }]);
  assert.deepEqual(feed.items.map((t) => t.target), ["tiny-vm", "999"], "a deleted guest keeps its number");
  assert.equal(feed.items[0]?.what, "Start VM");
});

test("the task feed shows every running task, however many", () => {
  const live = Array.from({ length: 9 }, (_, i) => task(`r${i}`, "vzdump", i, { status: undefined, endtime: undefined }));
  assert.equal(buildTaskFeed([...live, task("x", "aptupdate", 50)], []).items.length, 9);
  assert.equal(buildTaskFeed(Array.from({ length: 20 }, (_, i) => task(`f${i}`, "vzdump", i)), []).items.length, 6);
});

test("a failed task shows as failed", () => {
  assert.equal(buildTaskFeed([task("x", "qmshutdown", 1, { status: "got timeout" })], []).items[0]?.result, "failed");
});

test("an open console doesn't count as a node being busy", () => {
  const plan = buildRebootPlan({ available: true, value: [{ upid: "a", type: "vncproxy", id: "300" }, { upid: "b", type: "termproxy" }, { upid: "c", type: "vzdump", id: "200" }] }, { available: false });
  assert.deepEqual(plan.busy, ["Backup on 200"]);
});

test("the full task list merges every node, newest first, and says what it couldn't reach", () => {
  const log = buildTaskLog([
    { node: "a", tasks: [{ upid: "1", type: "qmstart", id: "100", user: "root@pam", starttime: 10, endtime: 11, status: "OK" }, { upid: "2", type: "vncproxy", id: "100", starttime: 5, endtime: 6, status: "OK" }] },
    { node: "b", tasks: [{ upid: "3", type: "qmstop", id: "7", starttime: 20, endtime: 21, status: "boom" }] },
  ], ["c"], [{ id: 100, name: "web" }], 2);
  assert.deepEqual(log.items.map((t) => [t.upid, t.node]), [["3", "b"], ["1", "a"], ["2", "a"]], "console sessions stay in the full list");
  assert.equal(log.items[1]?.target, "web");
  assert.equal(log.items[0]?.result, "failed");
  assert.equal(log.more, true, "a node hit the limit, so there may be more");
  assert.deepEqual(log.unreachable, ["c"]);
});
