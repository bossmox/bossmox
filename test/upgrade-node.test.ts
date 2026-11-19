import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { RawRepositories } from "../src/server-detail.js";
import type { ShellResult } from "../src/node-shell.js";
import type { Readiness } from "../src/upgrade-ready.js";
import {
  createNodeUpgrade,
  createRunUpgrade,
  FOLLOW_SCRIPT,
  onRelease,
  READY_FOR_MS,
  readUpgrade,
  readProgress,
  followCommand,
  UPGRADE_NEEDS_MS,
  UPGRADE_SCRIPT,
  upgradeCommand,
  upgradeScript,
  type NodeUpgrade,
  type NodeUpgradeDeps,
} from "../src/upgrade-node.js";

const ON_TRIXIE: RawRepositories = {
  files: [
    { path: "/etc/apt/sources.list.d/proxmox.sources", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-no-subscription"] }] },
    {
      path: "/etc/apt/sources.list.d/debian.sources",
      repositories: [{ Enabled: 1, URIs: ["mirror+file:///etc/apt/mirrors/debian.list"], Suites: ["trixie", "trixie-updates"], Components: ["main"] }],
    },
  ],
  infos: [{ path: "/etc/apt/sources.list.d/debian.sources", index: 0, kind: "origin", message: "Debian" }],
};
const ON_BOOKWORM: RawRepositories = {
  files: [{ path: "/etc/apt/sources.list.d/pve.list", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-no-subscription"] }] }],
  infos: [],
};

test("the upgrade answers no questions, keeps changed config files, and runs as its own job", () => {
  assert.match(UPGRADE_SCRIPT, /--unit=bossmox-upgrade/);
  assert.match(UPGRADE_SCRIPT, /DEBIAN_FRONTEND=noninteractive/);
  assert.match(UPGRADE_SCRIPT, /UCF_FORCE_CONFFOLD=1/);
  assert.match(UPGRADE_SCRIPT, /APT_LISTCHANGES_FRONTEND=none/);
  assert.match(UPGRADE_SCRIPT, /--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade/);
  // A failed package refresh must not go on to upgrade from the old lists.
  assert.match(UPGRADE_SCRIPT, /apt-get -o DPkg::Lock::Timeout=600 update -q \|\| \{ echo 100/);
  // Both apt runs wait for a lock someone else holds (unattended-upgrades after a start, lab 2026-11-16).
  assert.equal(UPGRADE_SCRIPT.match(/apt-get -o DPkg::Lock::Timeout=600 /g)?.length, 2);
  // Never started twice: one already running is followed.
  assert.match(UPGRADE_SCRIPT, /^if ! systemctl is-active --quiet bossmox-upgrade; then/);
  assert.ok(UPGRADE_SCRIPT.endsWith(FOLLOW_SCRIPT));
  // Typed as base64, so the console's echo can't hold a marker line.
  assert.doesNotMatch(upgradeCommand("0000000000000000"), /BMXUP/);
  assert.equal(Buffer.from(/'([A-Za-z0-9+/=]+)'/.exec(upgradeCommand("0000000000000000"))?.[1] ?? "", "base64").toString(), UPGRADE_SCRIPT);
});

test("reading the node: running, ended with a code, killed, or nothing readable", () => {
  assert.equal(readUpgrade("BMXUP running\n").state, "running");
  const done = readUpgrade("BMXUP exit 0\nConfiguration file '/etc/issue'\nConfiguration file '/etc/default/grub'\nConfiguration file '/etc/issue'\n");
  assert.deepEqual(done, { state: "ended", exitCode: 0, keptConfig: ["/etc/issue", "/etc/default/grub"], errors: [] });
  const bad = readUpgrade("BMXUP exit 100\nBMXERR E: Sub-process /usr/bin/dpkg returned an error code (1)\n");
  assert.equal(bad.exitCode, 100);
  assert.deepEqual(bad.errors, ["E: Sub-process /usr/bin/dpkg returned an error code (1)"]);
  assert.deepEqual(readUpgrade("BMXUP noexit\n"), { state: "ended", exitCode: null, keptConfig: [], errors: [] });
  assert.equal(readUpgrade("bash: base64: command not found\n").state, "unknown");
});

test("only a node whose Proxmox source is on the new release counts as switched", () => {
  assert.equal(onRelease(ON_TRIXIE, "trixie"), true);
  assert.equal(onRelease(ON_BOOKWORM, "trixie"), false);
});

const root = (): Session => ({ username: "root@pam", ticket: "t", csrf: "c", renewedAt: 0, expiresAt: Date.now() + 10 * 60 * 60 * 1000 });
const out = (output: string, exitCode = 0): ShellResult => ({ exitCode, output, tail: output, keptConfig: [] });
const CHECK_OK = "= SUMMARY =\n\nTOTAL:    40\nPASSED:   37\nSKIPPED:  0\nWARNINGS: 3\nFAILURES: 0\n";
const CHECK_FAIL = "= SUMMARY =\n\nTOTAL:    40\nPASSED:   36\nSKIPPED:  0\nWARNINGS: 3\nFAILURES: 1\n";

/** The real 9 checker on a VM after the packages: 1 failure, the missing microcode package. */
const CHECK_AFTER_VM = readFileSync(new URL("../../test/pve8to9-9.2-after-packages.txt", import.meta.url), "utf8");
const CHECK_AFTER_UNKNOWN = "FAIL: something new went wrong\n\n= SUMMARY =\n\nTOTAL:    40\nPASSED:   39\nSKIPPED:  0\nWARNINGS: 0\nFAILURES: 1\n";
/** apt/versions on a node whose 9 packages are in but which still runs 8's kernel. */
const kernels = (running: string) => [
  { Package: "proxmox-ve", Version: "9.1.0", CurrentState: "Installed", RunningKernel: running },
  { Package: "proxmox-kernel-6.17.2-1-pve-signed", Version: "6.17.2-1", CurrentState: "Installed" },
  { Package: "proxmox-kernel-6.8.12-43-pve-signed", Version: "6.8.12-43", CurrentState: "Installed" },
];

/**
 * A fake cluster: node2 on 8.4 with its sources switched and nothing running, which turns 9 after the packages.
 * With `stuck`, node2's packages are on 9 already and it still runs the old kernel.
 */
function lab(
  over: {
    guests?: unknown[];
    repos?: RawRepositories;
    apt?: string[];
    pinOk?: boolean;
    kernelAfter?: string;
    checkerBefore?: string;
    checkerAfter?: string;
    stuck?: boolean;
    /** What asking the node about its package job answers, in turn. Nothing left: no job there. */
    follow?: string[];
    /** A guest starts on n2 once its packages are in, before the restart. */
    arrive?: boolean;
    /** The node's sources once its packages are in, and its subscription (keeping the free channel, ADR 0044). */
    reposAfter?: RawRepositories;
    sub?: { status: string };
  } = {},
) {
  const calls: string[] = [];
  const off = new Set<string>();
  const follow = [...(over.follow ?? [])];
  // What the node's id file holds: a stuck node's job was started by an earlier upgrade.
  let jobId: string | null = over.stuck ? "feedfacefeedface" : null;
  const withId = (text: string) => (jobId && !text.startsWith("BMXID") ? `BMXID ${jobId}\n${text}` : text);
  let upgraded = over.stuck ?? false;
  let rebooted = false;
  const deps: NodeUpgradeDeps = {
    pve: {
      async get<T>(path: string): Promise<T> {
        const r = (() => {
          if (path.endsWith("/version")) return { version: upgraded ? "9.1.1" : "8.4.21" };
          if (path.endsWith("/status") && path.startsWith("/nodes"))
            return { rootfs: { avail: 20 * 1024 ** 3 }, "current-kernel": { release: rebooted ? (over.kernelAfter ?? "6.17.2-1-pve") : "6.8.12-43-pve" } };
          if (path === "/cluster/status") return [{ type: "cluster", quorate: 1 }];
          if (path === "/cluster/resources?type=node")
            return [
              { node: "n1", status: "online" },
              { node: "n2", status: "online" },
            ];
          if (path === "/cluster/resources?type=vm")
            return [
              ...(over.guests ?? [{ node: "n1", vmid: 100, name: "bossmox", status: "running" }]),
              ...(over.arrive && upgraded ? [{ node: "n2", vmid: 105, name: "late", status: "running" }] : []),
            ];
          if (path.endsWith("/apt/repositories")) {
            const r = upgraded && over.reposAfter ? over.reposAfter : (over.repos ?? ON_TRIXIE);
            // What BossMox turned off reads back as off, as Proxmox would show it.
            return { ...r, files: (r.files ?? []).map((f) => ({ ...f, repositories: (f.repositories ?? []).map((x, i) => (off.has(`${f.path}#${i}`) ? { ...x, Enabled: 0 } : x)) })) };
          }
          if (path.endsWith("/subscription")) {
            if (!over.sub) throw new Error("no subscription answer");
            return over.sub;
          }
          if (path.endsWith("/apt/update")) return over.apt ?? [];
          if (path.endsWith("/apt/versions")) return upgraded ? kernels(rebooted ? (over.kernelAfter ?? "6.17.2-1-pve") : "6.8.12-43-pve") : [];
          throw new Error(`unexpected ${path}`);
        })();
        return r as T;
      },
      async post<T>(path: string, _who: unknown, form?: Record<string, string>): Promise<T> {
        if (path.endsWith("/apt/repositories") && form?.enabled === "0") {
          calls.push(`off ${form.path}`);
          off.add(`${form.path}#${form.index}`);
        }
        return null as T;
      },
    },
    console: async (_node, _s, line) => {
      if (line.startsWith("pve8to9")) {
        calls.push(upgraded ? "checker-after" : "checker");
        return out(upgraded ? (over.checkerAfter ?? CHECK_OK) : (over.checkerBefore ?? CHECK_OK));
      }
      if (line === followCommand()) {
        calls.push("follow");
        return out(withId(follow.shift() ?? "BMXUP noexit\n"));
      }
      calls.push("upgrade");
      jobId = idIn(line);
      upgraded = true;
      return out(withId("BMXUP exit 0\nConfiguration file '/etc/issue'\n"));
    },
    pin: async () => {
      calls.push("pin");
      return { node: "n2", ok: over.pinOk ?? true, renames: [], already: true, error: over.pinOk === false ? "no" : null };
    },
    reboot: async () => {
      calls.push("reboot");
      rebooted = true;
    },
    sources: { busy: () => false, forget: () => calls.push("forget") },
    audit: () => {},
    pause: async () => {},
  };
  return { deps, calls };
}
/** The upgrade id in a typed upgrade command, as the node would write it. */
const idIn = (line: string) => /echo ([0-9a-f]{16}) >/.exec(Buffer.from(/'([A-Za-z0-9+/=]+)'/.exec(line)?.[1] ?? "", "base64").toString())?.[1] ?? null;
const finish = async (job: ReturnType<typeof createNodeUpgrade>, node: string) => {
  for (let i = 0; i < 100 && job.running(); i++) await new Promise((r) => setTimeout(r, 1));
  return job.view()[node];
};

test("a switched, empty node goes through every step in order and is checked on the new version", async () => {
  const { deps, calls } = lab();
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "N2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(calls, ["checker", "upgrade", "forget", "checker-after", "pin", "reboot"]);
  assert.equal(r?.version, "9.1.1");
  assert.equal(r?.kernel, "6.17.2-1-pve");
  assert.deepEqual(r?.keptConfig, ["/etc/issue"]);
});

test("refused up front: guests running, sources not switched, someone else's account, a second upgrade", async () => {
  const busy = createNodeUpgrade(lab({ guests: [{ node: "n2", vmid: 101, name: "web", status: "running" }] }).deps);
  await assert.rejects(busy.start(root(), "n2", "n2"), /web is running on n2/);
  assert.equal(busy.running(), null);
  await assert.rejects(createNodeUpgrade(lab({ repos: ON_BOOKWORM }).deps).start(root(), "n2", "n2"), /aren't on trixie yet/);
  await assert.rejects(createNodeUpgrade(lab().deps).start({ ...root(), username: "admin@pve" }, "n2", "n2"), /root@pam/);
  await assert.rejects(createNodeUpgrade(lab().deps).start(root(), "n2", "n1"), /confirm/);
  const one = createNodeUpgrade(lab().deps);
  await one.start(root(), "n2", "n2");
  await assert.rejects(one.start(root(), "n1", "n1"), /already upgrading n2/);
  await finish(one, "n2");
});

test("a checker failure before the packages changes nothing, not even the way back to the old sources", async () => {
  const { deps, calls } = lab({ checkerBefore: CHECK_FAIL });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "failed");
  assert.match(r?.error ?? "", /Nothing was changed/);
  assert.equal(r?.packagesTouched, false, "the run may start its guests again: the node is as it was");
  assert.deepEqual(calls, ["checker"]);
});

test("the 9 checker's missing-microcode failure doesn't stop the restart (it's on every VM)", async () => {
  const { deps, calls } = lab({ checkerAfter: CHECK_AFTER_VM });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(calls, ["checker", "upgrade", "forget", "checker-after", "pin", "reboot"]);
  assert.equal(r?.after?.failures, 1);
  assert.deepEqual(r?.after?.blocking, []);
});

test("never restarts after a step that didn't finish", async () => {
  const cases: [Parameters<typeof lab>[0], RegExp][] = [
    [{ checkerAfter: CHECK_AFTER_UNKNOWN }, /found 1 problem \(something new went wrong\).*wasn't restarted/],
    [{ checkerAfter: CHECK_FAIL }, /found 1 problem \(a failure BossMox couldn't read\)/],
    [{ pinOk: false }, /Pinning the port names didn't work/],
    [{ apt: ["pve-manager"] }, /1 package is still waiting/],
  ];
  for (const [over, why] of cases) {
    const { deps, calls } = lab(over);
    const job = createNodeUpgrade(deps);
    await job.start(root(), "n2", "n2");
    const r = await finish(job, "n2");
    assert.equal(r?.phase, "failed");
    assert.match(r?.error ?? "", why);
    assert.ok(!calls.includes("reboot"), calls.join(","));
  }
});

test("an apt error stops before the restart and says where the log is", async () => {
  const { deps, calls } = lab();
  deps.console = async (_n, _s, line) => {
    if (line.startsWith("pve8to9")) return out(CHECK_OK);
    calls.push("upgrade");
    return out(`BMXID ${idIn(line)}\nBMXUP exit 100\nBMXERR E: Sub-process /usr/bin/dpkg returned an error code (1)\n`);
  };
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "failed");
  assert.match(r?.error ?? "", /apt exit code 100.*dpkg returned an error.*\/root\/bossmox-upgrade\.log/);
  assert.ok(!calls.includes("reboot"));
});

test("a console that drops mid-upgrade is followed until the job on the node ends", async () => {
  const { deps } = lab();
  let follows = 0;
  let upgraded = false;
  let started: string | null = null;
  const get = deps.pve.get.bind(deps.pve);
  deps.pve.get = async <T>(path: string) => (path.endsWith("/version") ? ({ version: upgraded ? "9.1.1" : "8.4.21" } as T) : get<T>(path, "t"));
  deps.console = async (_n, _s, line) => {
    if (line.startsWith("pve8to9")) return out(CHECK_OK);
    // The first console is the upgrade: the job starts, then pveproxy restarts and takes the console.
    if (follows === 0 && idIn(line)) {
      follows++;
      started = idIn(line);
      throw new Error("The console on n2 closed before the install finished.");
    }
    follows++;
    if (follows < 4) return out(`BMXID ${started}\nBMXUP running\n`);
    upgraded = true;
    return out(`BMXID ${started}\nBMXUP exit 0\n`);
  };
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.equal(follows, 4);
});

test("back on the old kernel is a failure, not a success", async () => {
  const { deps } = lab({ kernelAfter: "6.8.12-43-pve" });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "failed");
  assert.match(r?.error ?? "", /old kernel/);
});

test("a node stuck after its packages is finished: no packages again, straight to the check, pins and restart", async () => {
  const { deps, calls } = lab({ stuck: true });
  const job = createNodeUpgrade(deps);
  const started = await job.start(root(), "n2", "n2");
  assert.equal(started.finishing, true);
  assert.equal(started.to, 9, "the version it reports is the one it's finishing, not the next");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(calls, ["follow", "checker-after", "pin", "reboot"], "it asks the node about BossMox's package job first");
  assert.equal(r?.restarted, true);
  assert.equal(r?.kernel, "6.17.2-1-pve");
});

test("runOne waits for the node's whole upgrade and hands back how it ended", async () => {
  const { deps } = lab();
  const r = await createNodeUpgrade(deps).runOne(root(), "n2");
  assert.equal(r.phase, "done", r.error ?? "");
  assert.equal(r.restarted, true);
  const failed = await createNodeUpgrade(lab({ checkerAfter: CHECK_AFTER_UNKNOWN }).deps).runOne(root(), "n2");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.restarted, false, "it stopped before the restart");
});

/** A cluster for the run's planner: names to version and whether it's stuck. */
function planPve(nodes: Record<string, { v: string; stuck?: boolean; online?: boolean }>, repos: RawRepositories = ON_BOOKWORM) {
  return {
    async get<T>(path: string): Promise<T> {
      const name = /^\/nodes\/([^/]+)\//.exec(path)?.[1] ?? "";
      const n = nodes[name];
      const r = (() => {
        if (path === "/cluster/resources?type=node") return Object.entries(nodes).map(([node, x]) => ({ node, status: x.online === false ? "offline" : "online" }));
        if (path.endsWith("/version")) return { version: n?.v };
        if (path.endsWith("/apt/versions")) return n?.stuck ? kernels("6.8.12-43-pve") : [{ Package: "proxmox-ve", RunningKernel: "6.8.12-43-pve" }];
        if (path.endsWith("/apt/repositories")) return repos;
        throw new Error(`unexpected ${path}`);
      })();
      return r as T;
    },
  };
}
const readyNow = (over: Partial<Readiness> = {}): Readiness => ({ checkedAt: 1_000_000, running: false, from: 8, to: 9, nodes: [], ready: true, blocking: 0, ...over });
const noSwitch = { switchNode: async () => assert.fail("no switch expected"), undo: async () => assert.fail("no undo expected"), view: () => ({}) };
const noRun = { runOne: async () => assert.fail("no upgrade expected") };

test("the run's plan: stuck nodes first, then oldest version, and only the nodes still to go", async () => {
  const plan = await createRunUpgrade({
    pve: planPve({ c: { v: "8.4.21" }, a: { v: "8.4.14" }, b: { v: "9.2.28", stuck: true }, d: { v: "9.2.28" } }),
    sources: noSwitch,
    nodes: noRun,
    ready: () => readyNow(),
    now: () => 1_000_000 + 60_000,
  }).plan(root());
  assert.deepEqual(
    plan.map((p) => [p.name, p.finishing]),
    [
      ["b", true],
      ["a", false],
      ["c", false],
    ],
    "d is done already",
  );
  assert.ok(plan.every((p) => p.to === 9));
});

test("the run's plan is refused without a fresh, clear readiness check, for anyone but root@pam, or with a node offline", async () => {
  const make = (ready: Readiness, nodes: Parameters<typeof planPve>[0] = { a: { v: "8.4.21" } }, at = 1_000_000 + 60_000) =>
    createRunUpgrade({ pve: planPve(nodes), sources: noSwitch, nodes: noRun, ready: () => ready, now: () => at });
  await assert.rejects(make(readyNow()).plan({ username: "admin@pve", ticket: "t" }), /root@pam/);
  await assert.rejects(make(readyNow({ checkedAt: null })).plan(root()), /Get ready to upgrade first/);
  await assert.rejects(make(readyNow(), undefined, 1_000_000 + READY_FOR_MS + 1).plan(root()), /from the last hour/);
  await assert.rejects(make(readyNow({ ready: false, blocking: 2 })).plan(root()), /found 2 things to fix first/);
  await assert.rejects(make(readyNow({ running: true })).plan(root()), /still running/);
  await assert.rejects(make(readyNow(), { a: { v: "8.4.21" }, b: { v: "8.4.21", online: false } }).plan(root()), /come back online first: b/);
});

test("one node in a run: sources switched first when they aren't, then the whole upgrade", async () => {
  const log: string[] = [];
  const done = { restarted: true, packagesTouched: true, error: null, keptConfig: ["/etc/issue"], version: "9.2.28", kernel: "7.0.14-29-pve" } as unknown as NodeUpgrade;
  const ru = (repos: RawRepositories, stuck = false, switchError: string | null = null) =>
    createRunUpgrade({
      pve: planPve({ a: { v: stuck ? "9.2.28" : "8.4.21", stuck } }, repos),
      sources: {
        view: () => ({}),
        undo: async () => assert.fail("no undo expected"),
        switchNode: async (_s, node, confirm, from, to) => {
          log.push(`switch ${node} ${confirm} ${from}->${to}`);
          return { backup: "/root/b.tar", switchedAt: 1, others: [], error: switchError };
        },
      },
      nodes: {
        runOne: async (_s, node) => {
          log.push(`upgrade ${node}`);
          return done;
        },
      },
      ready: () => readyNow(),
    });
  assert.deepEqual(await ru(ON_BOOKWORM).run(root(), "a"), { restarted: true, packagesTouched: true, error: null, keptConfig: ["/etc/issue"], version: "9.2.28", kernel: "7.0.14-29-pve" });
  assert.deepEqual(log.splice(0), ["switch a a bookworm->trixie", "upgrade a"]);
  await ru(ON_TRIXIE).run(root(), "a");
  assert.deepEqual(log.splice(0), ["upgrade a"], "already switched: not again");
  await ru(ON_TRIXIE, true).run(root(), "a");
  assert.deepEqual(log.splice(0), ["upgrade a"], "a stuck node is finished without touching its sources");
  const bad = await ru(ON_BOOKWORM, false, "apt couldn't use the new sources, so the old ones were put back.").run(root(), "a");
  assert.equal(bad.restarted, false);
  assert.equal(bad.packagesTouched, false, "a failed switch never touched the packages");
  assert.match(bad.error ?? "", /a's update sources weren't switched: apt couldn't/);
  assert.deepEqual(log.splice(0), ["switch a a bookworm->trixie"], "no upgrade after a failed switch");
});

test("finishing a node first waits for BossMox's package job still running there (review 2026-11-16)", async () => {
  const { deps, calls } = lab({ stuck: true, follow: ["BMXUP running\n", "BMXUP running\n", "BMXUP exit 0\nConfiguration file '/etc/issue'\n"] });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(calls, ["follow", "follow", "follow", "checker-after", "pin", "reboot"], "nothing was pinned or restarted while it ran");
  assert.deepEqual(r?.keptConfig, ["/etc/issue"]);
});

test("finishing never goes on over a package job that failed or packages left half in (review 2026-11-16)", async () => {
  const cases: [string[], RegExp][] = [
    [["BMXUP exit 100\nBMXERR E: dpkg was interrupted\n"], /apt exit code 100.*wasn't restarted/],
    [["BMXUP noexit\nBMXUP unfinished-packages\n"], /didn't finish installing.*dpkg --configure -a/],
  ];
  for (const [follow, why] of cases) {
    const { deps, calls } = lab({ stuck: true, follow });
    const job = createNodeUpgrade(deps);
    await job.start(root(), "n2", "n2");
    const r = await finish(job, "n2");
    assert.equal(r?.phase, "failed");
    assert.match(r?.error ?? "", why);
    assert.deepEqual(calls, ["follow"]);
  }
});

test("packages left half in after the upgrade's own job also stop the restart (review 2026-11-16)", async () => {
  const { deps, calls } = lab();
  deps.console = async (_n, _s, line) => {
    if (line.startsWith("pve8to9")) return out(CHECK_OK);
    calls.push("upgrade");
    return out(`BMXID ${idIn(line)}\nBMXUP exit 0\nBMXUP unfinished-packages\n`);
  };
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "failed");
  assert.match(r?.error ?? "", /didn't finish installing/);
  assert.equal(r?.packagesTouched, true, "part way between versions: the run must not start its guests here");
});

test("a guest that starts on the node during the upgrade stops it before the pins and the restart (review 2026-11-16)", async () => {
  const { deps, calls } = lab({ arrive: true });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "failed");
  assert.match(r?.error ?? "", /late is running on n2 now, so it wasn't restarted/);
  assert.ok(!calls.includes("pin") && !calls.includes("reboot"), calls.join(","));
});

test("a one-node upgrade waits for a run or moves; the cluster run's own call doesn't (review 2026-11-16)", async () => {
  const { deps } = lab();
  deps.busy = () => "A run is going.";
  await assert.rejects(createNodeUpgrade(deps).start(root(), "n2", "n2"), /A run is going/);
  const r = await createNodeUpgrade(deps).runOne(root(), "n2");
  assert.equal(r.phase, "done", r.error ?? "");
});

test("BossMox keeps the upgrading person's login fresh until the upgrade ends, and the sign-in must outlast it (review 2026-11-16)", async () => {
  const job = createNodeUpgrade(lab().deps);
  const s = root();
  await job.start(s, "n2", "n2");
  assert.equal(job.session(), s);
  await finish(job, "n2");
  assert.equal(job.session(), null);
  assert.ok(UPGRADE_NEEDS_MS >= 2 * 60 * 60 * 1000 + 20 * 60 * 1000, "the package limit and the restart's wait fit in it");
  await assert.rejects(createNodeUpgrade(lab().deps).start({ ...root(), expiresAt: Date.now() + 2 * 60 * 60 * 1000 }, "n2", "n2"), /Your sign-in ends/);
});

test("a run that switched a node's sources and then stopped before its packages puts them back (review 2026-11-16)", async () => {
  const log: string[] = [];
  const view: Record<string, { backup: string | null }> = {};
  const failed = (restarted: boolean) =>
    ({ restarted, error: "Proxmox's checker found 1 problem (x) on a. Nothing was changed; fix them first.", keptConfig: [], version: null, kernel: null }) as unknown as NodeUpgrade;
  const ru = (restarted: boolean) =>
    createRunUpgrade({
      pve: planPve({ a: { v: "8.4.21" } }, ON_BOOKWORM),
      sources: {
        switchNode: async (_s, node) => {
          log.push(`switch ${node}`);
          view[node] = { backup: "/root/bossmox-apt-before-trixie-20261116-120000.tar" };
          return { backup: view[node].backup, switchedAt: 1, others: [], error: null };
        },
        undo: async (_s, node) => {
          log.push(`undo ${node}`);
          view[node] = { backup: null };
          return { backup: null, switchedAt: null, others: [], error: null };
        },
        view: () => view as never,
      },
      nodes: { runOne: async () => failed(restarted) },
      ready: () => readyNow(),
    });
  const r = await ru(false).run(root(), "a");
  assert.match(r.error ?? "", /Nothing was changed; fix them first\. Its update sources were put back\./);
  assert.deepEqual(log.splice(0), ["switch a", "undo a"]);
  await ru(true).run(root(), "a");
  assert.deepEqual(log.splice(0), ["switch a"], "a node that restarted keeps its new sources");
});

test("the package job reports how far it is, from its own log, numbers only (ADR 0044)", () => {
  assert.match(FOLLOW_SCRIPT, /BMXPROG/);
  assert.doesNotMatch(UPGRADE_SCRIPT, /--wait/, "the job starts and the console returns; short checks follow it");
  assert.deepEqual(readProgress("BMXPROG 168 40 12\nBMXUP running\n"), { total: 168, done: 40, quietSeconds: 12 });
  assert.deepEqual(readProgress("BMXPROG 0 0 -3\n"), { total: 0, done: 0, quietSeconds: 0 }, "a clock a little off isn't negative");
  for (const bad of ["BMXPROG 1 2", "BMXPROG a b c", "BMXPROG 1 2 3 <script>", "xBMXPROG 1 2 3"]) assert.equal(readProgress(bad), null, bad);
  assert.deepEqual(readUpgrade("BMXPROG 10 4 2\nBMXUP running\n").progress, { total: 10, done: 4, quietSeconds: 2 });
});

test("while the packages install, the node's upgrade carries their progress, and drops it once they're in", async () => {
  const seen: unknown[] = [];
  const { deps } = lab({ follow: ["BMXPROG 168 40 3\nBMXUP running\n", "BMXPROG 168 168 1\nBMXUP exit 0\n"] });
  let job: ReturnType<typeof createNodeUpgrade> | null = null;
  deps.pause = async () => {
    const p = job?.view().n2?.progress;
    seen.push(p ? { ...p, at: 0 } : null);
  };
  deps.console = ((orig) => async (n: string, sess: never, line: string, t?: number) => {
    // The upgrade's first answer: started, still running.
    if (line !== followCommand() && !line.startsWith("pve8to9")) {
      await orig(n, sess, line, t);
      return out("BMXPROG 168 0 0\nBMXUP running\n");
    }
    return orig(n, sess, line, t);
  })(deps.console) as never;
  job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(seen.slice(0, 2), [
    { total: 168, done: 0, quietSeconds: 0, at: 0 },
    { total: 168, done: 40, quietSeconds: 3, at: 0 },
  ]);
  assert.equal(r?.progress, null, "gone once the packages are in");
});

test("the upgrade keeps a free-channel node on the free channel: the paid source the packages add is turned off (ADR 0044)", async () => {
  const before: RawRepositories = {
    files: [
      { path: "/etc/apt/sources.list.d/proxmox.sources", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-no-subscription"] }] },
    ],
    infos: [],
  };
  const after: RawRepositories = {
    files: [
      ...(before.files ?? []),
      {
        path: "/etc/apt/sources.list.d/pve-enterprise.sources",
        repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-enterprise"] }],
      },
    ],
    infos: [],
  };
  const { deps, calls } = lab({ repos: before, reposAfter: after, sub: { status: "notfound" } });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(r?.freeChannel, { planned: true, why: "", turnedOff: ["/etc/apt/sources.list.d/pve-enterprise.sources"], note: null });
  assert.ok(calls.indexOf("off /etc/apt/sources.list.d/pve-enterprise.sources") < calls.indexOf("reboot"), "before the restart");

  const subscribed = lab({ repos: before, reposAfter: after, sub: { status: "Active" } });
  const j2 = createNodeUpgrade(subscribed.deps);
  await j2.start(root(), "n2", "n2");
  const r2 = await finish(j2, "n2");
  assert.equal(r2?.phase, "done");
  assert.equal(r2?.freeChannel?.planned, false);
  assert.ok(!subscribed.calls.some((c) => c.startsWith("off ")), "a subscribed node's sources are left as Proxmox sets them");
});

test("an upgrade whose job never started is a failure before the packages: nothing touched, sources not given up (review 0.3.2)", async () => {
  for (const [why, answer] of [
    ["the console never reached the node", "BMXUP noexit\n"],
    ["an older upgrade's exit file is still there", "BMXID 0123456789abcdef\nBMXUP exit 0\n"],
  ] as const) {
    const { deps, calls } = lab();
    deps.console = async (_n, _s, line) => {
      if (line.startsWith("pve8to9")) return out(CHECK_OK);
      if (line === followCommand()) {
        calls.push("follow");
        return out(answer);
      }
      calls.push("upgrade");
      throw new Error("The console on n2 didn't open.");
    };
    const job = createNodeUpgrade(deps);
    await job.start(root(), "n2", "n2");
    const r = await finish(job, "n2");
    assert.equal(r?.phase, "failed", why);
    assert.match(r?.error ?? "", /didn't start, so nothing was installed/, why);
    assert.equal(r?.packagesTouched, false, `${why}: the run may start its guests again`);
    assert.ok(!calls.includes("forget"), `${why}: the old sources can still go back`);
    assert.ok(!calls.includes("reboot"), why);
  }
});

test("the upgrade id reaches the node line only as 16 hex characters", () => {
  assert.throws(() => upgradeScript("0; reboot"), /isn't valid/);
  assert.throws(() => upgradeScript("ABCDEF0123456789"), /isn't valid/);
  assert.match(upgradeScript("0123456789abcdef"), /^echo 0123456789abcdef >\/root\/bossmox-upgrade\.id$/m);
});
