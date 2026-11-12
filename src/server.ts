import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, Sessions, type LoginOutcome, type Session } from "./auth.js";
import { clientAddress, loadConfig, sameOrigin } from "./config.js";
import { Terminals, type TermProxy } from "./terminal.js";
import { buildOverview, clonesOf, type Guest, type Overview, type RawConfig, type RawResource, type RawSnapshot } from "./model.js";
import { buildBackups, type BackupSource, type RawBackupFile, type RawBackupJob } from "./backups.js";
import { containerForm, CreateError, discDownload, discForm, FILE_STORAGE, installerLabel, vmForm, type CreateInput } from "./create.js";
import { changesForm, SettingsError, waitingChanges } from "./guest-settings.js";
import { buildNetwork, type RawDns, type RawInterface } from "./network.js";
import { assertCanWipe, buildStorageList, eraseBlocker, setupPlan, deviceIsValid, diskStorageForm, hostIsValid, networkForm, readHardDisks, StorageError, storageBlockers, usesForm, type RawDisk, type RawStorageConfig } from "./storage.js";
import { snapshotFix, addDiskForm, addNicForm, addressForm, growForm, HardwareError, pickAddresses, removeDiskForm, removeNicForm } from "./hardware.js";
import { networkInterfaces } from "node:os";
import { PveClient, PveError, type Identity } from "./pve.js";
import { applyChannel, ChannelError } from "./update-channel.js";
import { plainError } from "./plain-errors.js";
import { buildHealth, type Leftover } from "./health.js";
import { canChangeCluster, KEEP_FREE_CHOICES, preferencesPath, readPreferences, scheduleWarnings, writePreferences, type Preferences } from "./preferences.js";
import { settingsPath } from "./settings.js";
import { gbText, guestNeed, planMoves, room as roomFor, type MovePlan, type NodeRoom, type RawPrecondition } from "./placement.js";
import { movesPath, readMoves, runMoveHome, runMoveOff, stillAway, writeMoves, type MoveDeps } from "./moves.js";
import { checkNetworks, migrationNetwork, SAFE_BATCH, type NetCheck } from "./cluster-net.js";
import { buildRecommended, optionsForm, props, RecommendedError } from "./recommended.js";
import { drive, readRun, runsPath, writeRun, type Choice, type Run, type RunDeps, type RunNode } from "./run.js";
import { INSTALL_COMMAND, runOnNode } from "./node-shell.js";
import { UPDATE_COMMAND, UpdateChecker, versionNumbers } from "./update-check.js";
import { buildUsage, RANGES, type Range, type RawPoint } from "./usage.js";
import { buildStorageMap, poolItems, poolRemoval, type GuestRefs, type RawLvm, type RawMount, type RawStorageStatus, type RawVolume, type RawZfsDetail } from "./storage-map.js";
import {
  buildMovePlan,
  buildRebootPlan,
  buildRollingPlan,
  buildTaskFeed, buildTaskLog,
  groupUpdates,
  buildServerDetail,
  taskView,
  type RawBackupStorage,
  type RawMovePrecondition,
  type RawRepositories,
  type RawService,
  type RawStatus,
  type RawSubscription,
  type RawTask,
  type RawTaskStatus,
  type RawUpdate,
  type RollingInput,
  type TaskFeed,
  type Section,
  type ServerDetail,
} from "./server-detail.js";
import { hostName, requestPath } from "./config.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
/** Written into a release. A copy run from the repo has none, and the page then shows nothing. */
const VERSION = (() => {
  try {
    return readFileSync(path.resolve(PUBLIC, "../VERSION"), "utf8").trim();
  } catch {
    return "";
  }
})();
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.js": ["vendor/xterm.js", "text/javascript; charset=utf-8"],
  "/vendor/addon-fit.js": ["vendor/addon-fit.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": ["vendor/xterm.css", "text/css; charset=utf-8"],
  "/vendor/novnc.js": ["vendor/novnc.js", "text/javascript; charset=utf-8"],
  "/vendor/figtree.woff2": ["vendor/figtree.woff2", "font/woff2"],
  "/vendor/manrope.woff2": ["vendor/manrope.woff2", "font/woff2"],
  "/vendor/ibm-plex-sans.woff2": ["vendor/ibm-plex-sans.woff2", "font/woff2"],
  "/favicon.ico": ["icons/favicon.ico", "image/x-icon"],
  "/icons/icon-32.png": ["icons/icon-32.png", "image/png"],
  "/icons/icon-180.png": ["icons/icon-180.png", "image/png"],
  "/icons/icon-64.png": ["icons/icon-64.png", "image/png"],
  "/icons/logo-240.png": ["icons/logo-240.png", "image/png"],
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const CACHE_MS = 4000;
const MAX_BODY = 8 * 1024;

const config = loadConfig();
const pve = new PveClient(config);
const sessions = new Sessions(pve);
const terminals = new Terminals({
  get pveUrl() {
    return pve.activeUrl;
  },
  consoleIdleMs: config.consoleIdleMs,
  pveCa: config.pveCa,
  pveTlsName: config.pveTlsName,
} as ConstructorParameters<typeof Terminals>[0]);
sessions.onEnd = (session) => {
  terminals.closeSession(session);
  if (session === moveJob.session) moveJob.stop = `${session.username} signed out.`;
  if (session === runState.session && currentRun?.running) currentRun.stop = `${session.username} signed out.`;
};
// A move job keeps its person's Proxmox login renewed, like an open console does.
sessions.isBusy = (session) => terminals.hasOpen(session) || session === moveJob.session || session === runState.session;
setInterval(() => void sessions.tick().catch((err: Error) => console.error("Session check failed:", err.message)), 60 * 1000).unref();
const secureCookie = Boolean(config.tls) || config.behindProxy;
// The __Host- prefix stops a sibling site or another port from setting this cookie over the real one.
const COOKIE = secureCookie ? "__Host-bossmox_session" : "bossmox_session";
// A proxy on a custom port often drops that port from Host, so behind one the configured names are enough.
/** Guests moved off a node and the job moving them (ADR 0025). One job at a time across the cluster. */
const MOVES_FILE = movesPath(settingsPath(process.env));
const moveRecord = readMoves(MOVES_FILE);
const moveJob: { session: Session | null; stop: string | null; starting: boolean } = { session: null, stop: null, starting: false };
const proxiedNames = config.behindProxy || config.trustedProxies.size > 0 ? config.publicNames : new Set<string>();
type Loaded = Overview & { tasks: TaskFeed; preferences: Preferences };
const cache = new WeakMap<Session, { at: number; value: Promise<Loaded>; epoch: number }>();

/** Cluster-wide preferences (ADR 0018), read once at start. A change bumps the epoch, so no cached view outlives it. */
const PREFERENCES_FILE = preferencesPath(settingsPath(process.env));
let preferences: Preferences = readPreferences(PREFERENCES_FILE);
let preferencesEpoch = 0;

/** Checks GitHub for a newer BossMox every 6 hours while it's on (ADR 0019). A copy with no version never checks. */
const updates = new UpdateChecker(VERSION, preferences.updateCheck);
updates.start();
const HAS_VERSION = versionNumbers(VERSION) !== null;
const SHORT_VERSION = VERSION.replace(/^(\d+\.\d+\.\d+(?:-[a-z]+)?).*$/, "$1");
const updateView = () => (HAS_VERSION ? { on: updates.state.on, available: updates.state.available, command: UPDATE_COMMAND } : null);

async function fetchGuest(r: RawResource, ticket: string): Promise<[number, Guest]> {
  const base = `/nodes/${encodeURIComponent(r.node ?? "")}/${r.type}/${r.vmid}`;
  const [cfg, snaps] = await Promise.allSettled([
    pve.get<RawConfig>(`${base}/config`, ticket),
    pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket),
  ]);
  const guest: Guest = {};
  if (cfg.status === "fulfilled") guest.config = cfg.value;
  if (snaps.status === "fulfilled") guest.snapshots = snaps.value;
  return [Number(r.vmid ?? 0), guest];
}

async function loadOverview(ticket: string): Promise<Loaded> {
  const resources = await pve.get<RawResource[]>("/cluster/resources", ticket);
  const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.status !== "unknown");
  const [details, notBackedUp, tasks] = await Promise.all([
    Promise.all(guests.map((g) => fetchGuest(g, ticket))),
    // Limited accounts can't read this report, and that shouldn't blank the whole screen.
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up", ticket).catch(() => []),
    pve.get<(RawTask & { node?: string })[]>("/cluster/tasks", ticket).catch(() => []),
  ]);
  // With backups done another way, nobody is warned about guests missing a Proxmox schedule (ADR 0018).
  const view = buildOverview(resources, new Map(details), scheduleWarnings(preferences, notBackedUp));
  return { ...view, tasks: buildTaskFeed(tasks, view.vms), preferences };
}

function overview(session: Session): Promise<Loaded> {
  const hit = cache.get(session);
  if (hit && hit.epoch === preferencesEpoch && Date.now() - hit.at <= CACHE_MS) return hit.value;
  const value = loadOverview(session.ticket);
  cache.set(session, { at: Date.now(), value, epoch: preferencesEpoch });
  value.catch(() => cache.delete(session));
  return value;
}

async function section<T>(load: Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, value: await load };
  } catch (err) {
    if (err instanceof PveError && err.status === 401) throw err;
    return { available: false };
  }
}

async function loadServerDetail(name: string, ticket: string): Promise<ServerDetail> {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const [status, updates, repos, subscription, services, tasks, clusterStatus] = await Promise.all([
    section(pve.get<RawStatus>(`${base}/status`, ticket)),
    section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
    section(pve.get<RawRepositories>(`${base}/apt/repositories`, ticket)),
    section(pve.get<RawSubscription>(`${base}/subscription`, ticket)),
    section(pve.get<RawService[]>(`${base}/services`, ticket)),
    section(pve.get<RawTask[]>(`${base}/tasks?limit=25`, ticket)),
    section(pve.get<{ type?: string }[]>("/cluster/status", ticket)),
  ]);
  return buildServerDetail(name, status, updates, repos, subscription, services, tasks, clusterStatus);
}

interface RawStorage {
  storage: string;
  active?: number;
  enabled?: number;
  avail?: number;
  shared?: number;
}
const usable = (s: RawStorage) => s.active !== 0 && s.enabled !== 0;

async function loadBackups(ticket: string) {
  const data = await loadOverview(ticket);
  const online = data.nodes.filter((n) => n.online).map((n) => n.name);
  const sharedSeen = new Set<string>();
  const perNode = await Promise.all(online.map(async (node) => {
    const base = `/nodes/${encodeURIComponent(node)}/storage`;
    const storages = (await pve.get<RawStorage[]>(`${base}?content=backup`, ticket)).filter(usable);
    return { node, base, storages };
  }));
  const reads: Promise<BackupSource[]>[] = [];
  for (const { node, base, storages } of perNode) {
    for (const s of storages) {
      // Storage shared between servers holds the same files, so read it once.
      if (s.shared === 1) {
        if (sharedSeen.has(s.storage)) continue;
        sharedSeen.add(s.storage);
      }
      reads.push(pve.get<RawBackupFile[]>(`${base}/${encodeURIComponent(s.storage)}/content?content=backup`, ticket).then((files) => files.map((file) => ({ node, storage: s.storage, file }))).catch(() => []));
    }
  }
  const [files, jobs, notBackedUp] = await Promise.all([
    Promise.all(reads),
    pve.get<RawBackupJob[]>("/cluster/backup", ticket).catch(() => []),
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up", ticket).catch(() => []),
  ]);
  return { ...buildBackups(files.flat(), data.vms.map((v) => ({ id: v.id, name: v.name })), jobs, scheduleWarnings(preferences, notBackedUp)), backupsElsewhere: preferences.backupsElsewhere };
}

async function loadRestorePlan(name: string, type: "qemu" | "lxc", ticket: string) {
  const content = type === "qemu" ? "images" : "rootdir";
  const [storages, nextId] = await Promise.all([
    pve.get<RawStorage[]>(`/nodes/${encodeURIComponent(name)}/storage?content=${content}`, ticket),
    pve.get<string | number>("/cluster/nextid", ticket),
  ]);
  return { nextId: Number(nextId), storages: storages.filter(usable).map((s) => s.storage) };
}

async function loadNetwork(name: string, ticket: string) {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const [data, interfaces, dns] = await Promise.all([
    loadOverview(ticket),
    pve.get<RawInterface[]>(`${base}/network`, ticket),
    pve.get<RawDns>(`${base}/dns`, ticket).catch(() => null),
  ]);
  return buildNetwork(name, interfaces, dns, data.vms);
}

async function loadCreatePlan(name: string, kind: "qemu" | "lxc", ticket: string) {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const content = kind === "qemu" ? "iso" : "vztmpl";
  const [disks, media, bridges, status, nextId] = await Promise.all([
    pve.get<RawStorage[]>(`${base}/storage?content=${kind === "qemu" ? "images" : "rootdir"}`, ticket),
    pve.get<RawStorage[]>(`${base}/storage?content=${content}`, ticket),
    pve.get<{ iface: string }[]>(`${base}/network?type=any_bridge`, ticket),
    pve.get<RawStatus>(`${base}/status`, ticket),
    pve.get<string | number>("/cluster/nextid", ticket),
  ]);
  const files = await Promise.all(media.filter(usable).map((s) => pve.get<{ volid: string }[]>(`${base}/storage/${encodeURIComponent(s.storage)}/content?content=${content}`, ticket).catch(() => [])));
  return {
    nextId: String(nextId),
    storages: disks.filter(usable).map((s) => ({ name: s.storage, freeGb: Math.round((s.avail ?? 0) / 1024 ** 3) })),
    installers: files.flat().map((f) => ({ volid: f.volid, label: installerLabel(f.volid) })),
    mediaStorages: media.filter(usable).map((s) => s.storage),
    bridges: bridges.map((b) => b.iface),
    cores: Number(status.cpuinfo?.cpus ?? 0),
    memoryGb: Math.floor((status.memory?.total ?? 0) / 1024 ** 3),
  };
}

