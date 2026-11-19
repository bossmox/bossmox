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
import { paidAdded, paidOn, planFreeChannel, type FreeChannelPlan } from "./keep-free-channel.js";
import type { RawSubscription } from "./server-detail.js";
import { ROOT_MIN_GB, unfinishedUpgrade, type RawVersion, type Readiness } from "./upgrade-ready.js";
import { PROXMOX_URI, switched, type UpgradeSources } from "./upgrade-sources.js";

export const UPGRADE_LOG = "/root/bossmox-upgrade.log";
const EXIT_FILE = "/root/bossmox-upgrade.exit";
const UNIT = "bossmox-upgrade";
/** A whole major upgrade, from the first package to the last, on a slow mirror. */
export const UPGRADE_LIMIT_MS = 2 * 60 * 60 * 1000;
/**
 * The sign-in has to outlast the upgrade, since every step uses it: the packages' longest wait, the restart's, and
 * time for the checks around them. BossMox keeps the Proxmox login fresh while the upgrade runs, browser open or not.
 */
export const UPGRADE_NEEDS_MS = 3 * 60 * 60 * 1000;
/** How often the package job is checked: each check is one short console line (ADR 0044: progress, no faster than 5 s). */
export const FOLLOW_EVERY_MS = 15_000;

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
export const FOLLOW_SCRIPT = `if [ -f ${UPGRADE_LOG} ]; then
t=$(grep -oE "^[0-9]+ upgraded, [0-9]+ newly installed" ${UPGRADE_LOG} | head -n 1 | awk '{print $1 + $3}')
d=$(grep -c "^Setting up " ${UPGRADE_LOG})
q=$(( $(date +%s) - $(stat -c %Y ${UPGRADE_LOG}) ))
echo "BMXPROG \${t:-0} \${d:-0} \${q:-0}"
fi
if systemctl is-active --quiet ${UNIT}; then echo "BMXUP running"; exit 0; fi
if [ -f ${EXIT_FILE} ]; then echo "BMXUP exit $(cat ${EXIT_FILE})"; else echo "BMXUP noexit"; fi
grep -o "Configuration file '[^']*'" ${UPGRADE_LOG} 2>/dev/null | sort -u
grep -E "^(E: |dpkg: error|Errors were encountered)" ${UPGRADE_LOG} 2>/dev/null | tail -n 10 | sed 's/^/BMXERR /'
[ -n "$(dpkg --audit 2>/dev/null)" ] && echo "BMXUP unfinished-packages"
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
systemd-run --quiet --collect --unit=${UNIT} --setenv=DEBIAN_FRONTEND=noninteractive --setenv=UCF_FORCE_CONFFOLD=1 --setenv=APT_LISTCHANGES_FRONTEND=none /bin/bash -c 'exec >${UPGRADE_LOG} 2>&1; apt-get ${APT_LOCK_WAIT} update -q || { echo 100 >${EXIT_FILE}; exit 100; }; apt-get ${APT_LOCK_WAIT} -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade; c=$?; echo $c >${EXIT_FILE}; exit $c'
fi
${FOLLOW_SCRIPT}`;

export const upgradeCommand = () => asCommand(UPGRADE_SCRIPT);
export const followCommand = () => asCommand(FOLLOW_SCRIPT);

/**
 * How far the packages are, read from the job's own log (ADR 0044): how many apt said it would install, how many it
 * has set up, and how many seconds since the log last changed. Numbers only; the log's lines are never shown.
 */
export interface UpgradeProgress {
  total: number;
  done: number;
  quietSeconds: number;
}
export function readProgress(output: string): UpgradeProgress | null {
  const m = /^BMXPROG (\d{1,6}) (\d{1,6}) (-?\d{1,9})\s*$/m.exec(output);
  return m ? { total: Number(m[1]), done: Number(m[2]), quietSeconds: Math.max(0, Number(m[3])) } : null;
}

