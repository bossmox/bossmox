import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { PveClient } from "../src/pve.js";
import { createUpgradeReady, ownChecks, unfinishedUpgrade } from "../src/upgrade-ready.js";

const LAB = readFileSync(new URL("../../test/pve8to9-8.4-shared-lvm.txt", import.meta.url), "utf8");
const root = { username: "root@pam", ticket: "t" } as Session;

test("BossMox's own checks: too little root space blocks, passthrough and plugins are worth knowing", () => {
  assert.equal(ownChecks({ rootFreeGb: 3.2, passthrough: [], plugins: [] })[0]?.handling, "blocks");
  assert.equal(ownChecks({ rootFreeGb: 7, passthrough: [], plugins: [] })[0]?.handling, "advice");
  assert.deepEqual(ownChecks({ rootFreeGb: 26, passthrough: [], plugins: [] }), []);
  const more = ownChecks({ rootFreeGb: 26, passthrough: ["gpu-box"], plugins: ["fast (purestorage)"] });
  assert.deepEqual(
    more.map((x) => x.title),
    ["Passthrough: gpu-box", "Storage from outside Proxmox: fast (purestorage)"],
  );
  assert.equal(ownChecks({ rootFreeGb: null, passthrough: [], plugins: [] })[0]?.handling, "blocks", "unknown space isn't assumed fine");
});

function fakePve(): PveClient {
  const answers: Record<string, unknown> = {
    "/cluster/resources?type=node": [
      { node: "node1", status: "online" },
      { node: "node2", status: "online" },
      { node: "node3", status: "offline" },
    ],
    "/storage": [
      { storage: "ISCSI_SHARE", type: "lvm" },
      { storage: "local", type: "dir" },
    ],
  };
  return {
    get: async (p: string) => {
      if (p in answers) return answers[p];
      if (p.endsWith("/version")) return { version: "8.4.21" };
      if (p.endsWith("/status")) return { rootfs: { total: 32 * 1024 ** 3, used: 5 * 1024 ** 3 } };
      if (p.endsWith("/qemu")) return [{ vmid: 101, name: "web" }];
      if (p.endsWith("/config")) return { name: "web" };
      throw new Error(`unexpected ${p}`);
    },
  } as unknown as PveClient;
}

const settle = async (r: ReturnType<typeof createUpgradeReady>) => {
  for (let i = 0; i < 100 && r.view().running; i++) await new Promise((ok) => setTimeout(ok, 2));
};

test("every online node gets the checker for its own version; an offline one blocks", async () => {
  const typed: string[] = [];
  const r = createUpgradeReady({
    pve: fakePve(),
    console: async (node, _s, line) => {
      typed.push(`${node}: ${line}`);
      return { exitCode: 0, tail: "", output: LAB, keptConfig: [] };
    },
    now: () => Date.parse("2026-11-13T12:00:00Z"),
  });
  await r.start(root);
  await settle(r);
  const v = r.view();
  assert.deepEqual(typed, ["node1: pve8to9 --full", "node2: pve8to9 --full"]);
  assert.equal(v.from, 8);
  assert.equal(v.to, 9);
  assert.deepEqual(v.nodes[0]?.counts, { passed: 37, warnings: 3, failures: 0 });
  assert.ok(v.nodes[0]?.items.some((i) => i.handling === "fix" && i.title.startsWith("Shared LVM")));
  assert.equal(v.nodes[2]?.error, "This node is offline, so it couldn't be checked.");
  assert.equal(v.ready, false, "an unchecked node means not ready");
});

test("only root@pam can run it, and not twice at once", async () => {
  let release: () => void = () => {};
  const r = createUpgradeReady({ pve: fakePve(), console: () => new Promise((ok) => (release = () => ok({ exitCode: 0, tail: "", output: LAB, keptConfig: [] }))) });
  await assert.rejects(r.start({ username: "admin@pve", ticket: "t" } as Session), /root@pam/);
  const first = r.start(root);
  await assert.rejects(r.start(root), /already running/);
  await first;
  for (let i = 0; i < 5; i++) {
    release();
    await new Promise((ok) => setTimeout(ok, 5));
  }
  await settle(r);
});