const enc = encodeURIComponent;
/**
 * Fresh numbers from Proxmox, and where each guest of `from` would go (ADR 0025). Without `ids` it plans every
 * running guest. With `only`, that node is the one target allowed (sending guests home).
 */
async function planEvacuation(ticket: string, from: string, ids?: number[], only?: string, pending: Record<string, number> = {}) {
  const resources = await pve.get<RawResource[]>("/cluster/resources", ticket);
  const online = resources.filter((r) => r.type === "node" && r.status === "online" && (!only || r.node === from || r.node === only));
  const statuses = await Promise.all(online.map((n) => pve.get<RawStatus>(`/nodes/${enc(n.node ?? "")}/status`, ticket).catch(() => null)));
  const storagesOf = (node: string) => Object.fromEntries(resources
    .filter((r) => r.type === "storage" && r.node === node && r.status === "available")
    .map((r) => [r.storage ?? "", { free: (r.maxdisk ?? 0) - (r.disk ?? 0), total: r.maxdisk ?? 0, shared: r.shared === 1 }]));
  const nodes: NodeRoom[] = online.map((r, i) => ({
    name: r.node ?? "",
    version: statuses[i]?.pveversion?.split("/")[1] ?? null,
    cpuModel: statuses[i]?.cpuinfo?.model ?? null,
    cores: r.maxcpu ?? 0,
    cpuLoad: (r.cpu ?? 0) * (r.maxcpu ?? 0),
    memTotal: r.maxmem ?? 0,
    memUsed: r.mem ?? 0,
    storages: storagesOf(r.node ?? ""),
  }));
  // A guest that just arrived shows only the memory it has touched so far. Everything BossMox moved counts at its
  // full set memory, so planning again between moves can't fill a node the first plan had already filled.
  const arrived = new Set([...Object.values(moveRecord.away).flatMap((a) => a.guests.map((g) => g.id)), ...(moveRecord.job?.guests.filter((g) => g.state === "done").map((g) => g.id) ?? [])]);
  for (const r of resources) {
    const n = nodes.find((x) => x.name === r.node);
    if (n && (r.type === "qemu" || r.type === "lxc") && r.status === "running" && arrived.has(Number(r.vmid))) n.memUsed += Math.max(0, (r.maxmem ?? 0) - (r.mem ?? 0));
  }
  for (const n of nodes) n.memUsed += pending[n.name] ?? 0;
  const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.node === from && r.template !== 1 && (ids ? ids.includes(Number(r.vmid)) : r.status === "running" || r.status === "paused"));
  const needs = await Promise.all(guests.map(async (g) => {
    const type = g.type === "lxc" ? "lxc" : "qemu";
    const id = Number(g.vmid);
    const base = `/nodes/${enc(from)}/${type}/${id}`;
    const [config, snaps, precondition] = await Promise.all([
      pve.get<RawConfig>(`${base}/config`, ticket),
      pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket).catch((): RawSnapshot[] => []),
      // Older Proxmox has no migrate check for containers; BossMox's own storage check still applies.
      pve.get<RawPrecondition>(`${base}/migrate`, ticket).catch((): RawPrecondition => ({})),
    ]);
    return guestNeed({
      id,
      type,
      name: g.name ?? String(config.name ?? config.hostname ?? `VM ${id}`),
      mem: g.maxmem ?? 0,
      cores: g.maxcpu ?? 0,
      cpuLoad: (g.cpu ?? 0) * (g.maxcpu ?? 0),
      config,
      hasSnapshots: snaps.some((s) => s.name !== "current"),
      precondition,
      sourceStorages: storagesOf(from),
    });
  }));
  const keep = preferences.keepFreePct;
  const plan: MovePlan = planMoves(from, needs, nodes, keep);
  // What each other node has now and would have after, so the person sees why it was picked.
  const room = nodes.filter((n) => n.name !== from).map((n) => {
    const adds = plan.moves.filter((m) => m.target === n.name).reduce((sum, m) => sum + (needs.find((g) => g.id === m.id)?.mem ?? 0), 0);
    return { name: n.name, guests: plan.moves.filter((m) => m.target === n.name).length, freeNow: gbText(n.memTotal - n.memUsed), freeAfter: gbText(n.memTotal - n.memUsed - adds), keeps: gbText((n.memTotal * roomFor(keep).memFreePct) / 100) };
  });
  return { ...plan, room, keepFreePct: keep };
}

/** How a move job reaches Proxmox: always with the person's current login, which renewals replace. */
function moveDeps(session: Session): MoveDeps {
  return {
    plan: (from, ids, only, pending) => planEvacuation(session.ticket, from, ids, only, pending),
    migrate: async (move, from) => {
      const base = `/nodes/${enc(from)}/${move.type}/${move.id}`;
      const now = await pve.get<{ status?: string }>(`${base}/status/current`, session.ticket);
      const running = now.status === "running" || now.status === "paused";
      const form: Record<string, string> = move.type === "qemu"
        ? { target: move.target, "with-local-disks": "1", ...(running ? { online: "1" } : {}) }
        : { target: move.target, ...(running ? { restart: "1" } : {}) };
      // A node that has just come back can refuse a move for a few seconds. A refusal means nothing started.
      for (const until = Date.now() + 60 * 1000; ; await new Promise((r) => setTimeout(r, 5000))) {
        try {
          return await pve.post<string>(`${base}/migrate`, session, form);
        } catch (err) {
          if (!(err instanceof PveError) || err.status === 401 || err.status === 403 || Date.now() > until) throw err;
        }
      }
    },
    task: async (node, upid) => {
      const s = await pve.get<RawTaskStatus>(`/nodes/${enc(node)}/tasks/${enc(upid)}/status`, session.ticket);
      const exit = s.exitstatus ?? "";
      return { finished: s.status === "stopped", ok: exit === "OK" || exit.startsWith("WARNINGS"), error: exit || "unknown error" };
    },
    where: async () => new Map((await pve.get<RawResource[]>("/cluster/resources?type=vm", session.ticket)).map((r) => [Number(r.vmid), r.node ?? ""])),
    stopped: () => moveJob.stop,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    save: (record) => {
      try {
        writeMoves(MOVES_FILE, record);
      } catch (err) {
        console.error("Couldn't save the move record:", (err as Error).message);
      }
    },
  };
}

/** Starts a move job in the background. The check and the claim happen before any wait, so two can't start. */
async function startMoveJob(session: Session, prepare: () => Promise<((deps: MoveDeps) => Promise<void>) | null>): Promise<string | null> {
  if (currentRun?.running) throw new AuthError(409, "An update or restart run is going. Its moves are part of it.");
  if (moveJob.starting || moveRecord.job?.running) throw new AuthError(409, `BossMox is already moving guests${moveRecord.job?.running ? ` (${moveRecord.job.kind === "off" ? "off" : "home to"} ${moveRecord.job.node})` : ""}. Wait for that to finish.`);
  moveJob.starting = true;
  try {
    const run = await prepare();
    if (!run) return null;
    moveJob.session = session;
    moveJob.stop = null;
    void run(moveDeps(session))
      .catch((err: Error) => console.error("Move job failed:", err.message))
      .finally(() => {
        moveJob.session = null;
        cache.delete(session);
      });
    // The job is on the record by now; its start time is how the page knows it's following this one.
    return moveRecord.job ? `job:${moveRecord.job.startedAt}` : null;
  } finally {
    moveJob.starting = false;
  }
}

async function loadRollingPlan(ticket: string) {
  const data = await loadOverview(ticket);
  const [cluster, tieBreaker, servers] = await Promise.all([
    section(pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", ticket)),
    section(pve.get<{ State?: string }>("/cluster/config/qdevice", ticket)),
    Promise.all(data.nodes.map(async (n): Promise<RollingInput> => {
      if (!n.online) return { name: n.name, online: false, version: null, updates: null, rebootNeeded: false, busy: [], cantMove: [], ejectable: [] };
      const base = `/nodes/${encodeURIComponent(n.name)}`;
      const [status, updates, active] = await Promise.all([
        section(pve.get<RawStatus>(`${base}/status`, ticket)),
        section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
        section(pve.get<RawTask[]>(`${base}/tasks?source=active`, ticket)),
      ]);
      const list = updates.available ? groupUpdates(updates.value) : null;
      // Each node that restarts is planned against the cluster as it is now: guests go home before the next one.
      const evac = list?.rebootNeeded && list.total > 0
        ? await planEvacuation(ticket, n.name).catch((err: Error) => ({ problems: [`BossMox couldn't plan the moves: ${err.message}`], ejectable: [] }))
        : { problems: [], ejectable: [] };
      const cantMove = evac.problems.map((p) => `${n.name}: ${p}`);
      const ejectable = (evac.ejectable ?? []).map((g) => ({ ...g, node: n.name }));
      return {
        name: n.name,
        online: true,
        version: status.available ? status.value.pveversion?.split("/")[1] ?? null : null,
        updates: list ? list.total : null,
        rebootNeeded: list?.rebootNeeded ?? false,
        busy: buildRebootPlan(active, { available: false }).busy,
        cantMove,
        ejectable,
      };
    })),
  ]);
  const quorate: Section<boolean> = cluster.available
    ? { available: true, value: cluster.value.find((c) => c.type === "cluster")?.quorate === 1 }
    : { available: false };
  return buildRollingPlan(servers, quorate, tieBreaker);
}

/* Update and restart runs on the server (ADR 0027). */
const RUNS_FILE = runsPath(settingsPath(process.env));
let currentRun: Run | null = readRun(RUNS_FILE);
const runState: { session: Session | null; starting: boolean } = { session: null, starting: false };
const saveRun = (run: Run) => {
  try {
    writeRun(RUNS_FILE, run);
  } catch (err) {
    console.error("Couldn't save the run:", (err as Error).message);
  }
};

/** The MAC addresses of this BossMox's own network cards: the VM that has one of them is BossMox itself. */
function ownMacs(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flat().map((i) => i?.mac?.toLowerCase() ?? "").filter((m) => m && m !== "00:00:00:00:00:00"));
}
const isSelf = (config: RawConfig, macs: Set<string>) => Object.entries(config).some(([k, v]) => /^net\d+$/.test(k) && [...macs].some((m) => String(v).toLowerCase().includes(m)));

const waitTask = async (node: string, upid: string, ticket: string, limitMs: number) => {
  for (const until = Date.now() + limitMs; ; await new Promise((r) => setTimeout(r, 2000))) {
    const s = await pve.get<RawTaskStatus>(`/nodes/${enc(node)}/tasks/${enc(upid)}/status`, ticket).catch(() => null);
    if (s?.status === "stopped") {
      const exit = s.exitstatus ?? "";
      if (exit === "OK" || exit.startsWith("WARNINGS")) return;
      throw new Error(exit || "it failed");
    }
    if (Date.now() > until) throw new Error("it took too long");
  }
};

interface PlanVm { id: number; name: string; type: "qemu" | "lxc"; canMove: boolean; why: string; to: string | null; self: boolean; discSlots: string[]; choice: "move" | "shutdown" }
/** What a run would do on each node, with a choice per running VM: what it can do, and the safe default. */
async function runPlan(ticket: string, kind: "update" | "restart", server: string) {
  const macs = ownMacs();
  const rolling = kind === "update" ? await loadRollingPlan(ticket) : null;
  const nodes = kind === "update"
    ? (rolling?.servers ?? []).map((s) => ({ name: s.name, version: s.version, updates: s.updates ?? 0, restart: s.rebootNeeded, install: true }))
    : [{ name: server, version: null, updates: 0, restart: true, install: false }];
  const out = await Promise.all(nodes.map(async (n) => {
    if (!n.restart) return { ...n, vms: [] as PlanVm[] };
    const evac = await planEvacuation(ticket, n.name);
    const resources = await pve.get<RawResource[]>("/cluster/resources?type=vm", ticket);
    const running = resources.filter((r) => r.node === n.name && (r.status === "running" || r.status === "paused") && r.template !== 1);
    const vms: PlanVm[] = await Promise.all(running.map(async (r) => {
      const id = Number(r.vmid);
      const type = r.type === "lxc" ? "lxc" : "qemu";
      const config = await pve.get<RawConfig>(`/nodes/${enc(n.name)}/${type}/${id}/config`, ticket).catch((): RawConfig => ({}));
      const unplaced = evac.unplaced?.find((u) => u.id === id);
      const to = evac.tentative?.find((m) => m.id === id)?.target ?? null;
      const self = type === "qemu" && isSelf(config, macs);
      return { id, name: r.name ?? `VM ${id}`, type, canMove: !unplaced, why: unplaced?.why ?? "", to, self, discSlots: evac.ejectable?.find((e) => e.id === id)?.slots ?? [], choice: unplaced && !self ? "shutdown" : "move" };
    }));
    return { ...n, vms: vms.sort((a, b) => a.name.localeCompare(b.name)) };
  }));
  // Rooms counted with every VM moving; a person's Shut down choices only free more.
  const blocked = [...(rolling?.blocked.filter((b) => !rolling.servers.some((s) => b.startsWith(`${s.name}: `))) ?? [])];
  for (const n of out) for (const v of n.vms) if (v.self && !v.canMove) blocked.push(`BossMox runs in ${v.name} on ${n.name}, and it can't move: ${v.why} BossMox can't shut itself down, so this has to be fixed first.`);
  const net = await readNetCheck(ticket);
  return { kind, nodes: out, blocked, votes: rolling?.votes ?? null, keepsMajority: rolling?.keepsMajority ?? true, keepFreePct: preferences.keepFreePct, moveBatch: net.batch, moveShared: net.known && net.shared };
}

