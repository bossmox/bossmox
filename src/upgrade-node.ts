/**
 * Upgrading one node to the next Proxmox VE major version (ADR 0042, piece 5), once its sources are switched (piece 4)
 * and nothing runs on it. In order: Proxmox's checker, the package upgrade as its own job on the node, the checker
 * again, port names pinned, a restart, and a check that it came back on the new version with a new kernel. Anything
 * that goes wrong stops it there and says where; the node is never restarted after a step that didn't finish.
 */
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import { RELEASES } from "./lifecycle.js";
import type { RawResource } from "./model.js";
import { keptConfigFiles, type ShellResult } from "./node-shell.js";
import { releaseMismatch } from "./release-guard.js";
import type { RawRepositories, RawStatus } from "./server-detail.js";
import { blockers, parseChecker } from "./upgrade-check.js";
import type { PinResult } from "./upgrade-fixes.js";
import type { UpgradeResult } from "./run.js";
import { ROOT_MIN_GB, unfinishedUpgrade, type RawVersion, type Readiness } from "./upgrade-ready.js";
import { PROXMOX_URI, switched, type UpgradeSources } from "./upgrade-sources.js";

export const UPGRADE_LOG = "/root/bossmox-upgrade.log";
const EXIT_FILE = "/root/bossmox-upgrade.exit";
const UNIT = "bossmox-upgrade";
/** A whole major upgrade, from the first package to the last, on a slow mirror. */
export const UPGRADE_LIMIT_MS = 2 * 60 * 60 * 1000;
/** The sign-in has to outlast the upgrade, since every step uses it. */
export const UPGRADE_NEEDS_MS = 90 * 60 * 1000;

/** Failures alone don't stop it: only what the explainer says blocks (ADR 0042; the 9 checker fails on no microcode). */
export interface CheckerCounts {
  warnings: number;
  failures: number;
  blocking: string[];
}
const listed = (b: string[]) => `${b.length} ${b.length === 1 ? "problem" : "problems"} (${b.join("; ")})`;

const asCommand = (script: string) => `printf '%s' '${Buffer.from(script, "utf8").toString("base64")}' | base64 -d | bash`;

/**
 * Where the upgrade is, read on the node: running, or ended with apt's exit code, plus the config files dpkg kept and
 * apt's errors. Its own command, so BossMox can ask again after the console drops (apt restarts pveproxy, which carries
 * the console) or after BossMox itself restarts.
 */
export const FOLLOW_SCRIPT = `if systemctl is-active --quiet ${UNIT}; then echo "BMXUP running"; exit 0; fi
if [ -f ${EXIT_FILE} ]; then echo "BMXUP exit $(cat ${EXIT_FILE})"; else echo "BMXUP noexit"; fi
grep -o "Configuration file '[^']*'" ${UPGRADE_LOG} 2>/dev/null | sort -u
grep -E "^(E: |dpkg: error|Errors were encountered)" ${UPGRADE_LOG} 2>/dev/null | tail -n 10 | sed 's/^/BMXERR /'
`;

/**
 * The upgrade, as its own systemd job so a closed console can't stop it part way (as ADR 0027 does for updates). Nobody
 * answers questions: dpkg installs the new version of a config file nobody changed and keeps one that was changed,
 * with the new one beside it (Rocky's decision, ADR 0042); ucf-managed files (GRUB's defaults) do the same, and
 * apt-listchanges doesn't page. Everything apt prints goes to a log on the node. One already running isn't started
 * again: BossMox follows it instead. apt waits up to 10 minutes for the package lock instead of giving up at once:
 * Debian's unattended-upgrades held it on the lab just after a node started (2026-11-16).
 */
export const APT_LOCK_WAIT = "-o DPkg::Lock::Timeout=600";
export const UPGRADE_SCRIPT = `if ! systemctl is-active --quiet ${UNIT}; then
rm -f ${EXIT_FILE}
systemd-run --quiet --wait --collect --unit=${UNIT} --setenv=DEBIAN_FRONTEND=noninteractive --setenv=UCF_FORCE_CONFFOLD=1 --setenv=APT_LISTCHANGES_FRONTEND=none /bin/bash -c 'exec >${UPGRADE_LOG} 2>&1; apt-get ${APT_LOCK_WAIT} update -q || { echo 100 >${EXIT_FILE}; exit 100; }; apt-get ${APT_LOCK_WAIT} -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade; c=$?; echo $c >${EXIT_FILE}; exit $c'
fi
${FOLLOW_SCRIPT}`;

