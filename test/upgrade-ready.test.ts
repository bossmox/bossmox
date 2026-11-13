import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { PveClient } from "../src/pve.js";
import { createUpgradeReady, ownChecks } from "../src/upgrade-ready.js";

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