/**
 * Whether moves share the heartbeat's only network (ADR 0028), read fresh from Proxmox. Anything it can't read
 * gives "can't tell", which means the careful one-at-a-time moves.
 */
async function readNetCheck(ticket: string): Promise<NetCheck> {
  try {
    const [config, options, resources] = await Promise.all([
      pve.get<Record<string, unknown>[]>("/cluster/config/nodes", ticket),
      pve.get<{ migration?: string | { network?: string } }>("/cluster/options", ticket),
      pve.get<RawResource[]>("/cluster/resources?type=node", ticket),
    ]);
    const online = new Set(resources.filter((r) => r.status === "online").map((r) => r.node));
    if (config.some((c) => !online.has(String(c.node ?? c.name ?? "")))) return checkNetworks([], null);
    const nodes = await Promise.all(config.map(async (c) => {
      const name = String(c.node ?? c.name ?? "");
      const links = Object.keys(c).filter((k) => /^ring\d+_addr$/.test(k)).sort().map((k) => String(c[k]));
      const ifaces = await pve.get<{ cidr?: string }[]>(`/nodes/${enc(name)}/network`, ticket);
      return { name, links, addresses: ifaces.flatMap((i) => (i.cidr ? [i.cidr] : [])) };
    }));
    return checkNetworks(nodes, migrationNetwork(options.migration));
  } catch {
    return checkNetworks([], null);
  }
}
const batchFor = (ticket: string) => readNetCheck(ticket).then((c) => c.batch, () => SAFE_BATCH);

/** The cluster options the recommended settings read and change, plus the move network judged from them. */
async function readOptions(ticket: string) {
  const [options, net] = await Promise.all([pve.get<Record<string, unknown>>("/cluster/options", ticket), readNetCheck(ticket)]);
  return { options, net: { ...net, current: migrationNetwork(options.migration as string | { network?: string } | undefined) } };
}

/** Recommended settings (ADR 0029), read fresh from Proxmox each time the window opens. */
async function loadRecommended(session: Session) {
  const t = session.ticket;
  const [data, { options, net }, ha, perms, stores] = await Promise.all([
    overview(session),
    readOptions(t),
    pve.get<{ sid?: string }[]>("/cluster/ha/resources", t).catch(() => []),
    pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", t).catch((): Record<string, Record<string, number>> => ({})),
    pve.get<{ storage?: string; portal?: string; server?: string; disable?: number }[]>("/storage", t).catch(() => []),
  ]);
  const limit = Number(props(options.bwlimit).migration);
  return buildRecommended({
    nodes: data.nodes.length,
    net,
    moveLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    haPolicy: props(options.ha).shutdown_policy ?? "conditional",
    haGuests: ha.filter((r) => /^(vm|ct):/.test(r.sid ?? "")).length,
    noBoot: data.vms.filter((v) => v.running && !v.template && !v.startsAtBoot).map((v) => ({ id: v.id, name: v.name })),
    canChange: canChangeCluster(perms),
    // An iSCSI portal ("10.0.100.31:3260") or a NAS address. Host names are left out: nothing to compare.
    storage: stores.filter((x) => x.disable !== 1).flatMap((x) => {
      const ip = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec((x.portal ?? x.server ?? "").trim())?.[1];
      return ip && x.storage ? [{ id: x.storage, ip }] : [];
    }),
  });
}

/** How long bringing guests home waits for a just-restarted node's processor to calm down. */
const RETURN_SETTLE_MS = 5 * 60 * 1000;

/** How a run reaches Proxmox and the move job, always with the starting person's current login. */
function runDeps(session: Session, run: Run): RunDeps {
  const t = () => session.ticket;
  const moves: MoveDeps = { ...moveDeps(session), stopped: () => run.stop ?? moveJob.stop };
  return {
    stopped: () => run.stop,
    save: saveRun,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    notReady: async (node) => {
      const [status, resources, active] = await Promise.all([
        pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t()).catch(() => null),
        pve.get<RawResource[]>("/cluster/resources?type=node", t()).catch(() => null),
        section(pve.get<RawTask[]>(`/nodes/${enc(node)}/tasks?source=active`, t())),
      ]);
      if (!status || !resources) return "BossMox can't tell whether the cluster is healthy.";
      if (status.some((c) => c.type === "cluster") && status.find((c) => c.type === "cluster")?.quorate !== 1) return "The cluster has lost its majority.";
      const off = resources.filter((r) => r.status !== "online").map((r) => r.node);
      if (off.length) return `Waiting for these to come back online: ${off.join(", ")}.`;
      const busy = buildRebootPlan(active, { available: false }).busy;
      return busy.length ? `${node} is busy: ${busy.join(", ")}.` : null;
    },
    runningOn: async (node) => (await pve.get<RawResource[]>("/cluster/resources?type=vm", t()))
      .filter((r) => r.node === node && r.template !== 1 && (r.status === "running" || r.status === "paused"))
      .map((r) => ({ id: Number(r.vmid), name: r.name ?? `VM ${r.vmid}`, type: r.type === "lxc" ? "lxc" as const : "qemu" as const })),
    shutdown: async (node, vm) => {
      const upid = await pve.post<string>(`/nodes/${enc(node)}/${vm.type}/${vm.id}/status/shutdown`, session, { timeout: "180", forceStop: "1" });
      await waitTask(node, upid, t(), 5 * 60 * 1000);
    },
    moveOff: async (node, ids) => {
      const plan = await planEvacuation(t(), node, ids);
      if (plan.problems.length) throw new Error(plan.problems.join(" "));
      await runMoveOff(moveRecord, moves, node, session.username, plan.moves, await batchFor(t()));
      // Where each one is now, read from Proxmox: one may already have gone, moved home to another node earlier in the run.
      const where = await moves.where();
      const went = Object.fromEntries(ids.filter((id) => where.has(id) && where.get(id) !== node).map((id) => [id, where.get(id) as string]));
      return { went, error: moveRecord.job?.error ?? null };
    },
    install: async (node) => {
      const proxy = await pve.post<TermProxy>(`/nodes/${enc(node)}/termproxy`, session);
      const r = await runOnNode({ pveUrl: pve.activeUrl, pveCa: config.pveCa, pveTlsName: config.pveTlsName }, node, t(), proxy, INSTALL_COMMAND);
      const left = await pve.get<RawUpdate[]>(`/nodes/${enc(node)}/apt/update`, t()).then((u) => groupUpdates(u).total, () => null);
      return { exitCode: r.exitCode, keptConfig: r.keptConfig, left };
    },
    restart: async (node) => {
      const asked = Date.now();
      await pve.post<null>(`/nodes/${enc(node)}/status`, session, { command: "reboot" });
      for (const until = asked + 20 * 60 * 1000; ; await new Promise((r) => setTimeout(r, 5000))) {
        const s = await pve.get<RawStatus>(`/nodes/${enc(node)}/status`, t()).catch(() => null);
        const back = s?.uptime !== undefined && s.uptime * 1000 < Date.now() - asked;
        if (back) {
          const resources = await pve.get<RawResource[]>("/cluster/resources?type=node", t()).catch(() => []);
          if (resources.some((r) => r.node === node && r.status === "online")) return;
        }
        if (Date.now() > until) throw new Error(`${node} hasn't come back after 20 minutes. Someone may need to look at the node itself.`);
      }
    },
    start: async (node, vm) => {
      // A node that has just come back can refuse for a few seconds.
      for (let i = 0; ; i++) {
        try {
          const upid = await pve.post<string>(`/nodes/${enc(node)}/${vm.type}/${vm.id}/status/start`, session);
          return await waitTask(node, upid, t(), 5 * 60 * 1000);
        } catch (err) {
          if (i >= 6 || (err instanceof PveError && (err.status === 401 || err.status === 403))) throw err;
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    },
    moveHome: async (node, ids) => {
      const notes = new Map<number, string>();
      if (moveRecord.away[node]?.guests.length) {
        // A node just back from a restart is busy for a while. Give it up to 5 minutes to drop under the processor cap.
        const cap = 100 - preferences.keepFreePct;
        const until = Date.now() + RETURN_SETTLE_MS;
        for (; Date.now() < until; await new Promise((r) => setTimeout(r, 10_000))) {
          const s = await pve.get<RawStatus>(`/nodes/${enc(node)}/status`, t()).catch(() => null);
          if (s && (s.cpu ?? 0) * 100 <= cap) break;
        }
        // Each guest that comes home makes the node busier, so one turned away for that alone gets the rest of the window.
        await runMoveHome(moveRecord, moves, node, session.username, await batchFor(t()), Math.max(0, until - Date.now()));
        const job = moveRecord.job;
        if (job?.error) throw new Error(job.error);
        for (const g of job?.guests ?? []) if (g.state === "stayed") notes.set(g.id, g.note ?? "its home had no room");
      }
      const where = await moves.where();
      const out: Record<number, { on: string; why: string }> = {};
      for (const id of ids) {
        const on = where.get(id);
        if (on === undefined || on === node) continue;
        out[id] = { on, why: notes.get(id) ?? "BossMox's record has another node as its home" };
      }
      return out;
    },
  };
}

/** Starts a run with the person's choices. Everything is checked again here; the page's copy is only a request. */
async function startRun(session: Session, body: Record<string, unknown>): Promise<string> {
  const kind = body.kind === "restart" ? "restart" : body.kind === "update" ? "update" : null;
  if (!kind) throw new AuthError(400, "That request isn't valid.");
  const server = text(body.server, 64);
  if (kind === "restart" && !NODE_NAME.test(server)) throw new AuthError(400, "That server name isn't valid.");
  if (body.confirm !== (kind === "update" ? "confirm" : "reboot")) throw new AuthError(400, "It wasn't confirmed.");
  if (currentRun?.running || runState.starting) throw new AuthError(409, "A run is already going. Open it to follow or stop it.");
  if (moveRecord.job?.running || moveJob.starting) throw new AuthError(409, "BossMox is moving guests right now. Wait for that to finish.");
  const choices = (body.choices && typeof body.choices === "object" ? body.choices : {}) as Record<string, unknown>;
  runState.starting = true;
  try {
    // Discs chosen to come out go first, so those VMs are planned as movable.
    const eject = Object.entries(choices).filter(([, c]) => c === "eject").map(([id]) => Number(id));
    let plan = await runPlan(session.ticket, kind, server);
    if (plan.blocked.length) throw new AuthError(400, plan.blocked.join(" "));
    if (kind === "update" && !plan.nodes.length) throw new AuthError(400, "Every node is up to date.");
    for (const n of plan.nodes) for (const v of n.vms.filter((x) => eject.includes(x.id) && x.discSlots.length)) {
      const path = `/nodes/${enc(n.name)}/qemu/${v.id}`;
      const current = await pve.get<RawConfig>(`${path}/config`, session.ticket);
      for (const slot of v.discSlots) await pve.put<null>(`${path}/config`, session, discForm("", current, slot));
      audit("eject", session.username, "run", `node=${n.name} guest=${v.id}`);
    }
    if (eject.length) plan = await runPlan(session.ticket, kind, server);
    const nodes: RunNode[] = plan.nodes.map((n) => ({
      name: n.name, install: n.install, restart: n.restart, updates: n.updates, phase: "waiting", note: null, keptConfig: [],
      vms: n.vms.map((v) => {
        const asked = choices[String(v.id)];
        const choice: Choice = v.self ? "move" : asked === "shutdown" ? "shutdown" : asked === "move" || asked === "eject" ? "move" : v.choice;
        return { id: v.id, name: v.name, type: v.type, choice, state: "waiting" as const };
      }),
    }));
    // Everything chosen to move has to fit together, node by node.
    for (const n of nodes) {
      const moving = n.vms.filter((v) => v.choice === "move").map((v) => v.id);
      if (!moving.length || !n.restart) continue;
      const check = await planEvacuation(session.ticket, n.name, moving);
      if (check.problems.length) throw new AuthError(400, `${n.name}: ${check.problems.join(" ")} Choose Shut down for it, or lower Keep free.`);
    }
    currentRun = { id: `run:${Date.now()}`, kind, by: session.username, startedAt: Date.now(), finishedAt: null, running: true, stop: null, error: null, current: 0, nodes };
    const run = currentRun;
    runState.session = session;
    moveJob.stop = null;
    saveRun(run);
    void drive(run, runDeps(session, run))
      .catch((err: Error) => console.error("Run failed:", err.message))
      .finally(() => {
        runState.session = null;
        cache.delete(session);
      });
    return run.id;
  } finally {
    runState.starting = false;
  }
}

let realms: { realm: string; comment?: string; default?: number }[] = [];
let realmsAt = 0;

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, ...(secureCookie ? { "Strict-Transport-Security": "max-age=31536000" } : {}), "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown, extra?: Record<string, string>) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

const NODE_NAME = /^(?!\.+$)[\w.-]{1,64}$/;
const UPID = /^UPID:[\w.-]+:[0-9A-F]{8}:[0-9A-F]{8,}:[0-9A-F]{8}:\w+:[^:\s]*:[\w.@!-]+:$/;

const POWER = new Set(["start", "shutdown", "reboot", "stop"]);
const MAX_UPLOAD = 200 * 1024 ** 3;
const FULL_LOG = 20000;
const UEFI_WINDOW_MS = 8000;
const UEFI_GAP_MS = 1200;
const BIOS_SETTLE_MS = 8000;
const BIOS_ESC_AFTER_MS = 1500;
const UPLOAD_NAME = /^[\w.-]{1,200}\.(iso|img)$/i;

/** Turns a hardware rule into a plain 400, and reads the guest's settings the rule needs. */
/** The IPv4 addresses BossMox answers on from the network. Loopback (127.0.0.1) is left out: every guest has it too. */
function ownAddresses(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("127.")).map((i) => i!.address));
}
const part = (value: string, key: string) => value.split(",").find((p) => p.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
async function withConfig<T>(path: string, who: Identity, run: (config: RawConfig) => T): Promise<T> {
  const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
  try {
    return run(config);
  } catch (err) {
    if (err instanceof HardwareError) throw new AuthError(400, err.message);
    throw err;
  }
}
/** Turns a storage rule into a plain 400 rather than a failure. */
function rule<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof StorageError) throw new AuthError(400, err.message);
    throw err;
  }
}
/** Drives guests on this node use directly, by device path, so they never look free to wipe. */
const passedThrough = (name: string, data: Overview) => data.vms.filter((v) => v.node === name).flatMap((v) => v.devices.map((device) => ({ device, guest: v.name })));
/**
 * The node's drives. Anything that can erase one passes a fresh overview, so a guest added a moment ago counts, and
 * every drive is blocked when BossMox can't be sure no guest uses it (review S1).
 */
