import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drive, readRun, runFor, writeRun, type Run, type RunDeps, type RunNode, type RunVm } from "../src/run.js";

const vm = (id: number, name: string, choice: "move" | "shutdown" = "move"): RunVm => ({ id, name, type: "qemu", choice, state: "waiting" });
const node = (name: string, vms: RunVm[], more: Partial<RunNode> = {}): RunNode => ({ name, install: true, restart: true, updates: 3, phase: "waiting", vms, note: null, keptConfig: [], ...more });
const run = (nodes: RunNode[]): Run => ({ id: "r1", kind: "update", by: "root@pam", startedAt: 1, finishedAt: null, running: false, stop: null, error: null, current: 0, nodes });

/** A pretend cluster that logs every call in order. `stopAfter` presses Stop right after that call. */
function fake(opts: Partial<RunDeps> & { stopAfter?: string; at?: Run } = {}) {
  const log: string[] = [];
  let stop: string | null = null;
  const note = (entry: string) => {
    log.push(entry);
    if (opts.stopAfter === entry) stop = "root@pam pressed Stop.";
  };
  const deps: RunDeps = {
    stopped: () => stop,
    save: () => {},
    wait: async () => {},
    notReady: async (n) => {
      note(`check ${n}`);
      return null;
    },
    // By default each node runs what the run listed for it, minus what has since moved off or been shut down.
    runningOn: async (n) =>
      (opts.at?.nodes.find((x) => x.name === n)?.vms ?? []).filter((v) => !["moved", "off", "stayed", "home"].includes(v.state)).map(({ id, name, type }) => ({ id, name, type })),
    shutdown: async (_n, v) => {
      note(`shutdown ${v.name}`);
    },
    moveOff: async (n, ids) => {
      note(`moveOff ${n} ${ids.join(",")}`);
      return { went: Object.fromEntries(ids.map((id) => [id, "elsewhere"])), error: null };
    },
    install: async (n) => {
      note(`install ${n}`);
      return { exitCode: 0, keptConfig: [], left: 0 };
    },
    restart: async (n) => {
      note(`restart ${n}`);
    },
    start: async (_n, v) => {
      note(`start ${v.name}`);
    },
    moveHome: async (n) => {
      note(`home ${n}`);
      return {};
    },
    ...opts,
  };
  return { deps, log };
}

test("a node: shut down what was chosen, move the rest, install, restart, start, bring home; then the next node", async () => {
  const r = run([node("n1", [vm(1, "web"), vm(2, "app", "shutdown"), vm(3, "db")]), node("n2", [vm(4, "files")])]);
  const { deps, log } = fake({ at: r });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1,3", "install n1", "restart n1", "start app", "home n1", "check n2", "moveOff n2 4", "install n2", "restart n2", "home n2"]);
  assert.equal(r.error, null);
  assert.equal(r.running, false);
  assert.deepEqual(
    r.nodes.map((n) => n.phase),
    ["done", "done"],
  );
  assert.deepEqual(
    r.nodes[0]?.vms.map((v) => v.state),
    ["home", "started", "home"],
  );
});

test("no kernel means no restart and nothing moves", async () => {
  const r = run([node("n1", [vm(1, "web")], { restart: false })]);
  const { deps, log } = fake({ at: r });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "install n1"]);
  assert.equal(r.nodes[0]?.vms[0]?.state, "waiting", "it stayed where it was, running");
});

test("a restart run doesn't install", async () => {
  const r = run([node("n1", [vm(1, "web")], { install: false })]);
  const { deps, log } = fake({ at: r });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "restart n1", "home n1"]);
});

