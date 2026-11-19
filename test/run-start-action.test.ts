import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterActions } from "../src/actions/cluster.js";
import type { Session } from "../src/auth.js";

/** What run-start hands the run engine, with everything else stood in. */
function start(body: Record<string, unknown>) {
  const calls: { kind: string; server: string; confirmed: boolean; only: string }[] = [];
  const jobs = {
    startRun: async (_s: Session, kind: string, server: string, confirmed: boolean, _c: unknown, only = "") => {
      calls.push({ kind, server, confirmed, only });
      return "run:1";
    },
  };
  const action = clusterActions({ jobs } as never)["run-start"];
  assert.ok(action);
  const who = { username: "root@pam", ticket: "t" } as unknown as Session;
  return { calls, done: Promise.resolve().then(() => action("n1", who, body)) };
}

test("Upgrade this node is confirmed with the node's own name, not the cluster run's word (ADR 0044)", async () => {
  const named = start({ kind: "upgrade", only: "n2", confirm: "n2" });
  await named.done;
  assert.deepEqual(named.calls, [{ kind: "upgrade", server: "", confirmed: true, only: "n2" }]);

  const anyCase = start({ kind: "upgrade", only: "Node-2", confirm: "node-2" });
  await anyCase.done;
  assert.equal(anyCase.calls[0]?.confirmed, true, "the name confirms in any case, like other node actions");

  const word = start({ kind: "upgrade", only: "n2", confirm: "confirm" });
  await word.done;
  assert.equal(word.calls[0]?.confirmed, false, "the cluster run's word doesn't confirm one node");

  const cluster = start({ kind: "upgrade", confirm: "confirm" });
  await cluster.done;
  assert.deepEqual(cluster.calls, [{ kind: "upgrade", server: "", confirmed: true, only: "" }], "Upgrade all nodes is unchanged");
});

test("one node only for an upgrade, and only a valid node name", async () => {
  await assert.rejects(start({ kind: "update", only: "n2", confirm: "n2" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "restart", server: "n1", only: "n1", confirm: "n1" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "upgrade", only: "n2; reboot", confirm: "n2; reboot" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "upgrade", only: "../n2", confirm: "../n2" }).done, /isn't valid/);
});

test("a channel switch or update check waits for a run, an upgrade or a sources change (design rule R5)", async () => {
  const posts: string[] = [];
  const make = (state: { run?: boolean; upgrading?: string | null; sources?: boolean }) =>
    clusterActions({
      jobs: { currentRun: state.run ? { running: true } : null },
      nodeUpgrade: { running: () => state.upgrading ?? null },
      upgradeSources: { busy: () => state.sources ?? false },
      pve: {
        post: async (p: string) => {
          posts.push(p);
          return "UPID:n1:x";
        },
      },
    } as never);
  const who = { username: "root@pam", ticket: "t" } as unknown as Session;
  const call = (a: ReturnType<typeof make>, name: string, body: Record<string, unknown> = {}) => Promise.resolve().then(() => a[name]?.("n1", who, body));
  for (const [state, why] of [
    [{ run: true }, /A run is going/],
    [{ upgrading: "n2" }, /n2 is being upgraded/],
    [{ sources: true }, /changing a node's update sources/],
  ] as const) {
    await assert.rejects(call(make(state), "check-updates"), why);
    await assert.rejects(call(make(state), "update-channel", { channel: "free" }), why);
  }
  assert.deepEqual(posts, [], "nothing reached Proxmox");
  await call(make({}), "check-updates");
  assert.deepEqual(posts, ["/nodes/n1/apt/update"], "with nothing going on, the check runs");
});

test("Empty this node: typed name, every guest visible, never BossMox's own container, and BossMox's VM last (ADR 0044)", async () => {
  type M = { id: number; name: string; type: "qemu" | "lxc"; target: string };
  const web: M = { id: 100, name: "web", type: "qemu", target: "n2" };
  const make = (opts: { seesAll?: boolean; self?: M | null }) => {
    const actions = clusterActions({
      seesAllGuests: async () => opts.seesAll ?? true,
      jobs: {
        planEvacuation: async () => ({ problems: [], moves: [opts.self ?? web, web].filter((m, i, a) => a.indexOf(m) === i) }),
        selfGuest: async () => opts.self ?? null,
        batchFor: async () => 2,
        moveRecord: {},
        startMoveJob: async (_who: unknown, prepare: () => Promise<unknown>) => {
          await prepare();
          return "job";
        },
      },
    } as never);
    return { actions };
  };
  const who = { username: "root@pam", ticket: "t" } as unknown as Session;
  const call = (a: ReturnType<typeof make>["actions"], body: Record<string, unknown>) => Promise.resolve().then(() => a["move-off"]?.("n1", who, body));
  await assert.rejects(call(make({}).actions, { confirm: "n2" }), /wasn't confirmed/);
  await assert.rejects(call(make({ seesAll: false }).actions, { confirm: "n1" }), /can't see every guest/);
  await assert.rejects(call(make({ self: { id: 101, name: "bossmox", type: "lxc", target: "n2" } }).actions, { confirm: "N1" }), /BossMox runs in the container bossmox on n1/);
  assert.equal(await call(make({}).actions, { confirm: "N1" }), "job", "the name confirms in any case");
});

test("Move everything back needs an account that sees every guest, so it can't drop others from the record", async () => {
  const actions = clusterActions({ seesAllGuests: async () => false, jobs: { startMoveJob: async () => assert.fail("nothing starts") } } as never);
  const who = { username: "limited@pve", ticket: "t" } as unknown as Session;
  await assert.rejects(
    Promise.resolve().then(() => actions["move-home"]?.("n1", who, { confirm: "n1" })),
    /can't see every guest/,
  );
});