const nodeDisks = async (name: string, ticket: string, data: Overview) => {
  const [raw, seesAll] = await Promise.all([pve.get<RawDisk[]>(`/nodes/${encodeURIComponent(name)}/disks/list?include-partitions=1`, ticket), seesAllGuests(ticket)]);
  return readHardDisks(raw, passedThrough(name, data), eraseBlocker(guestRefs(data), seesAll));
};
const usesStorageNames = (body: unknown) => (Array.isArray(body) ? body.filter((d): d is string => typeof d === "string").slice(0, 32) : []);
const kindOf = (body: Record<string, unknown>) => (body.type === "lxc" ? "lxc" as const : "qemu" as const);
const VOLUME = /^[\w.-]+:[\w./-]+$/;
// Dot-only names ("." and "..") are refused: addresses fold them into the path around them (pre-public review 2026-11-09).
const STORAGE = /^(?!\.+$)[\w.-]{1,64}$/;
const JOB_ID = /^[\w-]{1,64}$/;
const SCHEDULE = /^((mon|tue|wed|thu|fri|sat|sun) )?([01]\d|2[0-3]):[0-5]\d$/;
const SNAPSHOT_NAME = /^[A-Za-z][\w-]{1,39}$/;

/** The address of one VM or container, checked, for actions that take one. */
function guestPath(name: string, body: Record<string, unknown>): { id: string; path: string } {
  const id = text(body.guest, 12);
  const type = body.type;
  if (!/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) throw new AuthError(400, "That request isn't valid.");
  return { id, path: `/nodes/${encodeURIComponent(name)}/${type}/${id}` };
}
function snapshotName(body: Record<string, unknown>): string {
  const snap = text(body.snapshot, 40);
  if (!SNAPSHOT_NAME.test(snap)) throw new AuthError(400, "A snapshot name starts with a letter, then letters, numbers, dashes or underscores.");
  return snap;
}

/** The health check reads a lot of Proxmox, so each person's result is kept briefly (security review L8). */
const HEALTH_CACHE_MS = 45_000;
const healthCache = new WeakMap<Session, { at: number; value: Promise<ReturnType<typeof buildHealth>>; running: boolean; epoch: number }>();

/** BossMox's own address comes from DHCP when its VM's network file says so. Null when it isn't running in its VM. */
function ownAddressFromDhcp(): boolean | null {
  try {
    const text = readFileSync("/etc/network/interfaces", "utf8");
    return /^\s*iface\s+eth0\s+inet\s+dhcp/m.test(text) ? true : /^\s*iface\s+eth0\s+inet\s+static/m.test(text) ? false : null;
  } catch {
    return null;
  }
}

/** Everything the health check looks at (ADR 0017), asked in parallel. A part that can't be read is left out, not failed. */
async function loadHealth(session: Session) {
  const t = session.ticket;
  const data = await overview(session);
  const online = data.nodes.filter((n) => n.online).map((n) => n.name);
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  const [status, nodeConfig, qdevice, jobs, tasks, details, maps, network, options, haResources, leftover] = await Promise.all([
    pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t).catch(() => []),
    pve.get<{ node?: string; quorum_votes?: string | number }[]>("/cluster/config/nodes", t).catch(() => []),
    pve.get<Record<string, unknown>>("/cluster/config/qdevice", t).catch(() => ({})),
    pve.get<{ id?: string; storage?: string; enabled?: number }[]>("/cluster/backup", t).catch(() => []),
    pve.get<(RawTask & { node?: string })[]>("/cluster/tasks", t).catch(() => []),
    Promise.all(online.map((n) => loadServerDetail(n, t).catch(() => null))),
    Promise.all(online.map((n) => storageMapFor(n, t, data).then((r) => r.map).catch(() => null))),
    readNetCheck(t),
    pve.get<Record<string, unknown>>("/cluster/options", t).catch((): Record<string, unknown> => ({})),
    pve.get<{ sid?: string }[]>("/cluster/ha/resources", t).catch(() => []),
    leftoverDisks(data.vms, t),
  ]);
  const cluster = status.find((x) => x.type === "cluster");
  const names = new Map(data.vms.map((v) => [String(v.id), v.name]));
  return buildHealth({
    nodes: data.nodes.map((n) => ({ name: n.name, online: n.online })),
    ...(cluster ? { cluster: { quorate: cluster.quorate === 1 } } : {}),
    votes: nodeConfig.map((n) => ({ node: n.node ?? "", votes: Number(n.quorum_votes ?? 1) })),
    tieBreaker: Object.keys(qdevice ?? {}).length > 0,
    network,
    ha: { policy: props(options.ha).shutdown_policy ?? "conditional", guests: haResources.filter((r) => /^(vm|ct):/.test(r.sid ?? "")).length },
    leftover,
    channels: details.flatMap((d) => (d?.channel ? [{ node: d.name, ...d.channel }] : [])),
    updates: details.flatMap((d) => (d?.updates ? [{ node: d.name, total: d.updates.total }] : [])),
    guests: data.vms,
    unscheduled: data.vms.filter((v) => v.issues.some((i) => i.kind === "no-backup")).map((v) => v.id),
    backupsElsewhere: preferences.backupsElsewhere,
    jobs: jobs.map((j) => ({ id: j.id ?? "", storage: j.storage ?? "", enabled: j.enabled !== 0 })),
    failedBackups: tasks
      .filter((x) => x.type === "vzdump" && x.status && x.status !== "OK" && (x.endtime ?? 0) > weekAgo)
      .sort((a, b) => (b.endtime ?? 0) - (a.endtime ?? 0))
      .map((x) => ({ node: x.node ?? "", guest: names.get(x.id ?? "") ?? "", at: x.endtime ?? 0 })),
    maps: maps.filter((m): m is NonNullable<typeof m> => m !== null),
    ownDhcp: ownAddressFromDhcp(),
    ...(HAS_VERSION ? { update: { ...updates.state, running: `version ${SHORT_VERSION}` } } : {}),
  });
}

/** Every leftover disk with its size, asked of the storage that holds it. A size it can't read is left as unknown. */
async function leftoverDisks(vms: Overview["vms"], ticket: string): Promise<Leftover[]> {
  const list = vms.flatMap((v) => v.leftover.map((d) => ({ vmid: v.id, guest: v.name, node: v.node, type: (v.type === "lxc" ? "lxc" : "qemu") as Leftover["type"], slot: d.slot, volume: d.volume })));
  return Promise.all(list.map(async (d) => {
    const storage = d.volume.split(":")[0] ?? "";
    const info = await pve.get<{ size?: number }>(`/nodes/${encodeURIComponent(d.node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(d.volume)}`, ticket).catch(() => null);
    return { ...d, sizeGb: info?.size ? Math.round((info.size / 1024 ** 3) * 10) / 10 : null };
  }));
}

/** Waits for a Proxmox task to finish, and fails with its own words if it didn't end OK. */
async function finishTask(node: string, upid: string, who: Identity, seconds: number) {
  const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`;
  for (let i = 0; i < seconds; i++) {
    const status = await pve.get<RawTaskStatus>(path, who.ticket);
    if (status.status === "stopped") {
      if (status.exitstatus !== "OK") throw new AuthError(400, `Proxmox stopped: ${status.exitstatus ?? "it didn't finish"}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new AuthError(504, "Proxmox is taking a long time. Check the node's activity, then look again.");
}

/**
 * Everything one node says about its disks and storage, asked in parallel (ADR 0014). A part the person's account
 * can't read comes back empty, so the map still shows what it can, with those pools under "disk not identified".
 */
async function loadStorageMap(name: string, session: Session) {
  return storageMapFor(name, session.ticket, await overview(session));
}
async function storageMapFor(name: string, t: string, data: Overview) {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const quiet = <T>(p: Promise<T>, fallback: T) => p.catch((err) => {
    if (err instanceof PveError && err.status === 401) throw err;
    return fallback;
  });
  const [disks, lvm, zfsList, directory, config, status, nodeStatus, seesAll] = await Promise.all([
    quiet(pve.get<RawDisk[]>(`${base}/disks/list?include-partitions=1`, t), []),
    quiet(pve.get<RawLvm>(`${base}/disks/lvm`, t), null),
    quiet(pve.get<{ name: string }[]>(`${base}/disks/zfs`, t), []),
    quiet(pve.get<RawMount[]>(`${base}/disks/directory`, t), []),
    pve.get<RawStorageConfig[]>("/storage", t),
    pve.get<RawStorageStatus[]>(`${base}/storage`, t),
    quiet(pve.get<{ rootfs?: { total?: number } }>(`${base}/status`, t), {}),
    seesAllGuests(t),
  ]);
  const zfsEntries = await Promise.all(zfsList.map(async (z) => [z.name, await quiet(pve.get<RawZfsDetail>(`${base}/disks/zfs/${encodeURIComponent(z.name)}`, t), {})] as const));
  const active = status.filter((s) => s.enabled !== 0 && s.active === 1);
  const unreadable: string[] = [];
  const contentEntries = await Promise.all(active.map(async (s) => [s.storage, await quiet(pve.get<RawVolume[]>(`${base}/storage/${encodeURIComponent(s.storage)}/content`, t), null).then((v) => {
    if (v === null) unreadable.push(s.storage);
    return v ?? [];
  })] as const));
  const map = buildStorageMap({
    node: name,
    disks,
    lvm,
    zfs: Object.fromEntries(zfsEntries),
    directory,
    config,
    status,
    rootfs: nodeStatus.rootfs ?? null,
    content: Object.fromEntries(contentEntries),
    contentUnknown: unreadable,
    passedThrough: passedThrough(name, data),
    guests: guestRefs(data),
    allNodesOnline: data.nodes.every((n) => n.online),
    seesAllGuests: seesAll,
  }, data.nodes.length > 1);
  return { map, diskList: readHardDisks(disks, passedThrough(name, data), eraseBlocker(guestRefs(data), seesAll)), config, directory };
}

/** Whether this account can see every guest. Without it, a guest it can't see looks like a deleted one. */
async function seesAllGuests(ticket: string): Promise<boolean> {
  const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2Fvms", ticket).catch((): Record<string, Record<string, number>> => ({}));
  return perms["/vms"]?.["VM.Audit"] === 1;
}

const guestRefs = (data: Overview): GuestRefs[] => data.vms.map((v) => ({ vmid: v.id, name: v.name, known: v.configLoaded, refs: v.refs }));

async function snapshotFixFor(node: string, path: string, ticket: string): Promise<string[]> {
  const [config, storages] = await Promise.all([pve.get<RawConfig>(`${path}/config`, ticket), pve.get<{ storage: string; type?: string }[]>(`/nodes/${encodeURIComponent(node)}/storage`, ticket)]);
  return snapshotFix(config as Parameters<typeof snapshotFix>[0], Object.fromEntries(storages.map((s) => [s.storage, s.type ?? ""])));
}

/** Whether a storage keeps VM disks as files, from the node's own list, which only shows what the person can use. */
async function keepsFiles(node: string, storage: string, ticket: string): Promise<boolean> {
  const list = await pve.get<{ storage: string; type?: string }[]>(`/nodes/${encodeURIComponent(node)}/storage`, ticket);
  return FILE_STORAGE.has(list.find((s) => s.storage === storage)?.type ?? "");
}

