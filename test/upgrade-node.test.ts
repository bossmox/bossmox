import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import type { RawRepositories } from "../src/server-detail.js";
import type { ShellResult } from "../src/node-shell.js";
import { createNodeUpgrade, FOLLOW_SCRIPT, onRelease, readUpgrade, UPGRADE_SCRIPT, upgradeCommand, type NodeUpgradeDeps } from "../src/upgrade-node.js";

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
  assert.doesNotMatch(upgradeCommand(), /BMXUP/);
  assert.equal(Buffer.from(/'([A-Za-z0-9+/=]+)'/.exec(upgradeCommand())?.[1] ?? "", "base64").toString(), UPGRADE_SCRIPT);
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

/** A fake cluster: node2 on 8.4 with its sources switched and nothing running, which turns 9 after the packages. */
/** The real 9 checker on a VM after the packages: 1 failure, the missing microcode package. */
const CHECK_AFTER_VM = readFileSync(new URL("../../test/pve8to9-9.2-after-packages.txt", import.meta.url), "utf8");
const CHECK_AFTER_UNKNOWN = "FAIL: something new went wrong\n\n= SUMMARY =\n\nTOTAL:    40\nPASSED:   39\nSKIPPED:  0\nWARNINGS: 0\nFAILURES: 1\n";

function lab(over: { guests?: unknown[]; repos?: RawRepositories; apt?: string[]; pinOk?: boolean; kernelAfter?: string; checkerBefore?: string; checkerAfter?: string } = {}) {
  const calls: string[] = [];
  let upgraded = false;
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
          if (path === "/cluster/resources?type=vm") return over.guests ?? [{ node: "n1", vmid: 100, name: "bossmox", status: "running" }];
          if (path.endsWith("/apt/repositories")) return over.repos ?? ON_TRIXIE;
          if (path.endsWith("/apt/update")) return over.apt ?? [];
          throw new Error(`unexpected ${path}`);
        })();
        return r as T;
      },
      async post<T>(): Promise<T> {
        return null as T;
      },
    },
    console: async (_node, _s, line) => {
      if (line.startsWith("pve8to9")) {
        calls.push(upgraded ? "checker-after" : "checker");
        return out(upgraded ? (over.checkerAfter ?? CHECK_OK) : (over.checkerBefore ?? CHECK_OK));
      }
      calls.push("upgrade");
      upgraded = true;
      return out("BMXUP exit 0\nConfiguration file '/etc/issue'\n");
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
  assert.deepEqual(calls, ["checker", "forget", "upgrade", "checker-after", "pin", "reboot"]);
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
  assert.deepEqual(calls, ["checker"]);
});

test("the 9 checker's missing-microcode failure doesn't stop the restart (it's on every VM)", async () => {
  const { deps, calls } = lab({ checkerAfter: CHECK_AFTER_VM });
  const job = createNodeUpgrade(deps);
  await job.start(root(), "n2", "n2");
  const r = await finish(job, "n2");
  assert.equal(r?.phase, "done", r?.error ?? "");
  assert.deepEqual(calls, ["checker", "forget", "upgrade", "checker-after", "pin", "reboot"]);
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
    return out("BMXUP exit 100\nBMXERR E: Sub-process /usr/bin/dpkg returned an error code (1)\n");
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
  const get = deps.pve.get.bind(deps.pve);
  deps.pve.get = async <T>(path: string) => (path.endsWith("/version") ? ({ version: upgraded ? "9.1.1" : "8.4.21" } as T) : get<T>(path, "t"));
  deps.console = async (_n, _s, line) => {
    if (line.startsWith("pve8to9")) return out(CHECK_OK);
    // The first console is the upgrade: pveproxy restarts and takes it.
    if (follows === 0 && line === upgradeCommand()) {
      follows++;
      throw new Error("The console on n2 closed before the install finished.");
    }
    follows++;
    if (follows < 4) return out("BMXUP running\n");
    upgraded = true;
    return out("BMXUP exit 0\n");
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
