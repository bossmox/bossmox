import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import { createJobs, type JobsContext } from "../src/jobs.js";

/**
 * A fake three-node cluster for the move and run logic (review #61). Each test starts from this and changes what
 * it needs. It answers the Proxmox paths jobs.ts reads; a write is recorded and answered with a task.
 */
interface Guest {
  id: number;
  name: string;
  node: string;
  type?: "qemu" | "lxc";
  running?: boolean;
  config?: Record<string, unknown>;
}
function cluster(opts: { nodes?: string[]; guests?: Guest[]; quorate?: boolean; qdevice?: Record<string, unknown>; ha?: string[] } = {}) {
  const nodes = opts.nodes ?? ["n1", "n2", "n3"];
  const guests: Guest[] = opts.guests ?? [
    { id: 100, name: "web", node: "n1" },
    { id: 101, name: "db", node: "n1" },
  ];
  const GB = 1024 ** 3;
  const writes: string[] = [];
  const gates: Promise<void>[] = [];
  const vm = (g: Guest) => ({ type: g.type ?? "qemu", vmid: g.id, name: g.name, node: g.node, status: g.running === false ? "stopped" : "running", maxmem: 2 * GB, mem: GB, maxcpu: 2, cpu: 0.05, template: 0 });
  const node = (n: string) => ({ type: "node", node: n, status: "online", maxcpu: 8, cpu: 0.1, maxmem: 32 * GB, mem: 4 * GB });
  const storage = (n: string) => ({ type: "storage", node: n, storage: "san", status: "available", maxdisk: 1000 * GB, disk: 100 * GB, shared: 1 });
  const answer = async (p: string): Promise<unknown> => {
    for (const g of gates) await g;
    if (p === "/cluster/resources") return [...nodes.map(node), ...nodes.map(storage), ...guests.map(vm)];
    if (p === "/cluster/resources?type=vm") return guests.map(vm);
    if (p === "/cluster/resources?type=node") return nodes.map(node);
    if (p === "/cluster/status") return [{ type: "cluster", quorate: opts.quorate === false ? 0 : 1 }, ...nodes.map((n) => ({ type: "node", name: n, online: 1 }))];
    if (p === "/cluster/config/qdevice") return opts.qdevice ?? {};
    if (p === "/cluster/config/nodes") return nodes.map((n, i) => ({ node: n, ring0_addr: `10.0.0.${i + 1}`, quorum_votes: 1 }));
    if (p === "/cluster/options") return {};
    if (p === "/cluster/ha/resources") return (opts.ha ?? []).map((sid) => ({ sid }));
    let m = /^\/nodes\/([^/]+)\/network$/.exec(p);
    if (m) return [{ cidr: `10.0.0.${nodes.indexOf(m[1] as string) + 1}/24` }];
    m = /^\/nodes\/([^/]+)\/status$/.exec(p);
    if (m) return { pveversion: "pve-manager/8.4.21/abc", cpuinfo: { model: "cpu", cpus: 8 }, cpu: 0.1, uptime: 1000 };
    m = /^\/nodes\/([^/]+)\/(qemu|lxc)\/(\d+)\/(config|snapshot|migrate)$/.exec(p);
    if (m) {
      const g = guests.find((x) => x.id === Number(m?.[3]));
      if (m[4] === "config") return { scsi0: `san:vm-${m[3]}-disk-0,size=10G`, net0: `virtio=BC:24:11:00:00:${m[3]},bridge=vmbr0`, ...(g?.config ?? {}) };
      if (m[4] === "snapshot") return [{ name: "current" }];
      return {};
    }
    if (/^\/nodes\/[^/]+\/tasks\?source=active$/.test(p)) return [];
    if (/^\/nodes\/[^/]+\/apt\/update$/.test(p)) return [];
    throw new Error(`fake Proxmox: no answer for ${p}`);
  };
  const dir = mkdtempSync(join(process.cwd(), "jobs-test-"));
  const ctx: JobsContext = {
    pve: {
      get: (p: string) => answer(p) as never,
      post: async (p: string) => {
        writes.push(`POST ${p}`);
        return "UPID:n1:0:0:0:x:1:root@pam:" as never;
      },
      put: async (p: string) => {
        writes.push(`PUT ${p}`);
        return null as never;
      },
    },
    preferences: () => ({ backupsElsewhere: false, updateCheck: false, keepFreePct: 10 }),
    loadOverview: async () => ({ nodes: nodes.map((n) => ({ name: n, online: true })), vms: [] }) as never,
    audit: () => {},
    jobEnded: () => {},
    shell: () => ({ pveUrl: new URL("https://10.0.0.1:8006") }),
    movesFile: join(dir, "moves.json"),
    runsFile: join(dir, "runs.json"),
    macs: () => new Set(),
  };
  return {
    jobs: createJobs(ctx),
    ctx,
    guests,
    writes,
    /** Holds every Proxmox answer until the returned function is called, to catch something mid-flight. */
    hold: () => {
      let open = () => {};
      gates.push(new Promise<void>((r) => { open = r; }));
      return () => open();
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const person = { username: "root@pam", ticket: "t" } as unknown as Session;

test("the run planner lists each running guest on the node with where it would go", async () => {
  const c = cluster();
  try {
    const plan = await c.jobs.runPlan("t", "restart", "n1");
    assert.deepEqual(plan.blocked, []);
    const n1 = plan.nodes[0]!;
    assert.equal(n1.name, "n1");
    assert.deepEqual(n1.vms.map((v) => [v.name, v.choice, v.canMove]), [["db", "move", true], ["web", "move", true]]);
    assert.ok(n1.vms.every((v) => v.to === "n2" || v.to === "n3"));
  } finally {
    c.done();
  }
});


test("a move job can't start while a run is still planning (#45)", async () => {
  const c = cluster();
  try {
    const release = c.hold();
    const run = c.jobs.startRun(person, "restart", "n1", true, {});
    // The run is planning: it has claimed the cluster but hasn't asked Proxmox anything back yet.
    await assert.rejects(c.jobs.startMoveJob(person, async () => null), (e: Error & { status?: number }) => e.status === 409);
    release();
    await run;
  } finally {
    c.done();
  }
});

test("BossMox in a container recognises itself and won't run on its node; in a VM it moves itself (#46)", async () => {
  const mine = "bc:24:11:aa:bb:cc";
  const guests = [{ id: 200, name: "bossmox", node: "n1", type: "lxc" as const, config: { net0: `name=eth0,bridge=vmbr0,hwaddr=${mine.toUpperCase()},ip=dhcp` } }, { id: 101, name: "db", node: "n1" }];
  const c = cluster({ guests });
  c.ctx.macs = () => new Set([mine]);
  try {
    const plan = await createJobs(c.ctx).runPlan("t", "restart", "n1");
    assert.equal(plan.nodes[0]!.vms.find((v) => v.name === "bossmox")!.self, true);
    assert.match(plan.blocked.join(" "), /BossMox runs in the container bossmox on n1/);
    await assert.rejects(createJobs(c.ctx).startRun(person, "restart", "n1", true, {}), /container bossmox/);
    assert.equal(c.writes.length, 0, "nothing was shut down or moved");
  } finally {
    c.done();
  }
  const v = cluster({ guests: [{ id: 300, name: "bossmox", node: "n1", config: { net0: `virtio=${mine.toUpperCase()},bridge=vmbr0` } }] });
  v.ctx.macs = () => new Set([mine]);
  try {
    const plan = await createJobs(v.ctx).runPlan("t", "restart", "n1");
    assert.deepEqual(plan.blocked, [], "a VM moves live, so the run can go");
    assert.equal(plan.nodes[0]!.vms[0]!.self, true);
  } finally {
    v.done();
  }
});

test("on two votes a run won't restart a node while HA looks after guests; a connected tie-breaker lets it go (#43, #51)", async () => {
  const two = (qdevice?: Record<string, unknown>) => cluster({ nodes: ["n1", "n2"], ha: ["vm:101"], ...(qdevice ? { qdevice } : {}) });
  for (const [why, q] of [["no tie-breaker", undefined], ["a tie-breaker that isn't connected", { State: "Disconnected" }]] as const) {
    const c = two(q);
    try {
      const plan = await c.jobs.runPlan("t", "restart", "n1");
      assert.match(plan.blocked.join(" "), /only 2 votes, and HA looks after one guest/, why);
      assert.equal(plan.keepsMajority, false, why);
      await assert.rejects(c.jobs.startRun(person, "restart", "n1", true, {}), /only 2 votes/, why);
      assert.equal(c.writes.length, 0, `nothing was touched (${why})`);
    } finally {
      c.done();
    }
  }
  const ok = two({ State: "Connected" });
  try {
    const plan = await ok.jobs.runPlan("t", "restart", "n1");
    assert.equal(plan.votes, 3);
    assert.deepEqual(plan.blocked, []);
  } finally {
    ok.done();
  }
  const noHa = cluster({ nodes: ["n1", "n2"] });
  try {
    assert.deepEqual((await noHa.jobs.runPlan("t", "restart", "n1")).blocked, [], "without HA guests nothing fences, so two votes are allowed");
  } finally {
    noHa.done();
  }
});