/** Everything BossMox can change on Proxmox is listed here. There is no general pass-through. */
const ACTIONS: Record<string, (name: string, who: Session, body: Record<string, unknown>) => Promise<string | null>> = {
  "check-updates": (name, who) => pve.post<string>(`/nodes/${encodeURIComponent(name)}/apt/update`, who),
  "update-channel": async (name, who, body) => {
    const target = body.channel;
    if (target !== "free" && target !== "enterprise") throw new AuthError(400, "That request isn't valid.");
    try {
      return await applyChannel({
        get: (p) => pve.get(p, who.ticket),
        put: (p, form) => pve.put(p, who, form),
        post: (p, form) => pve.post(p, who, form),
      }, name, target);
    } catch (err) {
      if (err instanceof ChannelError) throw new AuthError(400, err.message);
      throw err;
    }
  },
  "restart-server": async (name, who, body) => {
    // The browser only sends this after the person types "reboot", so a stray click can't restart a server.
    if (body.confirm !== "reboot") throw new AuthError(400, "The restart wasn't confirmed.");
    return pve.post<null>(`/nodes/${encodeURIComponent(name)}/status`, who, { command: "reboot" });
  },
  "move-guest": (name, who, body) => {
    const id = text(body.guest, 12);
    const target = text(body.target, 64);
    const type = body.type;
    if (!/^\d+$/.test(id) || !NODE_NAME.test(target) || (type !== "qemu" && type !== "lxc")) throw new AuthError(400, "That move request isn't valid.");
    if (body.confirm !== id) throw new AuthError(400, "The move wasn't confirmed.");
    const form: Record<string, string> = type === "qemu"
      ? { target, online: "1", "with-local-disks": "1" }
      : { target, restart: "1" };
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${type}/${id}/migrate`, who, form);
  },
  "move-off": async (name, who, body) => {
    // The browser sends this after the person has seen the plan and confirmed it for this node.
    if (body.confirm !== name) throw new AuthError(400, "The move wasn't confirmed.");
    return startMoveJob(who, async () => {
      const plan = await planEvacuation(who.ticket, name);
      if (plan.problems.length) throw new AuthError(400, plan.problems.join(" "));
      if (!plan.moves.length) return null;
      const batch = await batchFor(who.ticket);
      return (deps) => runMoveOff(moveRecord, deps, name, who.username, plan.moves, batch);
    });
  },
  "move-home": async (name, who, body) => {
    if (body.confirm !== name) throw new AuthError(400, "The move wasn't confirmed.");
    return startMoveJob(who, async () => {
      if (!moveRecord.away[name]?.guests.length) throw new AuthError(400, `BossMox has nothing recorded as moved off ${name}.`);
      const batch = await batchFor(who.ticket);
      return (deps) => runMoveHome(moveRecord, deps, name, who.username, batch);
    });
  },
  "run-start": (_name, who, body) => startRun(who, body),
  "run-stop": async (_name, who) => {
    if (!currentRun?.running) return null;
    // The person who started it, or anyone who can change the cluster's settings.
    if (currentRun.by !== who.username) {
      const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", who.ticket).catch((): Record<string, Record<string, number>> => ({}));
      if (!canChangeCluster(perms)) throw new AuthError(403, `Only ${currentRun.by}, or someone who can change the cluster's settings, can stop it.`);
    }
    currentRun.stop = `${who.username} pressed Stop.`;
    saveRun(currentRun);
    return null;
  },
  "move-stop": async (_name, who) => {
    const job = moveRecord.job;
    if (!job?.running) return null;
    if (job.by !== who.username) throw new AuthError(403, `Only ${job.by}, who started these moves, can stop them.`);
    // The move under way finishes; nothing new starts.
    moveJob.stop = `${who.username} pressed Stop.`;
    return null;
  },
  "guest-power": (name, who, body) => {
    const { id, path } = guestPath(name, body);
    const power = text(body.power, 16);
    if (!POWER.has(power)) throw new AuthError(400, "That request isn't valid.");
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    // Force off has to win over a shutdown that's stuck waiting for the guest.
    return pve.post<string>(`${path}/status/${power}`, who, power === "stop" ? { "overrule-shutdown": "1" } : {});
  },
  "update-check-now": async () => {
    // Anyone signed in may ask; the checker answers from its last look if that was under a minute ago.
    await updates.checkNow();
    return null;
  },
  "preferences-set": async (_name, who, body) => {
    const elsewhere = body.backupsElsewhere, check = body.updateCheck, keep = body.keepFreePct;
    if ((elsewhere !== undefined && typeof elsewhere !== "boolean") || (check !== undefined && typeof check !== "boolean") || (keep !== undefined && !(typeof keep === "number" && KEEP_FREE_CHOICES.includes(keep))) || (elsewhere === undefined && check === undefined && keep === undefined))
      throw new AuthError(400, "That request isn't valid.");
    // A cluster-wide choice needs the right to change the cluster's own settings in Proxmox (ADR 0018).
    const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", who.ticket).catch((): Record<string, Record<string, number>> => ({}));
    if (!canChangeCluster(perms)) throw new AuthError(403, "Your Proxmox account can't change settings for the whole cluster. That needs the Sys.Modify permission on the whole cluster (/).");
    const next = { ...preferences, ...(typeof elsewhere === "boolean" ? { backupsElsewhere: elsewhere } : {}), ...(typeof check === "boolean" ? { updateCheck: check } : {}), ...(typeof keep === "number" ? { keepFreePct: keep } : {}) };
    try {
      writePreferences(PREFERENCES_FILE, next);
    } catch {
      throw new AuthError(500, "BossMox couldn't save that setting. Nothing changed.");
    }
    const turned = next.updateCheck !== preferences.updateCheck;
    preferences = next;
    if (turned) await updates.setOn(next.updateCheck);
    preferencesEpoch += 1;
    return null;
  },
  "boot-on": async (_name, who, body) => {
    const ids = text(body.guests, 400);
    if (!/^\d+(,\d+)*$/.test(ids)) throw new AuthError(400, "That request isn't valid.");
    const data = await loadOverview(who.ticket);
    for (const id of ids.split(",").map(Number)) {
      const v = data.vms.find((g) => g.id === id);
      if (!v) continue;
      await pve.put<null>(`/nodes/${encodeURIComponent(v.node)}/${v.type}/${id}/config`, who, { onboot: "1" });
    }
    return null;
  },
  "recommended-set": async (_name, who, body) => {
    const id = body.id;
    if ((id !== "move-network" && id !== "move-limit" && id !== "ha-shutdown") || typeof body.on !== "boolean") throw new AuthError(400, "That request isn't valid.");
    const { options, net } = await readOptions(who.ticket);
    let form: Record<string, string>;
    try {
      form = optionsForm(id, body.on, text(body.choice, 43), options, net);
    } catch (err) {
      if (err instanceof RecommendedError) throw new AuthError(400, err.message);
      throw err;
    }
    await pve.put<null>("/cluster/options", who, form);
    audit("cluster-option", who.username, "settings", `${id}=${body.on ? "on" : "off"} ${Object.entries(form).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    // Health check reads these too, so its kept answer is out of date now.
    preferencesEpoch += 1;
    return null;
  },
  "leftover-remove": async (name, who, body) => {
    // Deletes one detached disk for good. The browser sends the volume the person saw; if the slot now holds
    // something else, nothing is removed.
    const { path } = guestPath(name, body);
    const slot = text(body.slot, 12);
    if (!/^unused\d+$/.test(slot)) throw new AuthError(400, "That request isn't valid.");
    const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
    const now = String(config[slot] ?? "").split(",")[0];
    if (!now || now !== body.confirm) throw new AuthError(400, "That disk has changed since BossMox looked. Check again, then remove it.");
    return pve.put<null>(`${path}/config`, who, { delete: slot });
  },
  "snapshot-fix": async (name, who, body) => {
    const { id, path } = guestPath(name, { ...body, type: "qemu" });
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    const status = await pve.get<{ status?: string }>(`${path}/status/current`, who.ticket);
    // Tested with the VM shut down. Converting the firmware and TPM disks of a running VM isn't something to try.
    if (status.status !== "stopped") throw new AuthError(400, "Shut it down first.");
    const slots = await snapshotFixFor(name, path, who.ticket);
    if (!slots.length) throw new AuthError(400, "Converting its disks wouldn't make snapshots work, so nothing was changed.");
    const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
    for (const disk of slots) {
      const storage = String(config[disk]).split(":")[0] ?? "";
      await finishTask(name, await pve.post<string>(`${path}/move_disk`, who, { disk, storage, format: "qcow2", delete: "1" }), who, 900);
    }
    return null;
  },
  "snapshot-take": (name, who, body) => {
    const { path } = guestPath(name, body);
    const snapname = snapshotName(body);
    const description = text(body.description, 200);
    return pve.post<string>(`${path}/snapshot`, who, description ? { snapname, description } : { snapname });
  },
  "snapshot-restore": (name, who, body) => {
    const { path } = guestPath(name, body);
    const snap = snapshotName(body);
    // The browser only sends this after the person types "restore", because newer changes are lost.
    if (body.confirm !== "restore") throw new AuthError(400, "That wasn't confirmed.");
    return pve.post<string>(`${path}/snapshot/${snap}/rollback`, who, body.start === true ? { start: "1" } : {});
  },
  "snapshot-delete": (name, who, body) => {
    const { path } = guestPath(name, body);
    const snap = snapshotName(body);
    if (body.confirm !== snap) throw new AuthError(400, "That wasn't confirmed.");
    return pve.delete<string>(`${path}/snapshot/${snap}`, who);
  },
  "guest-create": async (name, who, body) => {
    const kind = body.kind;
    if (kind !== "qemu" && kind !== "lxc") throw new AuthError(400, "That request isn't valid.");
    const input: CreateInput = {
      id: text(body.id, 12),
      name: text(body.name, 63),
      cores: Number(body.cores),
      memoryMb: Number(body.memoryMb),
      diskGb: Number(body.diskGb),
      storage: text(body.storage, 64),
      bridge: text(body.bridge, 64),
      installer: text(body.installer, 256),
      os: text(body.os, 16),
      start: body.start === true,
      password: text(body.password, 128),
      fileStorage: kind === "qemu" && (await keepsFiles(name, text(body.storage, 64), who.ticket)),
    };
    try {
      const form = kind === "qemu" ? vmForm(input) : containerForm(input);
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${kind}`, who, form);
    } catch (err) {
      if (err instanceof CreateError) throw new AuthError(400, err.message);
      throw err;
    }
  },
  "guest-settings": async (name, who, body) => {
    const { path } = guestPath(name, body);
    if (typeof body.changes !== "object" || body.changes === null || Array.isArray(body.changes)) throw new AuthError(400, "That request isn't valid.");
    const [config, status] = await Promise.all([pve.get<RawConfig>(`${path}/config`, who.ticket), pve.get<{ status?: string }>(`${path}/status/current`, who.ticket)]);
    try {
      await pve.put<null>(`${path}/config`, who, changesForm(kindOf(body), config, body.changes as Record<string, unknown>, status.status === "running"));
      return null;
    } catch (err) {
      if (err instanceof SettingsError) throw new AuthError(400, err.message);
      throw err;
    }
  },
  /**
   * Proxmox has no "stop at the boot menu" setting, so this presses the key at the right moment. BIOS opens its
   * menu on Esc and also closes it on Esc, so it gets exactly one press. The moment is only dependable after a
   * reset, so a shut-down VM is started and then reset. UEFI ignores repeats of F2, so it's pressed throughout.
   */
  "guest-boot-menu": async (name, who, body) => {
    const { id, path } = guestPath(name, { ...body, type: "qemu" });
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    const [current, config] = await Promise.all([pve.get<{ status?: string }>(`${path}/status/current`, who.ticket), pve.get<RawConfig>(`${path}/config`, who.ticket)]);
    const uefi = config.bios === "ovmf";
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const reset = () => pve.post<string | null>(`${path}/status/reset`, who);
    if (current.status === "running") await reset();
    else {
      const task = await pve.post<string>(`${path}/status/start`, who);
      const taskPath = `/nodes/${encodeURIComponent(name)}/tasks/${encodeURIComponent(task)}/status`;
      for (let i = 0; i < 60; i++) {
        const status = await pve.get<RawTaskStatus>(taskPath, who.ticket);
        if (status.status === "stopped") {
          if (status.exitstatus !== "OK") throw new AuthError(400, status.exitstatus ?? "It wouldn't start.");
          break;
        }
        await wait(250);
      }
      // Proxmox doesn't answer for a VM that's only just started, so it gets a few seconds before the reset.
      await wait(BIOS_SETTLE_MS);
      for (let i = 0; ; i++) {
        const done = await reset().then(() => true, () => false);
        if (done) break;
        if (i === 12) throw new AuthError(400, "It started, but wouldn't restart to the boot menu.");
        await wait(1000);
      }
    }
    if (uefi) {
      // A VM still starting can refuse a key, which only means pressing again.
      const until = Date.now() + UEFI_WINDOW_MS;
      while (Date.now() < until) {
        await pve.put<null>(`${path}/sendkey`, who, { key: "f2" }).catch(() => null);
        await wait(UEFI_GAP_MS);
      }
      return null;
    }
    await wait(BIOS_ESC_AFTER_MS);
    await pve.put<null>(`${path}/sendkey`, who, { key: "esc" });
    return null;
  },
  "guest-disc": async (name, who, body) => {
    const { path } = guestPath(name, body);
    if (typeof body.disc !== "string" || body.disc.length > 256) throw new AuthError(400, "That disc isn't valid.");
    const slot = body.slot === undefined ? "ide2" : text(body.slot, 12);
    const current = await pve.get<RawConfig>(`${path}/config`, who.ticket);
    try {
      await pve.put<null>(`${path}/config`, who, discForm(body.disc, current, slot));
      return null;
    } catch (err) {
      if (err instanceof CreateError) throw new AuthError(400, err.message);
      throw err;
    }
  },
  "disc-download": (name, who, body) => {
    const storage = text(body.storage, 64);
    if (!STORAGE.test(storage)) throw new AuthError(400, "That request isn't valid.");
    try {
      const { url, filename } = discDownload(text(body.url, 1024));
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}/download-url`, who, { content: "iso", url, filename });
    } catch (err) {
      if (err instanceof CreateError) throw new AuthError(400, err.message);
      throw err;
    }
  },
  "storage-add": async (name, who, body) => {
    const form = rule(() => networkForm({ kind: text(body.kind, 8), id: text(body.id, 64), host: text(body.host, 253), path: text(body.path, 255), username: text(body.username, 64), password: text(body.password, 256), domain: text(body.domain, 64), uses: body.uses }));
    await pve.post<null>("/storage", who, form);
    // Saving doesn't prove it works, so ask a node to use it. One that can't connect isn't left behind.
    const path = `/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(form.storage as string)}/status`;
    for (let i = 0; i < 8; i++) {
      const status = await pve.get<{ active?: number }>(path, who.ticket).catch(() => null);
      if (status?.active === 1) return null;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await pve.delete<null>(`/storage/${encodeURIComponent(form.storage as string)}`, who).catch(() => null);
    throw new AuthError(400, `${name} couldn't connect to that share, so it wasn't added. Check that the NAS lets this node in.`);
  },
  "content-delete": async (name, who, body) => {
    const storage = text(body.storage, 64);
    const volid = text(body.volid, 300);
    if (!STORAGE.test(storage) || !volid || body.confirm !== volid) throw new AuthError(400, "That wasn't confirmed.");
    const base = `/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}`;
    // Fresh, not the cached overview: a guest made a moment ago must count.
    const [volumes, data] = await Promise.all([pve.get<RawVolume[]>(`${base}/content`, who.ticket), loadOverview(who.ticket)]);
    const item = poolItems(volumes, guestRefs(data), data.nodes.every((n) => n.online), await seesAllGuests(who.ticket)).find((i) => i.volid === volid);
    if (!item) throw new AuthError(400, `That isn't on ${storage} anymore.`);
    if (!item.canDelete) throw new AuthError(400, item.whyNot);
    return pve.delete<string>(`${base}/content/${encodeURIComponent(volid)}`, who);
  },
  "storage-setup": async (name, who, body) => {
    if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
    const devices = usesStorageNames(body.devices);
    const poolName = text(body.name, 32);
    const node = encodeURIComponent(name);
    const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
    const plan = rule(() => setupPlan(disks, devices, text(body.purpose, 8), poolName));
    const configs = await pve.get<RawStorageConfig[]>("/storage", who.ticket);
    if (configs.some((c) => c.storage === poolName)) throw new AuthError(400, `There's already storage called ${poolName}. Pick another name.`);
    // A drive with old data is wiped first, the same strict check as Wipe, then the pool is made on the clean drives.
    for (const disk of plan.wipe) {
      rule(() => assertCanWipe(disks, disk));
      await finishTask(name, await pve.put<string>(`/nodes/${node}/disks/wipedisk`, who, { disk }), who, 120);
    }
    const fresh = plan.wipe.length ? await nodeDisks(name, who.ticket, await loadOverview(who.ticket)) : disks;
    const form = rule(() => diskStorageForm(plan.kind, fresh, { name: poolName, devices, raid: plan.raid, filesystem: plan.filesystem }));
    await finishTask(name, await pve.post<string>(`/nodes/${node}/disks/${plan.kind}`, who, form), who, 300);
    // What it's for. Proxmox gives a new folder every use, which isn't what the person picked.
    await pve.put<null>(`/storage/${encodeURIComponent(poolName)}`, who, { content: plan.uses });
    return null;
  },
  "pool-delete": async (name, who, body) => {
    const id = text(body.storage, 64);
    if (!STORAGE.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    const [data, jobs] = await Promise.all([loadOverview(who.ticket), pve.get<{ storage?: string }[]>("/cluster/backup", who.ticket)]);
    const { map, config, directory } = await storageMapFor(name, who.ticket, data);
    const usedBy = storageBlockers(id, data.vms, jobs);
    let removal: { path: string; disks: string[] };
    try {
      removal = poolRemoval(map, id, config.find((c) => c.storage === id), directory, usedBy);
    } catch (err) {
      throw new AuthError(400, (err as Error).message);
    }
    return pve.delete<string>(`/nodes/${encodeURIComponent(name)}/${removal.path}`, who);
  },
  "storage-edit": async (_name, who, body) => {
    const id = text(body.id, 64);
    if (!STORAGE.test(id)) throw new AuthError(400, "That storage isn't valid.");
    const list = await pve.get<RawStorageConfig[]>("/storage", who.ticket);
    const found = list.find((s) => s.storage === id);
    if (!found) throw new AuthError(400, "That storage doesn't exist.");
    await pve.put<null>(`/storage/${encodeURIComponent(id)}`, who, { content: rule(() => usesForm(found.type ?? "", body.uses, found.content ?? "")) });
    return null;
  },
  "storage-remove": async (_name, who, body) => {
    const id = text(body.id, 64);
    if (!STORAGE.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    const [data, jobs] = await Promise.all([loadOverview(who.ticket), pve.get<{ storage?: string }[]>("/cluster/backup", who.ticket)]);
    const using = storageBlockers(id, data.vms, jobs);
    if (using.length) throw new AuthError(400, `${id} is still in use by ${using.join(", ")}.`);
    await pve.delete<null>(`/storage/${encodeURIComponent(id)}`, who);
    return null;
  },
  "disk-storage": async (name, who, body) => {
    if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
    const kind = text(body.kind, 12);
    const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
    const form = rule(() => diskStorageForm(kind, disks, { name: text(body.name, 32), devices: usesStorageNames(body.devices), raid: text(body.raid, 8), filesystem: text(body.filesystem, 8) }));
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/disks/${kind}`, who, form);
  },
  "disk-wipe": async (name, who, body) => {
    const disk = text(body.disk, 64);
    if (body.confirm !== "erase" || !deviceIsValid(disk)) throw new AuthError(400, "That wasn't confirmed.");
    const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
    rule(() => assertCanWipe(disks, disk));
    return pve.put<string>(`/nodes/${encodeURIComponent(name)}/disks/wipedisk`, who, { disk });
  },
  "disk-grow": async (name, who, body) => {
    const { path } = guestPath(name, body);
    const form = await withConfig(path, who, (c) => growForm(kindOf(body), c, text(body.disk, 16), Number(body.addGb)));
    return (await pve.put<string | null>(`${path}/resize`, who, form)) ?? null;
  },
  "disk-add": async (name, who, body) => {
    const { path } = guestPath(name, body);
    const fileStorage = kindOf(body) === "qemu" && (await keepsFiles(name, text(body.storage, 64), who.ticket));
    const form = await withConfig(path, who, (c) => addDiskForm(kindOf(body), c, { storage: text(body.storage, 64), sizeGb: Number(body.sizeGb), mount: text(body.mount, 200), fileStorage }));
    await pve.put<null>(`${path}/config`, who, form);
    return null;
  },
  "disk-remove": async (name, who, body) => {
    const { path } = guestPath(name, body);
    // This one erases data, so it needs the typed word, and the disk is cleared rather than left detached.
    if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
    const slot = text(body.disk, 16);
    const before = await withConfig(path, who, (c) => ({ config: c, form: removeDiskForm(kindOf(body), c, slot) }));
    const volume = String(before.config[slot]).split(",")[0];
    await pve.put<null>(`${path}/config`, who, before.form);
    const after = await pve.get<RawConfig>(`${path}/config`, who.ticket);
    const unused = Object.entries(after).find(([k, v]) => /^unused\d+$/.test(k) && String(v) === volume)?.[0];
    if (unused) await pve.put<null>(`${path}/config`, who, { delete: unused });
    return null;
  },
  "nic-add": async (name, who, body) => {
    const { path } = guestPath(name, body);
    const form = await withConfig(path, who, (c) => addNicForm(kindOf(body), c, { bridge: text(body.bridge, 32), vlan: text(body.vlan, 4) }));
    await pve.put<null>(`${path}/config`, who, form);
    return null;
  },
  "guest-address": async (name, who, body) => {
    const { path } = guestPath(name, body);
    if (kindOf(body) !== "lxc") throw new AuthError(400, "Only a container's address can be set from here. A VM sets its own, inside the VM.");
    const slot = text(body.nic, 8);
    if (body.confirm !== slot) throw new AuthError(400, "That wasn't confirmed.");
    const form = await withConfig(path, who, (c) => {
      // Moving the container BossMox runs in would cut off everyone using it, this page included.
      const mine = ownAddresses();
      const configured = part(String(c[slot] ?? ""), "ip").split("/")[0] ?? "";
      if (mine.has(configured)) throw new HardwareError("This container is BossMox itself. Changing its address here would cut you off, so it isn't offered.");
      return addressForm(c, slot, { mode: text(body.mode, 8), address: text(body.address, 20), gateway: text(body.gateway, 16) });
    });
    const live = await pve.get<{ inet?: string }[]>(`${path}/interfaces`, who.ticket).catch(() => []);
    if (live.some((i) => ownAddresses().has(String(i.inet ?? "").split("/")[0] ?? ""))) throw new AuthError(400, "This container is BossMox itself. Changing its address here would cut you off, so it isn't offered.");
    await pve.put<null>(`${path}/config`, who, form);
    return null;
  },
  "nic-remove": async (name, who, body) => {
    const { path } = guestPath(name, body);
    if (body.confirm !== text(body.nic, 8)) throw new AuthError(400, "That wasn't confirmed.");
    const form = await withConfig(path, who, (c) => removeNicForm(c, text(body.nic, 8)));
    await pve.put<null>(`${path}/config`, who, form);
    return null;
  },
  "guest-clone": async (name, who, body) => {
    const { path } = guestPath(name, body);
    const newName = text(body.name, 63);
    const storage = text(body.storage, 64);
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(newName)) throw new AuthError(400, "A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
    if (!STORAGE.test(storage)) throw new AuthError(400, "Pick a storage.");
    const newid = String(await pve.get<string | number>("/cluster/nextid", who.ticket));
    return pve.post<string>(`${path}/clone`, who, { newid, full: "1", storage, [kindOf(body) === "qemu" ? "name" : "hostname"]: newName });
  },
  "guest-template": async (name, who, body) => {
    const { path } = guestPath(name, body);
    // There's no way back from this short of cloning it, so it gets the typed word too.
    if (body.confirm !== "template") throw new AuthError(400, "That wasn't confirmed.");
    return (await pve.post<string | null>(`${path}/template`, who)) ?? null;
  },
  "template-download": (name, who, body) => {
    const storage = text(body.storage, 64);
    const template = text(body.template, 200);
    if (!STORAGE.test(storage) || !/^[\w.+-]+$/.test(template)) throw new AuthError(400, "That request isn't valid.");
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/aplinfo`, who, { storage, template });
  },
  "guest-delete": async (name, who, body) => {
    const { id, path } = guestPath(name, body);
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    const clones = clonesOf(Number(id), (await loadOverview(who.ticket)).vms);
    if (clones.length) throw new AuthError(400, `${clones.join(", ")} ${clones.length === 1 ? "was" : "were"} made from this template and still ${clones.length === 1 ? "needs" : "need"} it. Delete ${clones.length === 1 ? "that clone" : "those clones"} first.`);
    return pve.delete<string>(`${path}?purge=1`, who);
  },
  "backup-restore": async (name, who, body) => {
    const volid = text(body.volid, 256);
    const storage = text(body.storage, 64);
    const type = body.type;
    const id = text(body.guest, 12);
    if (!VOLUME.test(volid) || !STORAGE.test(storage) || !/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) throw new AuthError(400, "That restore request isn't valid.");
    const replace = body.replace === true;
    // Replacing erases the guest as it is now, so it needs its own typed word.
    if (replace && body.confirm !== "replace") throw new AuthError(400, "That wasn't confirmed.");
    const form: Record<string, string> = { vmid: id, storage };
    if (replace) form.force = "1";
    else form.unique = "1";
    const copyName = text(body.name, 63);
    if (!replace && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(copyName)) form[type === "qemu" ? "name" : "hostname"] = copyName;
    if (type === "qemu") form.archive = volid;
    else Object.assign(form, { ostemplate: volid, restore: "1" });
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${type}`, who, form);
  },
  "backup-delete": (name, who, body) => {
    const volid = text(body.volid, 256);
    const storage = text(body.storage, 64);
    if (!VOLUME.test(volid) || !STORAGE.test(storage)) throw new AuthError(400, "That request isn't valid.");
    if (body.confirm !== volid) throw new AuthError(400, "That wasn't confirmed.");
    return pve.delete<string>(`/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`, who);
  },
  "schedule-add": async (_name, who, body) => {
    const schedule = text(body.schedule, 16);
    const storage = text(body.storage, 64);
    const guests = text(body.guests, 256);
    const keep = Number(body.keep);
    if (!SCHEDULE.test(schedule) || !STORAGE.test(storage) || !Number.isInteger(keep) || keep < 1 || keep > 99) throw new AuthError(400, "That schedule isn't valid.");
    if (guests !== "all" && !/^\d+(,\d+)*$/.test(guests)) throw new AuthError(400, "That schedule isn't valid.");
    await pve.post<null>("/cluster/backup", who, { schedule, storage, mode: "snapshot", compress: "zstd", enabled: "1", "prune-backups": `keep-last=${keep}`, ...(guests === "all" ? { all: "1" } : { vmid: guests }) });
    return null;
  },
  "schedule-toggle": async (_name, who, body) => {
    const id = text(body.job, 64);
    if (!JOB_ID.test(id) || typeof body.on !== "boolean") throw new AuthError(400, "That request isn't valid.");
    await pve.put<null>(`/cluster/backup/${encodeURIComponent(id)}`, who, { enabled: body.on ? "1" : "0" });
    return null;
  },
  "schedule-delete": async (_name, who, body) => {
    const id = text(body.job, 64);
    if (!JOB_ID.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    await pve.delete<null>(`/cluster/backup/${encodeURIComponent(id)}`, who);
    return null;
  },
  "back-up-guests": (name, who, body) => {
    const vmid = text(body.guests, 256);
    const storage = text(body.storage, 64);
    if (!/^\d+(,\d+)*$/.test(vmid) || !/^[\w.-]+$/.test(storage)) throw new AuthError(400, "That backup request isn't valid.");
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/vzdump`, who, { vmid, storage, mode: "snapshot", compress: "zstd" });
  },
};