export interface UpgradeRead {
  /** dpkg has packages it didn't finish installing: the node must not restart like that. */
  unfinished?: boolean;
  progress?: UpgradeProgress | null;
  state: "running" | "ended" | "unknown";
  /** apt's exit code; null when the job ended without writing one (killed). */
  exitCode: number | null;
  keptConfig: string[];
  errors: string[];
}
export function readUpgrade(output: string): UpgradeRead {
  const progress = readProgress(output);
  return progress ? { ...readState(output), progress } : readState(output);
}
function readState(output: string): UpgradeRead {
  const keptConfig = keptConfigFiles(output);
  const errors = [...output.matchAll(/^BMXERR (.*)$/gm)].map((m) => (m[1] as string).trim());
  if (/^BMXUP unfinished-packages\s*$/m.test(output)) {
    const code = /^BMXUP exit (\d+)\s*$/m.exec(output);
    return { state: "ended", exitCode: code ? Number(code[1]) : null, keptConfig, errors, unfinished: true };
  }
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
  /** The new version's packages began installing, or the node was being finished: it isn't as it was. */
  packagesTouched: boolean;
  /** What it runs once it's back. */
  version: string | null;
  kernel: string | null;
  /** While the packages install: how far, and when that was read (ADR 0044). */
  progress?: (UpgradeProgress & { at: number }) | null;
  /** The free channel kept through the upgrade (ADR 0044): planned before the packages, done right after them. */
  freeChannel?: { planned: boolean; why: string; turnedOff: string[]; note: string | null } | null;
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
  /** Another job that moves guests or restarts nodes (a run, a move), if one is going. The cluster run's own call skips it. */
  busy?: () => string | null;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}

const GB = 1024 ** 3;