export const upgradeCommand = () => asCommand(UPGRADE_SCRIPT);
export const followCommand = () => asCommand(FOLLOW_SCRIPT);

export interface UpgradeRead {
  state: "running" | "ended" | "unknown";
  /** apt's exit code; null when the job ended without writing one (killed). */
  exitCode: number | null;
  keptConfig: string[];
  errors: string[];
}
export function readUpgrade(output: string): UpgradeRead {
  const keptConfig = keptConfigFiles(output);
  const errors = [...output.matchAll(/^BMXERR (.*)$/gm)].map((m) => (m[1] as string).trim());
  if (/^BMXUP running\s*$/m.test(output)) return { state: "running", exitCode: null, keptConfig, errors };
  const code = /^BMXUP exit (\d+)\s*$/m.exec(output);
  if (code) return { state: "ended", exitCode: Number(code[1]), keptConfig, errors };
  if (/^BMXUP noexit\s*$/m.test(output)) return { state: "ended", exitCode: null, keptConfig, errors };
  return { state: "unknown", exitCode: null, keptConfig, errors };
}

/** Proxmox's own source is on, and on the new release. Pure, for tests. */
export function onRelease(repos: RawRepositories, codename: string): boolean {
  return (repos.files ?? []).some((f) =>
    (f.repositories ?? []).some((r) => (r.Enabled === true || r.Enabled === 1) && (r.URIs ?? []).some((u) => PROXMOX_URI.exec(u)?.[2] === "pve") && (r.Suites ?? []).includes(codename)),
  );
}

export type UpPhase = "checking" | "upgrading" | "rechecking" | "pinning" | "restarting" | "verifying" | "done" | "failed";
export interface NodeUpgrade {
  node: string;
  from: string;
  to: number;
  /** Finishing an upgrade whose packages went in earlier: no packages, straight to the check, pins and restart. */
  finishing: boolean;
  phase: UpPhase;
  startedAt: number;
  finishedAt: number | null;
  /** Where it stopped and why. */
  error: string | null;
  /** The checker's counts, before and after the packages, and what in them stops the upgrade. */
  before: CheckerCounts | null;
  after: CheckerCounts | null;
  keptConfig: string[];
  pins: PinResult | null;
  kernelBefore: string | null;
  /** The restart was asked for. A failure before it leaves the node running as it was. */
  restarted: boolean;
  /** What it runs once it's back. */
  version: string | null;
  kernel: string | null;
}

export interface NodeUpgradeDeps {
  pve: {
    get<T>(path: string, ticket: string): Promise<T>;
    post<T>(path: string, who: Session, form?: Record<string, string>): Promise<T>;
  };
  console: (node: string, session: Session, line: string, timeoutMs?: number) => Promise<ShellResult>;
  pin: (session: Session, node: string) => Promise<PinResult>;
  reboot: (session: Session, node: string) => Promise<void>;
  sources: { busy(): boolean; forget(node: string): void };
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}

const GB = 1024 ** 3;