async function openNodeTerminal(res: http.ServerResponse, name: string, session: Session, form: Record<string, string>) {
  const proxy = await pve.post<TermProxy>(`/nodes/${encodeURIComponent(name)}/termproxy`, session, form);
  return json(res, 200, { terminal: terminals.prepare(name, session, proxy, { outputCounts: form.cmd === "upgrade" }) });
}

async function openConsole(res: http.ServerResponse, body: Record<string, unknown>, session: Session) {
  const name = text(body.server, 64);
  if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
  const { path } = guestPath(name, body);
  if (body.type === "lxc") {
    const proxy = await pve.post<TermProxy>(`${path}/termproxy`, session);
    return json(res, 200, { terminal: terminals.prepare(name, session, proxy, { path }) });
  }
  // The VNC ticket is the one Proxmox secret the browser sees: noVNC needs it as the screen's password. It works
  // only with this session's cookie, for this VM, and expires in seconds.
  const proxy = await pve.post<TermProxy>(`${path}/vncproxy`, session, { websocket: "1" });
  return json(res, 200, { screen: terminals.prepare(name, session, proxy, { path, raw: true }), password: proxy.ticket });
}

/**
 * Answers a Proxmox refusal the same way for every write: no permission, signed out (which ends the BossMox session
 * too), or Proxmox's reason in plain words. Returns false for anything else, which the caller rethrows.
 */
