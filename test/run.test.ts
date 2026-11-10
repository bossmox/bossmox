import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drive, readRun, writeRun, type Run, type RunDeps, type RunNode, type RunVm } from "../src/run.js";

const vm = (id: number, name: string, choice: "move" | "shutdown" = "move"): RunVm => ({ id, name, type: "qemu", choice, state: "waiting" });
const node = (name: string, vms: RunVm[], more: Partial<RunNode> = {}): RunNode => ({ name, install: true, restart: true, updates: 3, phase: "waiting", vms, note: null, keptConfig: [], ...more });
const run = (nodes: RunNode[]): Run => ({ id: "r1", kind: "update", by: "root@pam", startedAt: 1, finishedAt: null, running: false, stop: null, error: null, current: 0, nodes });

/** A pretend cluster that logs every call in order. */
function fake(opts: Partial<RunDeps> & { stopAfter?: string } = {}) {
  const log: string[] = [];
  let stop: string | null = null;
  const deps: RunDeps = {
    stopped: () => stop,
    save: () => {},
    wait: async () => {},
    notReady: async (n) => { log.push(`check ${n}`); return null; },
    shutdown: async (n, v) => { log.push(`shutdown ${v.name}`); },
    moveOff: async (n, ids) => { log.push(`moveOff ${n} ${ids.join(",")}`); return Object.fromEntries(ids.map((id) => [id, "elsewhere"])); },
    install: async (n) => { log.push(`install ${n}`); return { exitCode: 0, keptConfig: [], left: 0 }; },
    restart: async (n) => { log.push(`restart ${n}`); if (opts.stopAfter === `restart ${n}`) stop = "root@pam pressed Stop."; },
    start: async (n, v) => { log.push(`start ${v.name}`); },
    moveHome: async (n) => { log.push(`home ${n}`); return {}; },
    ...opts,
  };
  return { deps, log };
}

test("a node: shut down what was chosen, move the rest, install, restart, start, bring home; then the next node", async () => {
  const r = run([node("n1", [vm(1, "web"), vm(2, "app", "shutdown"), vm(3, "db")]), node("n2", [vm(4, "files")])]);
  const { deps, log } = fake();
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "shutdown app", "moveOff n1 1,3", "install n1", "restart n1", "start app", "home n1", "check n2", "moveOff n2 4", "install n2", "restart n2", "home n2"]);
  assert.equal(r.error, null);
  assert.equal(r.running, false);
  assert.deepEqual(r.nodes.map((n) => n.phase), ["done", "done"]);
  assert.deepEqual(r.nodes[0]?.vms.map((v) => v.state), ["home", "started", "home"]);
});

test("no kernel means no restart and nothing moves", async () => {
  const r = run([node("n1", [vm(1, "web")], { restart: false })]);
  const { deps, log } = fake();
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "install n1"]);
  assert.equal(r.nodes[0]?.vms[0]?.state, "waiting", "it stayed where it was, running");
});

test("a restart run doesn't install", async () => {
  const r = run([node("n1", [vm(1, "web")], { install: false })]);
  const { deps, log } = fake();
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "restart n1", "home n1"]);
});

test("a failed install stops before the restart, leaves later nodes untouched, and says why", async () => {
  const r = run([node("n1", [vm(1, "web")]), node("n2", [])]);
  const { deps, log } = fake({ install: async (n) => { log.push(`install ${n}`); return { exitCode: 100, keptConfig: [], left: 2 }; } });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1"]);
  assert.match(r.error ?? "", /n1: The install on n1 ended with an error \(apt exit code 100\), so it wasn't restarted/);
  assert.deepEqual(r.nodes.map((n) => n.phase), ["failed", "waiting"]);
  assert.equal(r.nodes[0]?.vms[0]?.state, "moved", "what moved is shown where it is, for Move everything back");
});

test("updates left after a clean install also stop the restart", async () => {
  const r = run([node("n1", [])]);
  const { deps } = fake({ install: async () => ({ exitCode: 0, keptConfig: ["/etc/lvm/lvm.conf"], left: 1 }) });
  await drive(r, deps);
  assert.match(r.error ?? "", /1 update is still waiting on n1/);
  assert.deepEqual(r.nodes[0]?.keptConfig, ["/etc/lvm/lvm.conf"]);
});

test("Stop finishes the step under way and starts nothing new", async () => {
  const r = run([node("n1", [vm(1, "web")]), node("n2", [vm(2, "db")])]);
  const { deps, log } = fake({ stopAfter: "restart n1" });
  await drive(r, deps);
  assert.deepEqual(log, ["check n1", "moveOff n1 1", "install n1", "restart n1"], "the restart finished; starting and coming home didn't begin");
  assert.match(r.error ?? "", /Stopped: root@pam pressed Stop\. n1 stopped after restarting/);
  assert.equal(r.nodes[1]?.phase, "waiting");
});

test("a VM that won't start doesn't stop the run, but the node says so", async () => {
  const r = run([node("n1", [vm(1, "app", "shutdown")]), node("n2", [])]);
  const { deps, log } = fake({ start: async () => { throw new Error("timeout"); } });
  await drive(r, deps);
  assert.equal(r.error, null);
  assert.equal(r.nodes[0]?.vms[0]?.state, "failed");
  assert.match(r.nodes[0]?.note ?? "", /not everything started: app/);
  assert.ok(log.includes("check n2"), "the run went on to the next node");
});

test("guests that didn't fit at home are shown as stayed, with why", async () => {
  const r = run([node("n1", [vm(1, "web"), vm(2, "db")])]);
  const { deps } = fake({ moveHome: async () => ({ 2: "db (8 GB memory) has nowhere to go" }) });
  await drive(r, deps);
  assert.deepEqual(r.nodes[0]?.vms.map((v) => `${v.name}:${v.state}`), ["web:home", "db:stayed"]);
});

test("a node that isn't ready is waited for, then given up on with the reason", async () => {
  const r = run([node("n1", [])]);
  const real = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const { deps } = fake({ notReady: async () => "n1 is busy: Backup on 101.", wait: async (ms) => { now += ms; } });
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