export function createNodeUpgrade(deps: NodeUpgradeDeps) {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: Record<string, NodeUpgrade> = {};
  let running: string | null = null;
  const enc = encodeURIComponent;

  /** Proxmox's API restarts during the upgrade and after the reboot, so a read gets a few tries. */
  async function settled<T>(read: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await read();
      } catch (err) {
        if (i >= 8) throw err;
        await pause(10_000);
      }
    }
  }

  async function checker(session: Session, node: string, major: number): Promise<CheckerCounts> {
    const r = await deps.console(node, session, `pve${major}to${major + 1} --full`);
    const run = parseChecker(r.output);
    const s = run.summary;
    if (!s) throw new Error(`Proxmox's checker didn't finish on ${node} (exit code ${r.exitCode}).`);
    return { warnings: s.warnings, failures: s.failures, blocking: blockers(run) };
  }

  /** Runs the upgrade, then follows it until it ends, through a dropped console or a restart of Proxmox's API. */
  async function upgrade(session: Session, node: string): Promise<UpgradeRead> {
    const until = now() + UPGRADE_LIMIT_MS;
    let read: UpgradeRead | null = null;
    try {
      read = readUpgrade((await deps.console(node, session, upgradeCommand(), UPGRADE_LIMIT_MS)).output);
    } catch {
      // The console went (pveproxy restarts mid-upgrade). The job carries on; ask it below.
    }
    while (read?.state !== "ended") {
      if (now() > until) throw new Error(`The upgrade on ${node} hasn't finished after ${UPGRADE_LIMIT_MS / 3600000} hours. It carries on there by itself; its log is ${UPGRADE_LOG}.`);
      await pause(30_000);
      read = await deps.console(node, session, followCommand()).then(
        (r) => readUpgrade(r.output),
        () => null,
      );
    }
    return read as UpgradeRead;
  }

  async function drive(session: Session, job: NodeUpgrade, major: number) {
    const node = job.node;
    const t = () => session.ticket;
    const phase = (p: UpPhase) => {
      job.phase = p;
    };
    try {
      if (!job.finishing) {
        job.before = await checker(session, node, major);
        if (job.before.blocking.length) throw new Error(`Proxmox's checker found ${listed(job.before.blocking)} on ${node}. Nothing was changed; fix them first.`);

        phase("upgrading");
        // From here the old sources must never go back.
        deps.sources.forget(node);
        deps.audit("upgrade-node-start", session.username, { node, to: job.to });
        const r = await upgrade(session, node);
        job.keptConfig = r.keptConfig;
        if (r.exitCode !== 0)
          throw new Error(
            `The package upgrade on ${node} ended with an error (${r.exitCode === null ? "it was stopped" : `apt exit code ${r.exitCode}`}), so it wasn't restarted.${r.errors.length ? ` apt said: ${r.errors.join(" ")}` : ""} The whole log is ${UPGRADE_LOG} on ${node}.`,
          );
      } else {
        deps.audit("upgrade-node-finish", session.username, { node, to: job.to });
      }

      phase("rechecking");
      const v = await settled(() => deps.pve.get<{ version?: string }>(`/nodes/${enc(node)}/version`, t()));
      job.version = v.version ?? null;
      if (Number.parseInt(v.version ?? "", 10) !== job.to)
        throw new Error(`After the packages, ${node} reports Proxmox VE ${v.version ?? "unknown"}, not ${job.to}, so it wasn't restarted. The log is ${UPGRADE_LOG}.`);
      const left = await settled(() => deps.pve.get<unknown[]>(`/nodes/${enc(node)}/apt/update`, t()));
      if (left.length) throw new Error(`${left.length} ${left.length === 1 ? "package is" : "packages are"} still waiting on ${node} after the upgrade, so it wasn't restarted.`);
      job.after = await checker(session, node, major);
      if (job.after.blocking.length) throw new Error(`After the packages, Proxmox's checker found ${listed(job.after.blocking)} on ${node}, so it wasn't restarted.`);

      phase("pinning");
      job.pins = await deps.pin(session, node);
      if (!job.pins.ok) throw new Error(`Pinning the port names didn't work, so ${node} wasn't restarted: ${job.pins.error}`);

      phase("restarting");
      job.restarted = true;
      await deps.reboot(session, node);

      phase("verifying");
      const [after, status, repos] = await Promise.all([
        settled(() => deps.pve.get<{ version?: string }>(`/nodes/${enc(node)}/version`, t())),
        settled(() => deps.pve.get<RawStatus>(`/nodes/${enc(node)}/status`, t())),
        settled(() => deps.pve.get<RawRepositories>(`/nodes/${enc(node)}/apt/repositories`, t())),
      ]);
      job.version = after.version ?? null;
      job.kernel = status["current-kernel"]?.release ?? null;
      if (Number.parseInt(after.version ?? "", 10) !== job.to) throw new Error(`${node} came back on Proxmox VE ${after.version ?? "unknown"}, not ${job.to}.`);
      // Same kernel as before: the boot loader didn't take the new one (UEFI with LVM, Proxmox's known issue).
      if (!job.kernel || job.kernel === job.kernelBefore)
        throw new Error(`${node} came back on its old kernel (${job.kernel ?? "unknown"}). The boot loader may not have the new one; see Proxmox's notes on GRUB with UEFI.`);
      const mismatch = releaseMismatch(node, repos);
      if (mismatch) throw new Error(mismatch);
      phase("done");
      deps.audit("upgrade-node-done", session.username, { node, to: job.to, ok: 1 });
    } catch (err) {
      job.error = (err as Error).message || "BossMox lost contact with Proxmox.";
      job.phase = "failed";
      deps.audit("upgrade-node-done", session.username, { node, to: job.to, ok: 0 });
    } finally {
      job.finishedAt = now();
      running = null;
    }
  }

  const api = {
    view: () => state,
    running: () => running,

    /** Checks everything that can be checked up front, then upgrades in the background. The page follows view(). */
    async start(session: Session, node: string, confirm: string): Promise<NodeUpgrade> {
      if (session.username !== "root@pam") throw new HttpError(403, "The upgrade runs in the node's root console. Sign in as root@pam.");
      if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
      if (running) throw new HttpError(409, `BossMox is already upgrading ${running}. One node at a time.`);
      if (deps.sources.busy()) throw new HttpError(409, "BossMox is changing a node's update sources. Wait for that to finish.");
      const left = session.expiresAt - now();
      if (left < UPGRADE_NEEDS_MS)
        throw new HttpError(400, `Your sign-in ends in ${Math.max(1, Math.round(left / 60000))} minutes, and the upgrade needs it until the end. Sign out and in again first.`);
      running = node;
      try {
        const t = session.ticket;
        const base = `/nodes/${enc(node)}`;
        const [version, status, cluster, nodes, guests, repos, versions] = await Promise.all([
          deps.pve.get<{ version?: string }>(`${base}/version`, t),
          deps.pve.get<RawStatus & { rootfs?: { avail?: number; total?: number; used?: number } }>(`${base}/status`, t),
          deps.pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t),
          deps.pve.get<RawResource[]>("/cluster/resources?type=node", t),
          deps.pve.get<RawResource[]>("/cluster/resources?type=vm", t),
          deps.pve.get<RawRepositories>(`${base}/apt/repositories`, t),
          deps.pve.get<RawVersion[]>(`${base}/apt/versions`, t).catch((): RawVersion[] => []),
        ]);
        // Packages already on the new version but the old kernel still running: finish that upgrade, don't start another.
        const finishing = unfinishedUpgrade(versions) !== null;
        const reported = Number.parseInt(version.version ?? "", 10);
        const major = finishing ? reported - 1 : reported;
        const from = RELEASES.find((r) => r.major === major)?.codename;
        const to = RELEASES.find((r) => r.major === major + 1)?.codename;
        if (!from || !to) throw new HttpError(400, `BossMox doesn't know which release comes after Proxmox VE ${version.version ?? "this version"}.`);
        const c = cluster.find((x) => x.type === "cluster");
        if (c && c.quorate !== 1) throw new HttpError(400, "The cluster has lost its majority. Upgrade once every node is back.");
        const off = nodes.filter((n) => n.status !== "online").map((n) => n.node);
        if (off.length) throw new HttpError(400, `Wait for these to come back online first: ${off.join(", ")}.`);
        const on = guests.filter((g) => g.node === node && g.template !== 1 && (g.status === "running" || g.status === "paused"));
        if (on.length)
          throw new HttpError(400, `${on.map((g) => g.name ?? `${g.vmid}`).join(", ")} ${on.length === 1 ? "is" : "are"} running on ${node}. Move them to another node or shut them down first.`);
        if (switched(repos, from).length || !onRelease(repos, to)) throw new HttpError(400, `${node}'s update sources aren't on ${to} yet. Switch them to the new release first.`);
        // Nothing new goes on root when finishing, so its free space doesn't matter then.
        const fs = status.rootfs;
        const free = fs ? (fs.avail ?? (fs.total ?? 0) - (fs.used ?? 0)) / GB : null;
        if (!finishing && free !== null && free < ROOT_MIN_GB) throw new HttpError(400, `Only ${free.toFixed(1)} GB free on ${node}'s root. The upgrade needs at least ${ROOT_MIN_GB} GB.`);
        const job: NodeUpgrade = {
          node,
          from: version.version ?? "",
          to: major + 1,
          finishing,
          phase: finishing ? "rechecking" : "checking",
          startedAt: now(),
          finishedAt: null,
          error: null,
          before: null,
          after: null,
          keptConfig: [],
          pins: null,
          kernelBefore: status["current-kernel"]?.release ?? null,
          restarted: false,
          version: null,
          kernel: null,
        };
        state[node] = job;
        void drive(session, job, major);
        return job;
      } catch (err) {
        running = null;
        throw err;
      }
    },

    /**
     * One node, start to finish, for the cluster run (piece 6): the run's own confirmation covers it. Resolves with
     * the job once it has ended, done or failed; rejects only when it was refused up front.
     */
    async runOne(session: Session, node: string): Promise<NodeUpgrade> {
      const job = await api.start(session, node, node);
      while (job.finishedAt === null) await pause(5_000);
      return job;
    },
  };
  return api;
}
export type NodeUpgradeJob = ReturnType<typeof createNodeUpgrade>;