function answerPveError(res: http.ServerResponse, sessionId: string | undefined, err: unknown) {
  if (!(err instanceof PveError)) return false;
  if (err.status === 403) return json(res, 403, { error: "Your Proxmox account doesn't have permission to do that." });
  if (err.status === 401) {
    sessions.end(sessionId);
    return json(res, 401, { error: "Sign in to continue." });
  }
  if (err.reason) {
    const plain = plainError(err.reason);
    return json(res, 400, { error: plain === err.reason.trim() ? `Proxmox refused: ${plain}` : plain });
  }
  return false;
}

async function runAction(req: http.IncomingMessage, res: http.ServerResponse, action: string) {
  // The body comes first. A slow upload shouldn't leave a checked session in hand while it's signed out.
  const body = await readJson(req);
  const id = cookieId(req);
  const session = await sessions.get(id);
  if (!session) return json(res, 401, { error: "Sign in to continue." });
  try {
    if (action === "guest-console") {
      audit("console", session.username, addressOf(req), `node=${text(body.server, 64)} guest=${text(body.guest, 12)}`);
      return await openConsole(res, body, session);
    }
    const name = text(body.server, 64);
    if (action === "install-updates" || action === "node-console") {
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      audit(action === "install-updates" ? "updater" : "console", session.username, addressOf(req), `node=${name}`);
      return await openNodeTerminal(res, name, session, action === "install-updates" ? { cmd: "upgrade" } : {});
    }
    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) return json(res, 404, { error: "BossMox doesn't have that action." });
    if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
    const task = await run(name, session, body);
    // No task means it's already done, so nothing else will clear the old view of it.
    if (!task) cache.delete(session);
    audit(action, session.username, addressOf(req), `node=${name}${text(body.guest, 12) ? ` guest=${text(body.guest, 12)}` : ""}`);
    return json(res, 200, { task });
  } catch (err) {
    if (answerPveError(res, id, err) === false) throw err;
  }
}

const stripPort = hostName;
const hostAllowed = (header = "") => config.allowedHosts.has(stripPort(header));

/** Only this app's own pages can post here: browsers won't add this header across sites without permission. */
function sameSite(req: http.IncomingMessage): boolean {
  if (req.headers["x-bossmox"] !== "1") return false;
  const origin = req.headers.origin;
  // Browsers always send Origin on these requests, so a request without one isn't coming from a web page.
  if (!origin) return true;
  return sameOrigin(origin, req.headers.host, secureCookie, proxiedNames);
}

function cookieId(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v;
  }
  return undefined;
}
function setCookie(id: string, maxAge: number): Record<string, string> {
  return { "Set-Cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}` };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AuthError(413, "That request was too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new AuthError(400, "That request couldn't be read."));
      }
    });
  });
}
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : "");

/** Who did what, for anyone looking into an incident. Names and addresses only, never tickets, passwords or request bodies. */
function audit(event: string, who: string, address: string, detail = "") {
  // Some of this comes from the request, so nothing in it gets to start a new line or colour a terminal.
  const line = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
  console.log(`audit ${new Date().toISOString()} ${event} user=${line(who).replace(/ /g, "?")} from=${line(address).replace(/ /g, "?")}${detail ? ` ${line(detail)}` : ""}`);
}
let lastLockoutLog = 0;
/** A lockout can be hammered, and one line every 10 seconds says all it needs to without filling a small disk. */
function auditRefused(event: string, who: string, address: string, status: number) {
  if (status === 429) {
    if (Date.now() - lastLockoutLog < 10000) return;
    lastLockoutLog = Date.now();
  }
  audit(event, who, address, `status=${status}`);
}
function addressOf(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  return clientAddress(req.socket.remoteAddress, Array.isArray(forwarded) ? forwarded.join(",") : forwarded, config.trustedProxies);
}

function finishLogin(res: http.ServerResponse, out: LoginOutcome, address: string) {
  if (out.kind === "code") return json(res, 200, { needsCode: true, challenge: out.id });
  audit("sign-in", out.username, address);
  return json(res, 200, { username: out.username }, setCookie(out.id, 12 * 60 * 60));
}

/**
 * A POST because SMB needs a password. Proxmox's own scan takes it in the address, which lands in that node's
 * access log, but only root can read that log, and root can already read the saved storage passwords.
 */
async function scanShares(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  const id = cookieId(req);
  const session = await sessions.get(id);
  if (!session) return json(res, 401, { error: "Sign in to continue." });
  const name = text(body.server, 64);
  const host = text(body.host, 253);
  const kind = text(body.kind, 8);
  if (!NODE_NAME.test(name) || !hostIsValid(host) || (kind !== "nfs" && kind !== "smb")) return json(res, 400, { error: "That address isn't valid." });
  const base = `/nodes/${encodeURIComponent(name)}/scan`;
  const query = new URLSearchParams({ server: host });
  if (text(body.username, 64)) query.set("username", text(body.username, 64));
  if (text(body.password, 256)) query.set("password", text(body.password, 256));
  if (text(body.domain, 64)) query.set("domain", text(body.domain, 64));
  try {
    if (kind === "nfs") {
      const found = await pve.get<{ path: string }[]>(`${base}/nfs?${query}`, session.ticket);
      return json(res, 200, { shares: found.map((f) => f.path) });
    }
    const found = await pve.get<{ share: string }[]>(`${base}/cifs?${query}`, session.ticket);
    return json(res, 200, { shares: found.map((f) => f.share).filter((s) => !s.endsWith("$")) });
  } catch (err) {
    // Signed out is answered like any other action (#53). Any other refusal means nothing was found there.
    if (err instanceof PveError && err.status === 401) return answerPveError(res, id, err);
    if (err instanceof PveError) return json(res, 200, { shares: null });
    throw err;
  }
}

/** The one POST that isn't JSON: a file, passed straight through to Proxmox as it arrives. */
async function upload(req: http.IncomingMessage, res: http.ServerResponse) {
  const id = cookieId(req);
  const session = await sessions.get(id);
  if (!session) return json(res, 401, { error: "Sign in to continue." });
  const params = new URL(req.url ?? "/", "http://local").searchParams;
  const name = params.get("server") ?? "";
  const storage = params.get("storage") ?? "";
  const filename = params.get("filename") ?? "";
  const size = Number(req.headers["content-length"]);
  if (!NODE_NAME.test(name) || !STORAGE.test(storage)) return json(res, 400, { error: "That upload isn't valid." });
  if (!UPLOAD_NAME.test(filename)) return json(res, 400, { error: "That has to be an .iso or .img file, with a plain file name." });
  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD) return json(res, 400, { error: "That file is too large." });
  audit("upload", session.username, addressOf(req), `node=${name} storage=${storage} file=${filename} bytes=${size}`);
  try {
    const task = await pve.upload(`/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}/upload`, session, { content: "iso" }, { name: filename, size, stream: req });
    return json(res, 200, { task });
  } catch (err) {
    // An expired sign-in ends the session here too, instead of a 502 that leaves it looking alive (#53).
    if (answerPveError(res, id, err) === false) throw err;
  }
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
  if (!sameSite(req)) return json(res, 403, { error: "This request didn't come from BossMox." });
  const address = addressOf(req);
  if (route === "/api/login") {
    const body = await readJson(req);
    const user = text(body.username, 128);
    const realm = text(body.realm, 64);
    const password = text(body.password, 512);
    if (!user || !realm || !password) return json(res, 400, { error: "Enter your username and password." });
    if (!/^[\w.@+-]+$/.test(user) || !/^[\w.-]+$/.test(realm)) return json(res, 401, { error: "Wrong username or password." });
    try {
      return finishLogin(res, await sessions.login(`${user}@${realm}`, password, address), address);
    } catch (err) {
      if (err instanceof AuthError) auditRefused("sign-in-refused", `${user}@${realm}`, address, err.status);
      throw err;
    }
  }
  if (route === "/api/login/code") {
    const body = await readJson(req);
    const code = text(body.code, 32).replace(/\s/g, "");
    const challenge = text(body.challenge, 128);
    if (!/^\d{6,8}$/.test(code) || !challenge) return json(res, 400, { error: "Enter the code from your authenticator app." });
    try {
      return finishLogin(res, await sessions.submitCode(challenge, code, address), address);
    } catch (err) {
      if (err instanceof AuthError) auditRefused("code-refused", "unknown", address, err.status);
      throw err;
    }
  }
  if (route === "/api/logout") {
    audit("sign-out", sessions.end(cookieId(req)) ?? "unknown", address);
    return json(res, 200, { ok: true }, setCookie("", 0));
  }
  if (route === "/api/upload") return upload(req, res);
  if (route === "/api/storage-scan") return scanShares(req, res);
  if (route.startsWith("/api/action/")) return runAction(req, res, route.slice("/api/action/".length));
  return json(res, 404, { error: "Not found." });
}