test("a checker that didn't finish is an error, not a pass", async () => {
  const r = createUpgradeReady({ pve: fakePve(), console: async () => ({ exitCode: 127, tail: "", output: "pve8to9: command not found", keptConfig: [] }) });
  await r.start(root);
  await settle(r);
  assert.match(r.view().nodes[0]?.error ?? "", /didn't finish.*127/);
  assert.equal(r.view().ready, false);
});

// Kernel rows from Proxmox's apt/versions, as read on the lab's node2 (2026-11-16).
const STUCK = [
  { Package: "proxmox-ve", Version: "9.2.0", CurrentState: "Installed", RunningKernel: "6.8.12-43-pve" },
  { Package: "proxmox-kernel-7.0.14-29-pve-signed", Version: "7.0.14-29", CurrentState: "Installed" },
  { Package: "proxmox-kernel-6.8.12-43-pve-signed", Version: "6.8.12-43", CurrentState: "Installed" },
  { Package: "proxmox-kernel-6.8.12-42-pve-signed", Version: "6.8.12-42", CurrentState: "Installed" },
];
const DONE = STUCK.map((r) => (r.RunningKernel ? { ...r, RunningKernel: "7.0.14-29-pve" } : r));

test("a node stuck after its packages: new version, old kernel still running, the new series installed beside it", () => {
  assert.deepEqual(unfinishedUpgrade(STUCK), { running: "6.8.12-43-pve", waiting: "7.0.14-29-pve" });
  assert.equal(unfinishedUpgrade(DONE), null, "restarted onto the new kernel: finished");
  const sameSeries = [
    { Package: "proxmox-ve", RunningKernel: "6.8.12-42-pve" },
    { Package: "proxmox-kernel-6.8.12-43-pve-signed", CurrentState: "Installed" },
  ];
  assert.equal(unfinishedUpgrade(sameSeries), null, "a newer kernel of the same series is an ordinary update, not this");
  assert.equal(unfinishedUpgrade([{ Package: "proxmox-kernel-7.0.14-29-pve-signed", CurrentState: "Installed" }]), null, "no running kernel known: not assumed");
});

test("a mixed cluster: nodes already past the oldest version get no checker, and a stuck one says what finishes it", async () => {
  const typed: string[] = [];
  const base = fakePve();
  const pve = {
    get: async (p: string) => {
      if (p === "/cluster/resources?type=node")
        return [
          { node: "node1", status: "online" },
          { node: "node2", status: "online" },
          { node: "node3", status: "online" },
        ];
      if (p === "/nodes/node2/version") return { version: "9.2.28" };
      if (p === "/nodes/node3/version") return { version: "9.2.28" };
      if (p === "/nodes/node2/apt/versions") return STUCK;
      if (p === "/nodes/node3/apt/versions") return DONE;
      if (p.endsWith("/apt/versions")) return [];
      return base.get(p, "t");
    },
  } as unknown as PveClient;
  const r = createUpgradeReady({
    pve,
    console: async (node, _s, line) => {
      typed.push(`${node}: ${line}`);
      return { exitCode: 0, tail: "", output: LAB, keptConfig: [] };
    },
    now: () => Date.parse("2026-11-16T12:00:00Z"),
  });
  await r.start(root);
  await settle(r);
  const v = r.view();
  assert.deepEqual(typed, ["node1: pve8to9 --full"], "no pve9to10 on the nodes already on 9");
  assert.equal(v.from, 8);
  assert.deepEqual(
    v.nodes[1]?.items.map((i) => [i.handling, i.title]),
    [["bossmox", "On Proxmox VE 9, not restarted yet"]],
  );
  assert.deepEqual(
    v.nodes[2]?.items.map((i) => [i.handling, i.title]),
    [["advice", "Already on Proxmox VE 9"]],
  );
  assert.equal(v.nodes[1]?.error, null);
});

test("every node on 9 but one stuck: the stuck one still counts as 8, so nothing runs pve9to10", async () => {
  const typed: string[] = [];
  const pve = {
    get: async (p: string) => {
      if (p === "/cluster/resources?type=node") return [{ node: "node1", status: "online" }];
      if (p === "/storage") return [];
      if (p.endsWith("/version")) return { version: "9.2.28" };
      if (p.endsWith("/apt/versions")) return STUCK;
      throw new Error(`unexpected ${p}`);
    },
  } as unknown as PveClient;
  const r = createUpgradeReady({
    pve,
    console: async (n, _s, l) => {
      typed.push(`${n}: ${l}`);
      return { exitCode: 0, tail: "", output: LAB, keptConfig: [] };
    },
  });
  await r.start(root);
  await settle(r);
  assert.deepEqual(typed, []);
  assert.equal(r.view().from, 8);
  assert.equal(r.view().nodes[0]?.items[0]?.handling, "bossmox");
});