test("a failed install stops before the restart, leaves later nodes untouched, and says why", async () => {
  const r = run([node("n1", [vm(1, "web")]), node("n2", [])]);
  const { deps, log } = fake({
    at: r,
    install: async (n) => {
      log.push(`install ${n}`);
      return { exitCode: 100, keptConfig: [], left: 2 };
    },
  });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1"]);
  assert.match(r.error ?? "", /n1: The install on n1 ended with an error \(apt exit code 100\), so it wasn't restarted/);
  assert.deepEqual(
    r.nodes.map((n) => n.phase),
    ["failed", "waiting"],
  );
  assert.equal(r.nodes[0]?.vms[0]?.state, "moved", "what moved is shown where it is, for Move everything back");
});

test("updates left after a clean install also stop the restart", async () => {
  const r = run([node("n1", [])]);
  const { deps } = fake({ at: r, install: async () => ({ exitCode: 0, keptConfig: ["/etc/lvm/lvm.conf"], left: 1 }) });
  await drive(r, deps);
  assert.match(r.error ?? "", /1 update is still waiting on n1/);
  assert.deepEqual(r.nodes[0]?.keptConfig, ["/etc/lvm/lvm.conf"]);
});

test("Stop finishes the step under way and starts nothing new", async () => {
  const r = run([node("n1", [vm(1, "web")]), node("n2", [vm(2, "db")])]);
  const { deps, log } = fake({ at: r, stopAfter: "restart n1" });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1", "restart n1"], "the restart finished; coming home didn't begin");
  assert.match(r.error ?? "", /Stopped: root@pam pressed Stop\. n1 stopped after starting/);
  assert.equal(r.nodes[1]?.phase, "waiting");
});

test("a VM that won't start doesn't stop the run, but the node says so", async () => {
  const r = run([node("n1", [vm(1, "app", "shutdown")]), node("n2", [])]);
  const { deps, log } = fake({
    at: r,
    start: async () => {
      throw new Error("timeout");
    },
  });
  await drive(r, deps);
  assert.equal(r.error, null);
  assert.equal(r.nodes[0]?.vms[0]?.state, "failed");
  assert.match(r.nodes[0]?.note ?? "", /not everything started: app/);
  assert.ok(log.includes("check n2"), "the run went on to the next node");
});

test("guests that didn't fit at home are shown as stayed, with why", async () => {
  const r = run([node("n1", [vm(1, "web"), vm(2, "db")])]);
  let asked: number[] = [];
  const { deps } = fake({
    at: r,
    moveHome: async (_n, ids) => {
      asked = ids;
      return { 2: { on: "n2", why: "db (8 GB memory) has nowhere to go" } };
    },
  });
  await drive(r, deps);
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(
    r.nodes[0]?.vms.map((v) => `${v.name}:${v.state}`),
    ["web:home", "db:stayed"],
  );
  assert.equal(r.nodes[0]?.vms[1]?.on, "n2");
  assert.match(r.nodes[0]?.vms[1]?.note ?? "", /nowhere to go/);
});

test("a VM chosen to move that's still on the node stops the run before the install", async () => {
  // Live 2026-11-11: an empty move plan came back and the run went on to install and restart the node.
  const r = run([node("n1", [vm(1, "web"), vm(2, "db")]), node("n2", [])]);
  const { deps, log } = fake({
    at: r,
    moveOff: async (n, ids) => {
      log.push(`moveOff ${n} ${ids.join(",")}`);
      return { went: { 1: "n2" }, error: null };
    },
  });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1,2"], "no install, no restart, no next node");
  assert.match(r.error ?? "", /db didn't move off n1, so it wasn't updated or restarted/);
  assert.deepEqual(
    r.nodes[0]?.vms.map((v) => `${v.name}:${v.state}`),
    ["web:moved", "db:failed"],
  );
});

test("a VM already gone from the node (moved home elsewhere earlier in the run) counts as off it", async () => {
  // Live 2026-11-11: an old record brought cache home to n1 before n2's turn; n2 then had nothing to move.
  const r = run([node("n2", [vm(3, "cache")])]);
  const { deps, log } = fake({
    runningOn: async () => [],
    moveOff: async (n, ids) => {
      log.push(`moveOff ${n} ${ids.join(",")}`);
      return { went: { 3: "n1" }, error: null };
    },
    moveHome: async (n, ids) => {
      log.push(`home ${n} ${ids.join(",")}`);
      return { 3: { on: "n1", why: "BossMox's record has another node as its home" } };
    },
  });
  await drive(r, deps);
  assert.equal(r.error, null);
  assert.deepEqual(log, ["check n2", "moveOff n2 3", "install n2", "restart n2", "home n2 3"]);
  assert.equal(r.nodes[0]?.note, null, "nothing failed");
  assert.equal(r.nodes[0]?.vms[0]?.state, "stayed");
  assert.equal(r.nodes[0]?.vms[0]?.on, "n1");
});

test("a guest that arrived on a later node during the run is moved off it before that node restarts", async () => {
  // Live 2026-11-11: web stayed on n3 after n1's turn; n3 had been listed as running nothing and restarted with web on it.
  const r = run([node("n1", [vm(1, "web")]), node("n3", [])]);
  // web runs on n1 until it moves off; at n3's turn it's running on n3 until it moves off there too.
  const web = { id: 1, name: "web", type: "qemu" as const };
  const movedFrom = (i: number) => r.nodes[i]?.vms.find((v) => v.id === 1)?.state === "moved";
  const { deps, log } = fake({ at: r, runningOn: async (n) => ((n === "n1" ? !movedFrom(0) : !movedFrom(1)) ? [web] : []) });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1", "restart n1", "home n1", "check n3", "moveOff n3 1", "install n3", "restart n3", "home n3"]);
  assert.deepEqual(
    r.nodes[1]?.vms.map((v) => `${v.name}:${v.choice}:${v.note}`),
    ["web:move:arrived during the run"],
  );
});

test("a VM chosen to shut down that isn't running there at its turn is left alone", async () => {
  const r = run([node("n1", [vm(2, "app", "shutdown")])]);
  const { deps, log } = fake({ at: r, runningOn: async () => [] });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "install n1", "restart n1"]);
  assert.equal(r.nodes[0]?.vms[0]?.note, "wasn't running here at its turn");
});