const handler: http.RequestListener = async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) {
      return json(res, 403, { error: "This host name isn't allowed. Add it to BOSSMOX_ALLOWED_HOSTS." });
    }
    // A target that can't be read as a path ("//") is the client's mistake, not Proxmox's: 400, not 502.
    const route = requestPath(req.url);
    if (route === null) return json(res, 400, { error: "That address isn't valid." });
    if (req.method === "POST") return await handlePost(req, res, route);
    if (req.method !== "GET") return json(res, 405, { error: "That method isn't allowed." });
    if (route === "/healthz") return json(res, 200, { ok: true });
    if (route === "/api/login-info") {
      // Anyone can ask this, so a flood of them shouldn't become a flood at Proxmox.
      if (Date.now() - realmsAt > 60 * 1000) {
        realms = await pve.get<{ realm: string; comment?: string; default?: number }[]>("/access/domains");
        realmsAt = Date.now();
      }
      return json(res, 200, { realms });
    }
    if (route === "/api/usage" || route === "/api/overview" || route === "/api/server" || route === "/api/task" || route === "/api/reboot-plan" || route === "/api/move-plan" || route === "/api/rolling-plan" || route === "/api/moves" || route === "/api/run" || route === "/api/run-plan" || route === "/api/snapshot-support" || route === "/api/backups" || route === "/api/restore-plan" || route === "/api/create-plan" || route === "/api/network" || route === "/api/guest-addresses" || route === "/api/templates" || route === "/api/tasks" || route === "/api/storage-list" || route === "/api/disks" || route === "/api/disk-smart" || route === "/api/storage-map" || route === "/api/health" || route === "/api/setup-plan" || route === "/api/guest-waiting" || route === "/api/cpu-types" || route === "/api/recommended") {
      const id = cookieId(req);
      const session = await sessions.get(id);
      if (!session) return json(res, 401, { error: "Sign in to continue." });
      try {
        const params = new URL(req.url ?? "/", "http://local").searchParams;
        if (route === "/api/task") {
          const name = params.get("server") ?? "";
          const upid = params.get("task") ?? "";
          if (!NODE_NAME.test(name) || !UPID.test(upid)) return json(res, 400, { error: "That task isn't valid." });
          const base = `/nodes/${encodeURIComponent(name)}/tasks/${encodeURIComponent(upid)}`;
          // The whole log is only for someone reading it. Following a running task needs just the end.
          const lines = params.get("full") === "1" ? FULL_LOG : 1000;
          const [status, log] = await Promise.all([
            pve.get<RawTaskStatus>(`${base}/status`, session.ticket),
            pve.get<{ n?: number; t?: string }[]>(`${base}/log?limit=${lines}`, session.ticket),
          ]);
          const view = taskView(status, log, lines === FULL_LOG ? FULL_LOG : 200);
          // What the task changed should show right away, not after the cache runs out.
          if (view.finished) cache.delete(session);
          return json(res, 200, view);
        }
        if (route === "/api/move-plan") {
          const name = params.get("server") ?? "";
          const id = params.get("guest") ?? "";
          const type = params.get("type");
          if (!NODE_NAME.test(name) || !/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) return json(res, 400, { error: "That move request isn't valid." });
          const data = await overview(session);
          const nodes = data.nodes.filter((n) => n.online).map((n) => n.name);
          const raw = type === "qemu"
            ? await pve.get<RawMovePrecondition>(`/nodes/${encodeURIComponent(name)}/qemu/${id}/migrate`, session.ticket)
            : {};
          const running = data.vms.find((v) => v.id === Number(id))?.running ?? false;
          return json(res, 200, buildMovePlan(type, name, nodes, raw, running));
        }
        if (route === "/api/rolling-plan") return json(res, 200, await loadRollingPlan(session.ticket));
        if (route === "/api/backups") return json(res, 200, await loadBackups(session.ticket));
        if (route === "/api/recommended") return json(res, 200, { settings: await loadRecommended(session) });
        if (route === "/api/cpu-types") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const list = await pve.get<{ name?: string }[]>(`/nodes/${encodeURIComponent(name)}/capabilities/qemu/cpu`, session.ticket);
          return json(res, 200, { types: list.flatMap((c) => (c.name ? [c.name] : [])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
        }
        if (route === "/api/guest-waiting") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const type = params.get("type") === "lxc" ? "lxc" : "qemu";
          const { path } = guestPath(name, { guest: params.get("guest"), type });
          return json(res, 200, { waiting: waitingChanges(await pve.get<Parameters<typeof waitingChanges>[0]>(`${path}/pending`, session.ticket)) });
        }
        if (route === "/api/storage-list") {
          const [config, data] = await Promise.all([pve.get<RawStorageConfig[]>("/storage", session.ticket), overview(session)]);
          // Asked of each node directly: the cluster summary takes a while to notice a storage that was just added.
          const online = data.nodes.filter((n) => n.online).map((n) => n.name);
          const lists = await Promise.allSettled(online.map((n) => pve.get<(RawStorage & { total?: number })[]>(`/nodes/${encodeURIComponent(n)}/storage`, session.ticket)));
          const usage = online.flatMap((node, i) => {
            const r = lists[i];
            return r?.status === "fulfilled" ? r.value.filter((s) => s.enabled !== 0).map((s) => ({ name: s.storage, node, freeGb: (s.avail ?? 0) / 1024 ** 3, totalGb: (s.total ?? 0) / 1024 ** 3, online: s.active === 1 })) : [];
          });
          return json(res, 200, { list: buildStorageList(config, usage) });
        }
        if (route === "/api/health") {
          const hit = healthCache.get(session);
          const fresh = params.get("again") !== "1" && hit && hit.epoch === preferencesEpoch && Date.now() - hit.at <= HEALTH_CACHE_MS;
          if (!fresh && !(hit?.running && hit.epoch === preferencesEpoch)) {
            const value = loadHealth(session);
            healthCache.set(session, { at: Date.now(), value, running: true, epoch: preferencesEpoch });
            value.finally(() => {
              const now = healthCache.get(session);
              if (now?.value === value) now.running = false;
            }).catch(() => healthCache.delete(session));
          }
          return json(res, 200, { checks: await healthCache.get(session)!.value });
        }
        if (route === "/api/setup-plan") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const disks = await nodeDisks(name, session.ticket, await overview(session));
          try {
            const devices = (params.get("devices") ?? "").split(",").filter((d) => deviceIsValid(d));
            return json(res, 200, setupPlan(disks, devices, params.get("purpose") ?? "", params.get("name") ?? ""));
          } catch (err) {
            if (err instanceof StorageError) return json(res, 400, { error: err.message });
            throw err;
          }
        }
        if (route === "/api/usage") {
          // Proxmox's own usage history, with the person's own rights: Sys.Audit for a node, VM.Audit for a guest.
          const name = params.get("server") ?? "";
          const range = params.get("range") ?? "";
          const vmid = params.get("vmid");
          const type = params.get("type");
          if (!NODE_NAME.test(name) || !(RANGES as readonly string[]).includes(range)) return json(res, 400, { error: "That usage request isn't valid." });
          if (vmid !== null && (!/^\d{1,9}$/.test(vmid) || (type !== "qemu" && type !== "lxc"))) return json(res, 400, { error: "That usage request isn't valid." });
          const base = `/nodes/${encodeURIComponent(name)}${vmid === null ? "" : `/${type}/${vmid}`}`;
          const raw = await pve.get<RawPoint[]>(`${base}/rrddata?timeframe=${range}&cf=AVERAGE`, session.ticket);
          return json(res, 200, buildUsage(Array.isArray(raw) ? raw : [], vmid === null ? "node" : "guest", range as Range));
        }
        if (route === "/api/storage-map") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          return json(res, 200, await loadStorageMap(name, session));
        }
        if (route === "/api/disks" || route === "/api/disk-smart") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          if (route === "/api/disks") return json(res, 200, { disks: await nodeDisks(name, session.ticket, await overview(session)) });
          const disk = params.get("disk") ?? "";
          if (!deviceIsValid(disk)) return json(res, 400, { error: "That disk isn't valid." });
          return json(res, 200, await pve.get<unknown>(`/nodes/${encodeURIComponent(name)}/disks/smart?disk=${encodeURIComponent(disk)}`, session.ticket));
        }
        if (route === "/api/tasks") {
          const asked = Number(params.get("limit"));
          const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 2000) : 200;
          const data = await overview(session);
          const online = data.nodes.filter((n) => n.online).map((n) => n.name);
          const lists = await Promise.allSettled(online.map((n) => pve.get<RawTask[]>(`/nodes/${encodeURIComponent(n)}/tasks?source=all&limit=${limit}`, session.ticket)));
          const perNode = online.flatMap((node, i) => {
            const r = lists[i];
            return r?.status === "fulfilled" ? [{ node, tasks: r.value }] : [];
          });
          const unreachable = online.filter((_, i) => lists[i]?.status !== "fulfilled").concat(data.nodes.filter((n) => !n.online).map((n) => n.name));
          return json(res, 200, buildTaskLog(perNode, unreachable, data.vms, limit));
        }
        if (route === "/api/templates") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const list = await pve.get<{ template?: string; headline?: string; section?: string; package?: string }[]>(`/nodes/${encodeURIComponent(name)}/aplinfo`, session.ticket);
          return json(res, 200, { templates: list.filter((t) => t.section === "system" && t.template).map((t) => ({ template: t.template, title: t.headline || t.package || t.template })) });
        }
        if (route === "/api/guest-addresses") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const type = params.get("type") === "lxc" ? "lxc" : "qemu";
          const { path } = guestPath(name, { guest: params.get("guest"), type });
          try {
            const raw = await pve.get<unknown>(type === "lxc" ? `${path}/interfaces` : `${path}/agent/network-get-interfaces`, session.ticket);
            return json(res, 200, { addresses: pickAddresses(type, raw), known: true });
          } catch (err) {
            if (err instanceof PveError && err.status !== 401) return json(res, 200, { addresses: [], known: false });
            throw err;
          }
        }
        if (route === "/api/network") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          return json(res, 200, await loadNetwork(name, session.ticket));
        }
        if (route === "/api/create-plan") {
          const name = params.get("server") ?? "";
          const kind = params.get("kind");
          if (!NODE_NAME.test(name) || (kind !== "qemu" && kind !== "lxc")) return json(res, 400, { error: "That request isn't valid." });
          return json(res, 200, await loadCreatePlan(name, kind, session.ticket));
        }
        if (route === "/api/restore-plan") {
          const name = params.get("server") ?? "";
          const type = params.get("type");
          if (!NODE_NAME.test(name) || (type !== "qemu" && type !== "lxc")) return json(res, 400, { error: "That request isn't valid." });
          return json(res, 200, await loadRestorePlan(name, type, session.ticket));
        }
        if (route === "/api/snapshot-support") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const { path } = guestPath(name, { guest: params.get("guest"), type: params.get("type") });
          const feature = await pve.get<{ hasFeature?: number }>(`${path}/feature?feature=snapshot`, session.ticket);
          if (feature.hasFeature === 1 || params.get("type") !== "qemu") return json(res, 200, { supported: feature.hasFeature === 1, fix: [] });
          return json(res, 200, { supported: false, fix: await snapshotFixFor(name, path, session.ticket) });
        }
        if (route === "/api/reboot-plan") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const base = `/nodes/${encodeURIComponent(name)}`;
          const [active, storages, evacuate] = await Promise.all([
            section(pve.get<RawTask[]>(`${base}/tasks?source=active`, session.ticket)),
            section(pve.get<RawBackupStorage[]>(`${base}/storage?content=backup`, session.ticket)),
            planEvacuation(session.ticket, name),
          ]);
          return json(res, 200, { ...buildRebootPlan(active, storages, evacuate.problems), evacuate });
        }
        if (route === "/api/run") return json(res, 200, { run: currentRun });
        if (route === "/api/run-plan") {
          const kind = params.get("kind") === "restart" ? "restart" : "update";
          const name = params.get("server") ?? "";
          if (kind === "restart" && !NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          return json(res, 200, await runPlan(session.ticket, kind, name));
        }
        if (route === "/api/moves") {
          // Only what's still where BossMox left it can go home; the rest was moved by someone since.
          const data = await overview(session);
          const where = new Map(data.vms.map((v) => [v.id, v.node]));
          const away = Object.fromEntries(Object.entries(moveRecord.away)
            .map(([node, a]) => [node, { by: a.by, at: a.at, guests: stillAway(moveRecord, node, where) }] as const)
            .filter(([, a]) => a.guests.length > 0));
          return json(res, 200, { away, job: moveRecord.job });
        }
        if (route === "/api/server") {
          const name = params.get("name") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const detail = await loadServerDetail(name, session.ticket);
          const known = detail.summary || detail.updates || detail.services || detail.tasks;
          return known ? json(res, 200, detail) : json(res, 404, { error: "BossMox can't find that node, or your account can't see it." });
        }
        // Only after sign-in: the exact version tells an attacker what to try.
        return json(res, 200, { ...(await overview(session)), username: session.username, version: VERSION, update: updateView() });
      } catch (err) {
        if (err instanceof PveError && err.status === 401) {
          sessions.end(id);
          return json(res, 401, { error: "Sign in to continue." });
        }
        throw err;
      }
    }
    const file = STATIC[route];
    if (!file) return json(res, 404, { error: "Not found." });
    return send(res, 200, file[1], await readFile(path.join(PUBLIC, file[0])));
  } catch (err) {
    if (err instanceof AuthError) return json(res, err.status, { error: err.message });
    // The detail can name internal addresses, and some of these routes are open to anyone, so it stays in the log.
    console.error("Request failed:", err instanceof Error ? err.message : err);
    return json(res, 502, { error: "BossMox couldn't get an answer from Proxmox." });
  }
};

const serving = config.tls ? "https" : "http";
const server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler);
// OpenSSL holds its own copy now, so this one doesn't need to stay in ordinary memory.
config.tls?.key.fill(0);
delete config.tls;

// Node's default would cut off a big ISO upload after 5 minutes.
server.requestTimeout = 6 * 60 * 60 * 1000;

server.on("upgrade", async (req, socket, head) => {
  // Without this, a client dropping the connection during the checks below could take the whole process down.
  socket.on("error", () => socket.destroy());
  const refuse = () => {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const origin = req.headers.origin ?? "";
    // Browsers don't apply same-origin rules to WebSockets, so the Origin check here is required.
    if (url.pathname !== "/api/terminal" || !hostAllowed(req.headers.host) || !origin || !sameOrigin(origin, req.headers.host, secureCookie, proxiedNames)) return refuse();
    const session = await sessions.get(cookieId(req));
    const term = session && terminals.claim(url.searchParams.get("id") ?? "", session);
    if (!term) return refuse();
    terminals.connect(req, socket, head, term);
  } catch {
    refuse();
  }
});
if (config.allowHttp && !config.behindProxy && !config.tlsConfigured && config.host !== "127.0.0.1") {
  console.warn("WARNING: BOSSMOX_ALLOW_HTTP is on and BossMox is listening beyond this machine. Unless only this machine can reach the port, passwords travel in the clear.");
}
if (config.behindProxy && config.trustedProxies.size === 0) {
  console.warn("BOSSMOX_BEHIND_HTTPS_PROXY is on but BOSSMOX_TRUSTED_PROXY isn't set, so every visitor looks like one address and a few failed sign-ins lock everyone out.");
}
server.listen(config.port, config.host, () => {
  console.log(`BossMox is running at ${serving}://${config.host}:${config.port}`);
});