/** How old the readiness check may be when a cluster upgrade starts. */
export const READY_FOR_MS = 60 * 60 * 1000;

export interface PlannedUpgrade {
  name: string;
  version: string;
  to: number;
  finishing: boolean;
}

export interface RunUpgradeDeps {
  pve: { get<T>(path: string, ticket: string): Promise<T> };
  sources: Pick<UpgradeSources, "switchNode">;
  nodes: Pick<NodeUpgradeJob, "runOne">;
  ready: () => Readiness;
  now?: () => number;
}

/**
 * The cluster upgrade's part of a run (ADR 0042, piece 6): which nodes go, in what order, and one node's whole
 * upgrade, sources switch included. The run itself (run.ts) moves the guests and brings them home.
 */
export function createRunUpgrade(deps: RunUpgradeDeps) {
  const now = deps.now ?? Date.now;
  const enc = encodeURIComponent;
  const read = async (ticket: string, node: string) => {
    const [v, versions] = await Promise.all([deps.pve.get<{ version?: string }>(`/nodes/${enc(node)}/version`, ticket), deps.pve.get<RawVersion[]>(`/nodes/${enc(node)}/apt/versions`, ticket)]);
    const reported = Number.parseInt(v.version ?? "", 10);
    const finishing = unfinishedUpgrade(versions) !== null;
    return { version: v.version ?? "", reported, finishing, major: finishing ? reported - 1 : reported };
  };

  return {
    /**
     * Every node still to go, the unfinished ones first (each is stuck half way), then oldest version first. Refused
     * unless the readiness check ran in the last hour and found nothing that blocks.
     */
    async plan(session: { username: string; ticket: string }): Promise<PlannedUpgrade[]> {
      if (session.username !== "root@pam") throw new HttpError(403, "The upgrade runs in each node's root console. Sign in as root@pam.");
      const r = deps.ready();
      if (r.running) throw new HttpError(409, "The readiness check is still running. Wait for it to finish.");
      if (!r.checkedAt || now() - r.checkedAt > READY_FOR_MS) throw new HttpError(400, "Run Get ready to upgrade first: its check has to be from the last hour.");
      if (!r.ready) throw new HttpError(400, `The readiness check found ${r.blocking} ${r.blocking === 1 ? "thing" : "things"} to fix first.`);
      const nodes = await deps.pve.get<RawResource[]>("/cluster/resources?type=node", session.ticket);
      const off = nodes.filter((n) => n.status !== "online").map((n) => n.node);
      if (off.length) throw new HttpError(400, `Wait for these to come back online first: ${off.join(", ")}.`);
      const all = await Promise.all(nodes.map(async (n) => ({ name: n.node ?? "", ...(await read(session.ticket, n.node ?? "")) })));
      if (all.some((n) => !Number.isInteger(n.major))) throw new HttpError(400, "BossMox couldn't read every node's Proxmox version.");
      const oldest = Math.min(...all.map((n) => n.major));
      if (!RELEASES.some((x) => x.major === oldest + 1)) throw new HttpError(400, `BossMox doesn't know which release comes after Proxmox VE ${oldest}.`);
      return all
        .filter((n) => n.major === oldest)
        .sort((a, b) => Number(b.finishing) - Number(a.finishing) || a.version.localeCompare(b.version, undefined, { numeric: true }) || a.name.localeCompare(b.name))
        .map((n) => ({ name: n.name, version: n.version, to: oldest + 1, finishing: n.finishing }));
    },

    /** One node: its sources switched if they aren't yet, then the one-node upgrade to its end. Never throws. */
    async run(session: Session, node: string): Promise<UpgradeResult> {
      const fail = (error: string): UpgradeResult => ({ restarted: false, error, keptConfig: [], version: null, kernel: null });
      try {
        const n = await read(session.ticket, node);
        if (!n.finishing) {
          const from = RELEASES.find((x) => x.major === n.major)?.codename;
          const to = RELEASES.find((x) => x.major === n.major + 1)?.codename;
          if (!from || !to) return fail(`BossMox doesn't know which release comes after Proxmox VE ${n.version}.`);
          const repos = await deps.pve.get<RawRepositories>(`/nodes/${enc(node)}/apt/repositories`, session.ticket);
          if (switched(repos, from).length || !onRelease(repos, to)) {
            const s = await deps.sources.switchNode(session, node, node, from, to);
            if (s.error) return fail(`${node}'s update sources weren't switched: ${s.error}`);
          }
        }
        const job = await deps.nodes.runOne(session, node);
        return { restarted: job.restarted, error: job.error, keptConfig: job.keptConfig, version: job.version, kernel: job.kernel };
      } catch (err) {
        return fail((err as Error).message || "BossMox lost contact with Proxmox.");
      }
    },
  };
}
export type RunUpgrade = ReturnType<typeof createRunUpgrade>;