test("a node that isn't ready is waited for, then given up on with the reason", async () => {
  const r = run([node("n1", [])]);
  const real = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const { deps } = fake({
      at: r,
      notReady: async () => "n1 is busy: Backup on 101.",
      wait: async (ms) => {
        now += ms;
      },
    });
    await drive(r, deps);
  } finally {
    Date.now = real;
  }
  assert.match(r.error ?? "", /n1 is busy: Backup on 101/);
});

test("a run cut off by a BossMox restart reads as stopped, with where it was, and never resumes", () => {
  const dir = mkdtempSync(join(process.cwd(), "run-test-"));
  try {
    const file = join(dir, "runs.json");
    const r = run([node("n1", [vm(1, "web")], { phase: "done" }), node("n2", [], { phase: "installing" })]);
    r.running = true;
    r.current = 1;
    writeRun(file, r);
    const back = readRun(file);
    assert.equal(back?.running, false);
    assert.match(back?.error ?? "", /BossMox restarted during the run, while n2 was installing/);
    assert.equal(back?.nodes[1]?.phase, "failed");
    assert.equal(readRun(join(dir, "nothing.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop during the moves: what wasn't moved reads as still here, and what was shut down starts again", async () => {
  // Live 2026-11-11: Stop during emptying left cache off for a restart that never came, and the rest read "Problem".
  const r = run([node("n1", [vm(1, "web"), vm(2, "app", "shutdown"), vm(3, "db")])]);
  const { deps, log } = fake({
    at: r,
    moveOff: async (n, ids) => {
      log.push(`moveOff ${n} ${ids.join(",")}`);
      r.stop = "root@pam pressed Stop.";
      return { went: { 1: "n2" }, error: "BossMox stopped before the next move: root@pam pressed Stop." };
    },
  });
  deps.stopped = () => r.stop;
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1,3", "start app"], "no install, no restart");
  assert.match(r.error ?? "", /^Stopped: root@pam pressed Stop\. n1 stopped after emptying/);
  assert.deepEqual(
    r.nodes[0]?.vms.map((v) => `${v.name}:${v.state}`),
    ["web:moved", "app:started", "db:waiting"],
  );
  assert.match(r.nodes[0]?.vms[1]?.note ?? "", /started again: n1 wasn't restarted/);
});

test("a failed install starts again what was shut down; a failed restart doesn't try", async () => {
  const a = run([node("n1", [vm(2, "app", "shutdown")])]);
  const fa = fake({ at: a, install: async () => ({ exitCode: 1, keptConfig: [], left: 3 }) });
  await drive(a, fa.deps);
  assert.deepEqual(fa.log, ["check n1", "shutdown app", "start app"]);
  const b = run([node("n1", [vm(2, "app", "shutdown")])]);
  const fb = fake({
    at: b,
    restart: async () => {
      throw new Error("n1 hasn't come back after 20 minutes.");
    },
  });
  await drive(b, fb.deps);
  assert.deepEqual(fb.log, ["check n1", "shutdown app", "install n1"]);
  assert.equal(b.nodes[0]?.vms[0]?.state, "off");
});

test("someone who can't see the whole cluster sees only their own nodes and guests of a run (review S6)", () => {
  const run: Run = {
    id: "r1",
    kind: "update",
    by: "root@pam",
    startedAt: 1,
    finishedAt: null,
    running: true,
    stop: "alice@pve pressed Stop.",
    current: 0,
    error: "secret-vm didn't move off n2, so it wasn't updated or restarted.",
    nodes: [
      {
        name: "n1",
        install: true,
        restart: true,
        updates: 3,
        phase: "emptying",
        note: "secret-vm arrived",
        keptConfig: [],
        vms: [
          { id: 100, name: "mine", type: "qemu", choice: "move", state: "moving" },
          { id: 200, name: "secret-vm", type: "qemu", choice: "move", state: "moving" },
        ],
      },
      { name: "n2", install: true, restart: true, updates: 1, phase: "waiting", note: null, keptConfig: [], vms: [] },
    ],
  };
  const limited = { full: false, nodes: new Set(["n1"]), guests: new Set([100]) };
  const seen = runFor(run, limited)!;
  assert.deepEqual(
    seen.nodes.map((n) => n.name),
    ["n1"],
  );
  assert.deepEqual(
    seen.nodes[0]!.vms.map((v) => v.name),
    ["mine"],
  );
  assert.equal(JSON.stringify(seen).includes("secret-vm"), false, "no hidden guest's name anywhere");
  assert.equal(JSON.stringify(seen).includes("root@pam"), false, "not who started it");
  assert.equal(JSON.stringify(seen).includes("alice@pve"), false, "not who pressed Stop (review 2, S6)");
  assert.equal(runFor(run, { ...limited, full: true }), run, "someone who can change the cluster sees all of it");
  assert.equal(runFor(null, limited), null);
});

test("Stop at any point never leaves a guest switched off (#44)", async () => {
  // Every call the run makes on n1, in order. Stop is pressed right after each one in turn.
  const steps = ["check n1", "shutdown app", "moveOff n1 1", "install n1", "restart n1", "start app", "home n1"];
  for (const at of steps) {
    const r = run([node("n1", [vm(1, "web"), vm(2, "app", "shutdown")]), node("n2", [])]);
    const { deps, log } = fake({ at: r, stopAfter: at });
    await drive(r, deps);
    const states = r.nodes[0]!.vms.map((v) => v.state);
    assert.equal(states.includes("off"), false, `Stop after "${at}" left a guest off: ${states.join(", ")} (${log.join(" > ")})`);
    assert.match(r.error ?? "", /Stopped/, at);
    assert.equal(log.includes("check n2"), false, `nothing new starts after Stop (${at})`);
  }
});

test("a guest that lands on the node during its moves or install is moved off before the restart (#49)", async () => {
  const r = run([node("n1", [vm(1, "web")])]);
  let installed = false;
  const { deps, log } = fake({
    at: r,
    install: async (n) => {
      log.push(`install ${n}`);
      installed = true;
      return { exitCode: 0, keptConfig: [], left: 0 };
    },
    // Before the install n1 runs web; after it, someone has started "late" there.
    runningOn: async () => (installed ? [{ id: 9, name: "late", type: "qemu" as const }] : [{ id: 1, name: "web", type: "qemu" as const }]),
  });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1", "moveOff n1 9", "restart n1", "home n1"]);
  assert.equal(r.error, null);
  assert.equal(r.nodes[0]!.vms.find((v) => v.name === "late")?.note, "arrived during the run");
});

test("one that arrives and can't move off stops the run before the restart (#49)", async () => {
  const r = run([node("n1", [])]);
  let installed = false;
  const { deps, log } = fake({
    at: r,
    install: async (n) => {
      log.push(`install ${n}`);
      installed = true;
      return { exitCode: 0, keptConfig: [], left: 0 };
    },
    runningOn: async () => (installed ? [{ id: 9, name: "late", type: "qemu" as const }] : []),
    moveOff: async (n, ids) => {
      log.push(`moveOff ${n} ${ids.join(",")}`);
      return { went: {}, error: null };
    },
  });
  await drive(r, deps);
  assert.equal(log.includes("restart n1"), false, "never restarted with a guest still on it");
  assert.match(r.error ?? "", /late arrived on n1 during the run and didn't move off/);
});

test("a node that ends before its reboot is asked for starts again what was shut down (review 2)", async () => {
  // The late-arrival move just before the reboot fails: the node never restarts, so app mustn't stay off.
  const r = run([node("n1", [vm(1, "web"), vm(2, "app", "shutdown")])]);
  let installed = false;
  const { deps, log } = fake({
    at: r,
    install: async (n) => {
      log.push(`install ${n}`);
      installed = true;
      return { exitCode: 0, keptConfig: [], left: 0 };
    },
    runningOn: async () =>
      installed
        ? [{ id: 9, name: "late", type: "qemu" as const }]
        : [
            { id: 1, name: "web", type: "qemu" as const },
            { id: 2, name: "app", type: "qemu" as const },
          ],
    moveOff: async (n, ids) => {
      log.push(`moveOff ${n} ${ids.join(",")}`);
      return ids.includes(9) ? { went: {}, error: null } : { went: Object.fromEntries(ids.map((id) => [id, "elsewhere"])), error: null };
    },
  });
  await drive(r, deps);
  assert.equal(log.includes("restart n1"), false);
  assert.equal(r.nodes[0]!.vms.find((v) => v.name === "app")!.state, "started");
});

// Upgrade runs (ADR 0042, piece 6): the one-node upgrade stands in for the install and the restart.
const up = (name: string, vms: RunVm[], finishing = false) => node(name, vms, { install: false, updates: 0, upgrade: { to: 9, finishing } });
const upgraded =
  (log: string[], result: Partial<import("../src/run.js").UpgradeResult> = {}) =>
  async (n: string) => {
    log.push(`upgrade ${n}`);
    return { restarted: true, packagesTouched: true, error: null, keptConfig: ["/etc/issue"], version: "9.2.28", kernel: "7.0.14-29-pve", ...result };
  };

test("an upgrade run: empty the node, upgrade it, start what was shut down, bring guests home; then the next", async () => {
  const r = { ...run([up("n1", [vm(1, "web"), vm(2, "app", "shutdown")]), up("n2", [vm(3, "db")])]), kind: "upgrade" as const };
  const { deps, log } = fake({ at: r });
  deps.upgrade = upgraded(log);
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1", "upgrade n1", "start app", "home n1", "check n2", "moveOff n2 3", "upgrade n2", "home n2"]);
  assert.ok(!log.some((l) => l.startsWith("install") || l.startsWith("restart")), "no separate install or restart");
  assert.equal(r.error, null);
  assert.deepEqual(r.nodes[0]?.upgrade, { to: 9, finishing: false, version: "9.2.28", kernel: "7.0.14-29-pve" });
  assert.deepEqual(r.nodes[0]?.keptConfig, ["/etc/issue"]);
});

test("an upgrade that fails before its packages stops the run and starts again what was shut down", async () => {
  const r = { ...run([up("n1", [vm(1, "web"), vm(2, "app", "shutdown")]), up("n2", [])]), kind: "upgrade" as const };
  const { deps, log } = fake({ at: r });
  deps.upgrade = upgraded(log, { restarted: false, packagesTouched: false, error: "Proxmox's checker found 1 problem (x) on n1. Nothing was changed; fix them first." });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1", "upgrade n1", "start app"]);
  assert.match(r.error ?? "", /^n1: Proxmox's checker found/);
  assert.equal(r.nodes[0]?.phase, "failed");
  assert.equal(r.nodes[1]?.phase, "waiting", "the next node is never touched");
  assert.equal(r.nodes[0]?.vms.find((v) => v.name === "app")?.note, "started again: n1 wasn't restarted");
});

test("an upgrade that fails after its packages began, before the restart, leaves what was shut down off (design review 2026-11-19)", async () => {
  const r = { ...run([up("n1", [vm(1, "web"), vm(2, "app", "shutdown")]), up("n2", [])]), kind: "upgrade" as const };
  const { deps, log } = fake({ at: r });
  deps.upgrade = upgraded(log, { restarted: false, packagesTouched: true, error: "After the packages, Proxmox's checker found 1 problem (x) on n1, so it wasn't restarted." });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1", "upgrade n1"], "nothing starts on a node part way between versions");
  const app = r.nodes[0]?.vms.find((v) => v.name === "app");
  assert.equal(app?.state, "off");
  assert.match(app?.note ?? "", /still off: the upgrade of n1 stopped after its packages began installing/);
  assert.equal(r.nodes[1]?.phase, "waiting");
});

test("an upgrade that fails after its restart doesn't start guests again or bring any home", async () => {
  const r = { ...run([up("n1", [vm(1, "web"), vm(2, "app", "shutdown")])]), kind: "upgrade" as const };
  const { deps, log } = fake({ at: r });
  deps.upgrade = upgraded(log, { restarted: true, error: "n1 came back on its old kernel (6.8.12-43-pve)." });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1", "upgrade n1"]);
  assert.match(r.error ?? "", /old kernel/);
  // It says so on the guest itself, not only in the run's error (review 2026-11-16).
  const app = r.nodes[0]?.vms.find((v) => v.name === "app");
  assert.equal(app?.state, "off");
  assert.match(app?.note ?? "", /still off: n1 restarted but didn't pass its checks/);
});

test("Stop before a node's upgrade leaves it untouched; Stop during one lets it finish", async () => {
  const before = { ...run([up("n1", [vm(1, "web")])]), kind: "upgrade" as const };
  const a = fake({ at: before, stopAfter: "moveOff n1 1" });
  a.deps.upgrade = upgraded(a.log);
  await drive(before, a.deps);
  assert.ok(!a.log.includes("upgrade n1"), "Stop after the moves: no upgrade begins");
  assert.match(before.error ?? "", /Stopped: .* n1 stopped after emptying/);

  const during = { ...run([up("n1", [vm(1, "web")]), up("n2", [])]), kind: "upgrade" as const };
  const b = fake({ at: during });
  let pressed = false;
  b.deps.stopped = () => (pressed ? "root@pam pressed Stop." : null);
  b.deps.upgrade = async (n) => {
    pressed = true; // pressed while the upgrade is under way
    return upgraded(b.log)(n);
  };
  await drive(during, b.deps);
  assert.ok(b.log.includes("upgrade n1"));
  assert.ok(!b.log.includes("check n2"), "nothing new starts after it");
  assert.equal(during.nodes[0]?.upgrade?.version, "9.2.28", "the upgrade under way ran to its end");
});

test("a guest that lands on the node during its moves is moved off before the upgrade", async () => {
  const r = { ...run([up("n1", [vm(1, "web")])]), kind: "upgrade" as const };
  let reads = 0;
  const { deps, log } = fake({ at: r });
  deps.runningOn = async () => (reads++ === 1 ? [{ id: 9, name: "late", type: "qemu" }] : []);
  deps.upgrade = upgraded(log);
  await drive(r, deps);
  assert.deepEqual(log.slice(0, 4), ["check n1", "moveOff n1 1", "moveOff n1 9", "upgrade n1"]);
});

test("a limited account gets an allowed list of a run's fields, counted against the nodes it sees (rule R11)", () => {
  const away = { ...vm(1, "web"), state: "moved" as const, on: "secret-node" };
  const r = {
    ...run([node("secret-node", [vm(9, "hidden")]), node("n1", [away, vm(2, "app")]), node("n2", [])]),
    running: true,
    current: 1,
    keepFreePct: 5,
    somethingAddedLater: "a name nobody chose to show",
  } as Run & { somethingAddedLater: string };
  const seen = runFor(r, { full: false, nodes: new Set(["n1", "n2"]), guests: new Set([1, 2]) }) as Run & Record<string, unknown>;
  assert.deepEqual(
    seen.nodes.map((n) => n.name),
    ["n1", "n2"],
  );
  assert.equal(seen.current, 0, "n1 is the first node this person sees, and it's the one under way");
  assert.equal(seen.keepFreePct, undefined, "not chosen to show");
  assert.equal(seen.somethingAddedLater, undefined, "a new field stays hidden until it's added on purpose");
  assert.equal(seen.nodes[0]?.vms.find((v) => v.id === 1)?.on, undefined, "a node it can't see isn't named as where a guest went");
});