export function createNodeUpgrade(deps: NodeUpgradeDeps) {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: Record<string, NodeUpgrade> = {};
  let running: string | null = null;
  let runningSession: Session | null = null;
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

  /**
   * Starts the upgrade as its own job and returns, then follows it with a short check until it ends, through a dropped
   * console or a restart of Proxmox's API. Each check also reads how far the packages are (ADR 0044).
   */
  async function upgrade(session: Session, node: string, seen?: (read: UpgradeRead) => void): Promise<UpgradeRead> {
    let read: UpgradeRead | null = null;
    try {
      read = readUpgrade((await deps.console(node, session, upgradeCommand())).output);
    } catch {
      // The console went (pveproxy restarts mid-upgrade). The job carries on; ask it below.
    }
    if (read) seen?.(read);
    return untilEnded(session, node, read, seen);
  }
  const ask = (session: Session, node: string) =>
    deps.console(node, session, followCommand()).then(
      (r) => readUpgrade(r.output),
      () => null,
    );
  async function untilEnded(session: Session, node: string, first: UpgradeRead | null, seen?: (read: UpgradeRead) => void): Promise<UpgradeRead> {
    const until = now() + UPGRADE_LIMIT_MS;
    let read = first;
    while (read?.state !== "ended") {
      if (now() > until) throw new Error(`The upgrade on ${node} hasn't finished after ${UPGRADE_LIMIT_MS / 3600000} hours. It carries on there by itself; its log is ${UPGRADE_LOG}.`);
      await pause(FOLLOW_EVERY_MS);
      read = await ask(session, node);
      if (read) seen?.(read);
    }
    return read as UpgradeRead;
  }
  const packagesFailed = (node: string, r: UpgradeRead) =>
    new Error(
      `The package upgrade on ${node} ended with an error (${r.exitCode === null ? "it was stopped" : `apt exit code ${r.exitCode}`}), so it wasn't restarted.${r.errors.length ? ` apt said: ${r.errors.join(" ")}` : ""} The whole log is ${UPGRADE_LOG} on ${node}.`,
    );
  const unfinishedPackages = (node: string) =>
    new Error(`dpkg on ${node} has packages it didn't finish installing, so it wasn't restarted. Run dpkg --configure -a in ${node}'s shell, then try again. The log is ${UPGRADE_LOG}.`);

  /**
   * Right before the restart, read again what was true at the start: a guest may have arrived (HA, or someone), and
   * the cluster must still hold its majority without this node.
   */
  async function stillSafe(session: Session, node: string) {
    const t = session.ticket;
    const [cluster, nodes, guests] = await Promise.all([
      settled(() => deps.pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t)),
      settled(() => deps.pve.get<RawResource[]>("/cluster/resources?type=node", t)),
      settled(() => deps.pve.get<RawResource[]>("/cluster/resources?type=vm", t)),
    ]);
    const c = cluster.find((x) => x.type === "cluster");
    if (c && c.quorate !== 1) throw new Error(`The cluster lost its majority during the upgrade, so ${node} wasn't restarted.`);
    const off = nodes.filter((n) => n.node !== node && n.status !== "online").map((n) => n.node);
    if (off.length) throw new Error(`${off.join(", ")} went offline during the upgrade, so ${node} wasn't restarted.`);
    const on = guests.filter((g) => g.node === node && g.template !== 1 && (g.status === "running" || g.status === "paused"));
    if (on.length)
      throw new Error(
        `${on.map((g) => g.name ?? `${g.vmid}`).join(", ")} ${on.length === 1 ? "is" : "are"} running on ${node} now, so it wasn't restarted. Move or shut down, then upgrade it again to finish.`,
      );
  }

  async function readFreePlan(session: Session, node: string): Promise<FreeChannelPlan> {
    const base = `/nodes/${enc(node)}`;
    const [repos, sub] = await Promise.all([
      deps.pve.get<RawRepositories>(`${base}/apt/repositories`, session.ticket).catch(() => null),
      deps.pve.get<RawSubscription>(`${base}/subscription`, session.ticket).catch(() => null),
    ]);
    return planFreeChannel(repos, sub);
  }

  /**
   * Turns off the paid entries the new packages added, one at a time through Proxmox's own call with its digest, and
   * reads each back before saying so (rules R4, R8). Never stops the upgrade: what didn't work is said on the node.
   */
  async function keepFreeChannel(session: Session, node: string, plan: FreeChannelPlan, job: NodeUpgrade) {
    const base = `/nodes/${enc(node)}`;
    const state = job.freeChannel as NonNullable<NodeUpgrade["freeChannel"]>;
    try {
      const read = () => settled(() => deps.pve.get<RawRepositories>(`${base}/apt/repositories`, session.ticket));
      let repos = await read();
      const added = paidAdded(plan, repos);
      for (const e of added) {
        await deps.pve.post(`${base}/apt/repositories`, session, { path: e.path, index: String(e.index), enabled: "0", ...(repos.digest ? { digest: repos.digest } : {}) });
        repos = await read();
        if (paidOn(repos).some((x) => x.path === e.path && x.index === e.index)) throw new Error(`Proxmox still has ${e.path} switched on.`);
        state.turnedOff.push(e.path);
      }
      deps.audit("upgrade-free-channel", session.username, { node, off: state.turnedOff.length });
    } catch (err) {
      state.note = `BossMox couldn't turn off the paid update source the upgrade added (${(err as Error).message || "no answer"}). Use the free channel on the node's Updates tab.`;
    }
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

        // Decided before anything changes: does this node keep the free channel, and which paid entries were on already.
        const freePlan = await readFreePlan(session, node);
        job.freeChannel = { planned: freePlan.keep, why: freePlan.why, turnedOff: [], note: null };

        phase("upgrading");
        job.packagesTouched = true;
        // From here the old sources must never go back.
        deps.sources.forget(node);
        deps.audit("upgrade-node-start", session.username, { node, to: job.to });
        const r = await upgrade(session, node, (read) => {
          if (read.progress) job.progress = { ...read.progress, at: now() };
        });
        job.progress = null;
        job.keptConfig = r.keptConfig;
        if (r.exitCode !== 0) throw packagesFailed(node, r);
        if (r.unfinished) throw unfinishedPackages(node);
        if (freePlan.keep) await keepFreeChannel(session, node, freePlan, job);
      } else {
        deps.audit("upgrade-node-finish", session.username, { node, to: job.to });
        // BossMox's own package job may still be going there (BossMox restarted part way): wait for it, and never
        // finish over one that failed or left packages half in. No job there (upgraded by hand) reads as ended.
        const r = await untilEnded(session, node, await ask(session, node));
        job.keptConfig = r.keptConfig;
        if (r.exitCode !== null && r.exitCode !== 0) throw packagesFailed(node, r);
        if (r.unfinished) throw unfinishedPackages(node);
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

      await stillSafe(session, node);
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
      runningSession = null;
    }
  }

  const api = {
    view: () => state,
    running: () => running,
    /** Whose upgrade is going: BossMox keeps that person's Proxmox login fresh until it ends, browser open or not. */
    session: () => runningSession,

    /** Checks everything that can be checked up front, then upgrades in the background. The page follows view(). */
    async start(session: Session, node: string, confirm: string, inRun = false): Promise<NodeUpgrade> {
      if (session.username !== "root@pam") throw new HttpError(403, "The upgrade runs in the node's root console. Sign in as root@pam.");
      if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
      if (running) throw new HttpError(409, `BossMox is already upgrading ${running}. One node at a time.`);
      const other = inRun ? null : deps.busy?.();
      if (other) throw new HttpError(409, `${other} Wait for it to finish, or upgrade from Upgrade all nodes.`);
      if (deps.sources.busy()) throw new HttpError(409, "BossMox is changing a node's update sources. Wait for that to finish.");
      const left = session.expiresAt - now();
      if (left < UPGRADE_NEEDS_MS)
        throw new HttpError(400, `Your sign-in ends in ${Math.max(1, Math.round(left / 60000))} minutes, and the upgrade needs it until the end. Sign out and in again first.`);
      running = node;
      runningSession = session;
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
          packagesTouched: finishing,
          version: null,
          kernel: null,
        };
        state[node] = job;
        void drive(session, job, major);
        return job;
      } catch (err) {
        running = null;
        runningSession = null;
        throw err;
      }
    },

    /**
     * One node, start to finish, for the cluster run (piece 6): the run's own confirmation covers it. Resolves with
     * the job once it has ended, done or failed; rejects only when it was refused up front.
     */
    async runOne(session: Session, node: string): Promise<NodeUpgrade> {
      const job = await api.start(session, node, node, true);
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
  sources: Pick<UpgradeSources, "switchNode" | "undo" | "view">;
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
      const fail = (error: string): UpgradeResult => ({ restarted: false, packagesTouched: false, error, keptConfig: [], version: null, kernel: null });
      let switchedNow = false;
      /** The sources backup is forgotten once the packages start: while it's still there, nothing else changed. */
      const putBack = async (error: string): Promise<string> => {
        if (!switchedNow || !deps.sources.view()[node]?.backup) return error;
        try {
          const s = await deps.sources.undo(session, node, node);
          return s.error ? `${error} Its update sources are still on the new release: ${s.error}` : `${error} Its update sources were put back.`;
        } catch (err) {
          return `${error} Its update sources are still on the new release: ${(err as Error).message} Put them back from the upgrade window.`;
        }
      };
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
            switchedNow = true;
          }
        }
        const job = await deps.nodes.runOne(session, node);
        const error = job.error && !job.restarted ? await putBack(job.error) : job.error;
        return { restarted: job.restarted, packagesTouched: job.packagesTouched, error, keptConfig: job.keptConfig, version: job.version, kernel: job.kernel };
      } catch (err) {
        return fail(await putBack((err as Error).message || "BossMox lost contact with Proxmox."));
      }
    },
  };
}
export type RunUpgrade = ReturnType<typeof createRunUpgrade>;
