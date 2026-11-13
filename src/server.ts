import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, Sessions, type LoginOutcome, type Session } from "./auth.js";
import { clientAddress, loadConfig, sameOrigin } from "./config.js";
import { Terminals, type TermProxy } from "./terminal.js";
import { buildOverview, type Guest, type Overview, type RawConfig, type RawResource, type RawSnapshot } from "./model.js";
import { buildBackups, type BackupSource, type RawBackupFile, type RawBackupJob } from "./backups.js";
import { FILE_STORAGE, installerLabel } from "./create.js";
import { buildNetwork, type RawDns, type RawInterface } from "./network.js";
import { eraseBlocker, hostIsValid, readHardDisks, StorageError, type RawDisk, type RawStorageConfig } from "./storage.js";
import { pickAddresses, snapshotFix, HardwareError } from "./hardware.js";
import { networkInterfaces } from "node:os";
import { PveClient, PveError, type Identity } from "./pve.js";
import { plainError } from "./plain-errors.js";
import { buildHealth, type Leftover } from "./health.js";
import { canChangeCluster, preferencesPath, seesAllGuestsFrom, readPreferences, scheduleWarnings, type Preferences } from "./preferences.js";
import { settingsPath } from "./settings.js";
import { movesPath } from "./moves.js";
import { createJobs } from "./jobs.js";
import { migrationNetwork } from "./cluster-net.js";
import { buildRecommended, props } from "./recommended.js";
import { runsPath } from "./run.js";
import { UPDATE_COMMAND, UpdateChecker, versionNumbers } from "./update-check.js";
import { buildStorageMap, type GuestRefs, type RawLvm, type RawMount, type RawStorageStatus, type RawVolume, type RawZfsDetail } from "./storage-map.js";
import { auditLine } from "./audit.js";
import { sharedLoad } from "./shared-load.js";
import { readJsonBody } from "./body.js";
import {
  buildTaskFeed,
  buildServerDetail,
  section,
  tieBreakerVotes,
  type RawRepositories,
  type RawService,
  type RawStatus,
  type RawSubscription,
  type RawTask,
  type RawTaskStatus,
  type RawUpdate,
  type TaskFeed,
  type ServerDetail,
} from "./server-detail.js";
import { hostName, requestPath } from "./config.js";
import { NODE_NAME, STORAGE, SNAPSHOT_NAME, text } from "./checks.js";
import type { Action } from "./actions/action.js";
import { clusterActions } from "./actions/cluster.js";
import { guestActions } from "./actions/guests.js";
import { storageActions } from "./actions/storage.js";
import { backupActions } from "./actions/backups.js";
import { createAlerts } from "./alerts.js";
import { releaseMismatch } from "./release-guard.js";
import { createEmail, emailPath } from "./email.js";
import { CLIENT_ID, createOutlook } from "./outlook.js";
import { keyPath, readKey } from "./sealed.js";
import { createHa } from "./ha.js";
import { createTieBreaker } from "./qdevice.js";
import { createHeartbeat, nodeConsole } from "./heartbeat.js";
import { getRoutes, type GetRoute } from "./routes/get.js";
import { HttpError } from "./http-error.js";

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
  if (session === jobs.moveJob.session) jobs.moveJob.stop = `${session.username} signed out.`;
  if (session === jobs.runState.session && jobs.currentRun?.running) jobs.currentRun.stop = `${session.username} signed out.`;
};
// A move job keeps its person's Proxmox login renewed, like an open console does.
sessions.isBusy = (session) => terminals.hasOpen(session) || session === jobs.moveJob.session || session === jobs.runState.session;
setInterval(() => void sessions.tick().catch((err: Error) => console.error("Session check failed:", err.message)), 60 * 1000).unref();
const secureCookie = Boolean(config.tls) || config.behindProxy;
// The __Host- prefix stops a sibling site or another port from setting this cookie over the real one.
const COOKIE = secureCookie ? "__Host-bossmox_session" : "bossmox_session";
// A proxy on a custom port often drops that port from Host, so behind one the configured names are enough.
const proxiedNames = config.behindProxy || config.trustedProxies.size > 0 ? config.publicNames : new Set<string>();
type Loaded = Overview & { tasks: TaskFeed; preferences: Preferences };
const cache = new WeakMap<Session, { at: number; value: Promise<Loaded>; epoch: number }>();

/** Cluster-wide preferences (ADR 0018), read once at start. A change bumps the epoch, so no cached view outlives it. */
const PREFERENCES_FILE = preferencesPath(settingsPath(process.env));
let preferences: Preferences = readPreferences(PREFERENCES_FILE);
let preferencesEpoch = 0;

/** The heartbeat's backup link (ADR 0035): changed in a node's root console, like installs. */
const heartbeat = createHeartbeat({
  pve,
  console: nodeConsole(pve, () => ({ pveUrl: pve.activeUrl, pveCa: config.pveCa, pveTlsName: config.pveTlsName })),
  audit: (event, who, detail) => audit(event, who, "settings", detail),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

/** A tie-breaker vote for two-node clusters (ADR 0037): checks and installs in the nodes' consoles, like the heartbeat link. */
const tieBreaker = createTieBreaker({
  pve,
  console: nodeConsole(pve, () => ({ pveUrl: pve.activeUrl, pveCa: config.pveCa, pveTlsName: config.pveTlsName })),
  // Addresses BossMox knows for each running guest, so the vote machine isn't one of them.
  guestAddresses: async (session) => {
    const vms = (await pve.get<RawResource[]>("/cluster/resources?type=vm", session.ticket)).filter((r) => r.status === "running" && r.node);
    const out: Record<string, string[]> = {};
    await Promise.all(
      vms.map(async (r) => {
        const type = r.type === "lxc" ? "lxc" : "qemu";
        const path = `/nodes/${encodeURIComponent(r.node as string)}/${type}/${r.vmid}`;
        const raw = await pve.get<unknown>(type === "lxc" ? `${path}/interfaces` : `${path}/agent/network-get-interfaces`, session.ticket).catch(() => null);
        if (raw) out[r.name ?? `VM ${r.vmid}`] = pickAddresses(type, raw);
      }),
    );
    return out;
  },
  audit: (event, who, detail) => audit(event, who, "settings", detail),
});

/** Alerts through Proxmox's own notifications (ADR 0038). */
const alerts = createAlerts({ pve, viaProxy: config.behindProxy, audit: (event, who, detail) => audit(event, who, "settings", detail) });
const email = createEmail({
  file: emailPath(process.env),
  key: readKey(keyPath(process.env)),
  outlook: createOutlook(process.env.BOSSMOX_OUTLOOK_CLIENT_ID || CLIENT_ID),
  canChange: alerts.canChange,
  audit: (event, who, detail) => audit(event, who, "settings", detail),
});
setInterval(() => void email.keepAlive(), 6 * 60 * 60 * 1000).unref();
void email.keepAlive();

/** Keep this guest running (ADR 0036). Where a guest could go comes from the same planning moves use. */
const ha = createHa({
  pve,
  cantMove: async (t, node, id) => {
    const plan = await jobs.planEvacuation(t, node, [id]);
    return plan.unplaced?.find((u) => u.id === id)?.why ?? (plan.problems.length ? plan.problems.join(" ") : null);
  },
  heartbeat: (s) => heartbeat.view(s),
  netCheck: (t) => jobs.readNetCheck(t),
  audit: (event, who, detail) => audit(event, who, "guest", detail),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Moves and runs (ADR 0025, 0027), in their own module; the server hands them Proxmox and its settings. */
const jobs = createJobs({
  pve,
  preferences: () => preferences,
  loadOverview: (ticket) => loadOverview(ticket),
  audit: (event, who, address, detail) => audit(event, who, address, detail),
  jobEnded: (session) => cache.delete(session),
  shell: () => ({ pveUrl: pve.activeUrl, pveCa: config.pveCa, pveTlsName: config.pveTlsName }),
  movesFile: movesPath(settingsPath(process.env)),
  runsFile: runsPath(settingsPath(process.env)),
});

/** Checks GitHub for a newer BossMox every 6 hours while it's on (ADR 0019). A copy with no version never checks. */
const updates = new UpdateChecker(VERSION, preferences.updateCheck);
updates.start();
const HAS_VERSION = versionNumbers(VERSION) !== null;
const SHORT_VERSION = VERSION.replace(/^(\d+\.\d+\.\d+(?:-[a-z]+)?).*$/, "$1");
const updateView = () => (HAS_VERSION ? { on: updates.state.on, available: updates.state.available, command: UPDATE_COMMAND } : null);

async function fetchGuest(r: RawResource, ticket: string): Promise<[number, Guest]> {
  const base = `/nodes/${encodeURIComponent(r.node ?? "")}/${r.type}/${r.vmid}`;
  const [cfg, snaps] = await Promise.allSettled([pve.get<RawConfig>(`${base}/config`, ticket), pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket)]);
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

export interface RawStorage {
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
  const perNode = await Promise.all(
    online.map(async (node) => {
      const base = `/nodes/${encodeURIComponent(node)}/storage`;
      const storages = (await pve.get<RawStorage[]>(`${base}?content=backup`, ticket)).filter(usable);
      return { node, base, storages };
    }),
  );
  const reads: Promise<BackupSource[]>[] = [];
  for (const { node, base, storages } of perNode) {
    for (const s of storages) {
      // Storage shared between servers holds the same files, so read it once.
      if (s.shared === 1) {
        if (sharedSeen.has(s.storage)) continue;
        sharedSeen.add(s.storage);
      }
      reads.push(
        pve
          .get<RawBackupFile[]>(`${base}/${encodeURIComponent(s.storage)}/content?content=backup`, ticket)
          .then((files) => files.map((file) => ({ node, storage: s.storage, file })))
          .catch(() => []),
      );
    }
  }
  const [files, backupJobs, notBackedUp] = await Promise.all([
    Promise.all(reads),
    pve.get<RawBackupJob[]>("/cluster/backup", ticket).catch(() => []),
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up", ticket).catch(() => []),
  ]);
  return {
    ...buildBackups(
      files.flat(),
      data.vms.map((v) => ({ id: v.id, name: v.name })),
      backupJobs,
      scheduleWarnings(preferences, notBackedUp),
    ),
    backupsElsewhere: preferences.backupsElsewhere,
  };
}

async function loadRestorePlan(name: string, type: "qemu" | "lxc", ticket: string) {
  const content = type === "qemu" ? "images" : "rootdir";
  const [storages, nextId] = await Promise.all([pve.get<RawStorage[]>(`/nodes/${encodeURIComponent(name)}/storage?content=${content}`, ticket), pve.get<string | number>("/cluster/nextid", ticket)]);
  return { nextId: Number(nextId), storages: storages.filter(usable).map((s) => s.storage) };
}

async function loadNetwork(name: string, ticket: string) {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const [data, interfaces, dns] = await Promise.all([loadOverview(ticket), pve.get<RawInterface[]>(`${base}/network`, ticket), pve.get<RawDns>(`${base}/dns`, ticket).catch(() => null)]);
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

const _enc = encodeURIComponent;

/** The cluster options the recommended settings read and change, plus the move network judged from them. */
async function readOptions(ticket: string) {
  const [options, net] = await Promise.all([pve.get<Record<string, unknown>>("/cluster/options", ticket), jobs.readNetCheck(ticket)]);
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
    storage: stores
      .filter((x) => x.disable !== 1)
      .flatMap((x) => {
        const ip = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec((x.portal ?? x.server ?? "").trim())?.[1];
        return ip && x.storage ? [{ id: x.storage, ip }] : [];
      }),
  });
}

/** The sign-in realms. Anyone can ask for them, so one load a minute is shared by everyone (#59). */
const realms = sharedLoad(60 * 1000, () => pve.get<{ realm: string; comment?: string; default?: number }[]>("/access/domains"));

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, ...(secureCookie ? { "Strict-Transport-Security": "max-age=31536000" } : {}), "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown, extra?: Record<string, string>) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

const MAX_UPLOAD = 200 * 1024 ** 3;
const FULL_LOG = 20000;
const BODY_WAIT_MS = 30_000;
const UPLOAD_NAME = /^[\w.-]{1,200}\.(iso|img)$/i;

/** Turns a hardware rule into a plain 400, and reads the guest's settings the rule needs. */
/** The IPv4 addresses BossMox answers on from the network. Loopback (127.0.0.1) is left out: every guest has it too. */
function ownAddresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("127."))
      .map((i) => i!.address),
  );
}
const part = (value: string, key: string) =>
  value
    .split(",")
    .find((p) => p.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? "";
async function withConfig<T>(path: string, who: Identity, run: (config: RawConfig) => T): Promise<T> {
  const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
  try {
    return run(config);
  } catch (err) {
    if (err instanceof HardwareError) throw new HttpError(400, err.message);
    throw err;
  }
}
/** Turns a storage rule into a plain 400 rather than a failure. */
function rule<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof StorageError) throw new HttpError(400, err.message);
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
const kindOf = (body: Record<string, unknown>) => (body.type === "lxc" ? ("lxc" as const) : ("qemu" as const));
// Dot-only names ("." and "..") are refused: addresses fold them into the path around them (pre-public review 2026-11-09).

/** The address of one VM or container, checked, for actions that take one. */
function guestPath(name: string, body: Record<string, unknown>): { id: string; path: string } {
  const id = text(body.guest, 12);
  const type = body.type;
  if (!/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) throw new HttpError(400, "That request isn't valid.");
  return { id, path: `/nodes/${encodeURIComponent(name)}/${type}/${id}` };
}
function snapshotName(body: Record<string, unknown>): string {
  const snap = text(body.snapshot, 40);
  if (!SNAPSHOT_NAME.test(snap)) throw new HttpError(400, "A snapshot name starts with a letter, then letters, numbers, dashes or underscores.");
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
  const [status, nodeConfig, qdevice, backupJobs, tasks, details, maps, network, options, haResources, leftover, heartbeatView, alertsView] = await Promise.all([
    pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t).catch(() => []),
    pve.get<{ node?: string; quorum_votes?: string | number }[]>("/cluster/config/nodes", t).catch(() => []),
    pve.get<Record<string, unknown>>("/cluster/config/qdevice", t).catch(() => ({})),
    pve.get<{ id?: string; storage?: string; enabled?: number }[]>("/cluster/backup", t).catch(() => []),
    pve.get<(RawTask & { node?: string })[]>("/cluster/tasks", t).catch(() => []),
    Promise.all(online.map((n) => loadServerDetail(n, t).catch(() => null))),
    Promise.all(
      online.map((n) =>
        storageMapFor(n, t, data)
          .then((r) => r.map)
          .catch(() => null),
      ),
    ),
    jobs.readNetCheck(t),
    pve.get<Record<string, unknown>>("/cluster/options", t).catch((): Record<string, unknown> => ({})),
    pve.get<{ sid?: string }[]>("/cluster/ha/resources", t).catch(() => []),
    leftoverDisks(data.vms, t),
    heartbeat.view(session).catch(() => null),
    alerts.view(session).catch(() => null),
  ]);
  const cluster = status.find((x) => x.type === "cluster");
  const names = new Map(data.vms.map((v) => [String(v.id), v.name]));
  return buildHealth({
    nodes: data.nodes.map((n) => ({ name: n.name, online: n.online })),
    ...(cluster ? { cluster: { quorate: cluster.quorate === 1 } } : {}),
    votes: nodeConfig.map((n) => ({ node: n.node ?? "", votes: Number(n.quorum_votes ?? 1) })),
    tieBreaker: tieBreakerVotes(qdevice as { State?: string }),
    tieBreakerDown: Object.keys(qdevice ?? {}).length > 0 && !tieBreakerVotes(qdevice as { State?: string }),
    network,
    ha: { policy: props(options.ha).shutdown_policy ?? "conditional", guests: haResources.filter((r) => /^(vm|ct):/.test(r.sid ?? "")).length },
    leftover,
    heartbeat: heartbeatView,
    alerts: alertsView,
    emailFailed: email.view().failed,
    channels: details.flatMap((d) => (d?.channel ? [{ node: d.name, ...d.channel }] : [])),
    updates: details.flatMap((d) => (d?.updates ? [{ node: d.name, total: d.updates.total }] : [])),
    guests: data.vms,
    unscheduled: data.vms.filter((v) => v.issues.some((i) => i.kind === "no-backup")).map((v) => v.id),
    backupsElsewhere: preferences.backupsElsewhere,
    jobs: backupJobs.map((j) => ({ id: j.id ?? "", storage: j.storage ?? "", enabled: j.enabled !== 0 })),
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
  return Promise.all(
    list.map(async (d) => {
      const storage = d.volume.split(":")[0] ?? "";
      const info = await pve.get<{ size?: number }>(`/nodes/${encodeURIComponent(d.node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(d.volume)}`, ticket).catch(() => null);
      return { ...d, sizeGb: info?.size ? Math.round((info.size / 1024 ** 3) * 10) / 10 : null };
    }),
  );
}

/** Waits for a Proxmox task to finish, and fails with its own words if it didn't end OK. */
async function finishTask(node: string, upid: string, who: Identity, seconds: number) {
  const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`;
  for (let i = 0; i < seconds; i++) {
    // Someone who signed out isn't acting any more: an action with more steps stops here, not on their old ticket (#59).
    if ((who as Partial<Session>).ended) throw new AuthError(401, "You signed out, so BossMox stopped here. What Proxmox had already started carries on.");
    const status = await pve.get<RawTaskStatus>(path, who.ticket);
    if (status.status === "stopped") {
      if (status.exitstatus !== "OK") throw new HttpError(400, `Proxmox stopped: ${status.exitstatus ?? "it didn't finish"}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new HttpError(504, "Proxmox is taking a long time. Check the node's activity, then look again.");
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
  const quiet = <T>(p: Promise<T>, fallback: T) =>
    p.catch((err) => {
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
  const contentEntries = await Promise.all(
    active.map(
      async (s) =>
        [
          s.storage,
          await quiet(pve.get<RawVolume[]>(`${base}/storage/${encodeURIComponent(s.storage)}/content`, t), null).then((v) => {
            if (v === null) unreadable.push(s.storage);
            return v ?? [];
          }),
        ] as const,
    ),
  );
  const map = buildStorageMap(
    {
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
    },
    data.nodes.length > 1,
  );
  return { map, diskList: readHardDisks(disks, passedThrough(name, data), eraseBlocker(guestRefs(data), seesAll)), config, directory };
}

/** What this person may see of a run or move job: all of it if they started it or can change the cluster (review S6). */
async function viewerOf(session: Session, startedBy: string | undefined) {
  const data = await overview(session);
  const view = { nodes: new Set(data.nodes.map((n) => n.name)), guests: new Set(data.vms.map((v) => v.id)) };
  if (startedBy === session.username) return { full: true, ...view };
  const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", session.ticket).catch((): Record<string, Record<string, number>> => ({}));
  return { full: canChangeCluster(perms), ...view };
}

/** Whether this account can see every guest. Without it, a guest it can't see looks like a deleted one. */
async function seesAllGuests(ticket: string): Promise<boolean> {
  // Every path, not only /vms: a NoAccess further down hides guests (review 2, S1).
  const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions", ticket).catch((): Record<string, Record<string, number>> => ({}));
  return seesAllGuestsFrom(perms);
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

/** What the action modules get from the server (review #61). The preferences live here, so they're read and set through it. */
const actionContext = {
  pve,
  jobs,
  heartbeat,
  ha,
  tieBreaker,
  alerts,
  email,
  updates,
  preferences: () => preferences,
  setPreferences: (next: Preferences) => {
    preferences = next;
  },
  bumpEpoch: () => {
    preferencesEpoch += 1;
  },
  preferencesFile: PREFERENCES_FILE,
  audit,
  finishTask,
  guestPath,
  guestRefs,
  keepsFiles,
  kindOf,
  loadOverview,
  nodeDisks,
  overview,
  ownAddresses,
  part,
  readOptions,
  rule,
  seesAllGuests,
  snapshotFixFor,
  snapshotName,
  storageMapFor,
  usesStorageNames,
  withConfig,
};
export type ActionContext = typeof actionContext;

/** Everything BossMox can change on Proxmox is listed in src/actions. There is no general pass-through. */
const ACTIONS: Record<string, Action> = { ...clusterActions(actionContext), ...guestActions(actionContext), ...storageActions(actionContext), ...backupActions(actionContext) };

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
      audit("console", session.username, addressOf(req), { node: text(body.server, 64), guest: text(body.guest, 12) });
      return await openConsole(res, body, session);
    }
    const name = text(body.server, 64);
    if (action === "install-updates" || action === "node-console") {
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      if (action === "install-updates") {
        // Proxmox's own updater would carry out a major upgrade just the same (ADR 0039).
        const mismatch = releaseMismatch(name, await pve.get<RawRepositories>(`/nodes/${encodeURIComponent(name)}/apt/repositories`, session.ticket).catch(() => null));
        if (mismatch) return json(res, 400, { error: mismatch });
      }
      audit(action === "install-updates" ? "updater" : "console", session.username, addressOf(req), { node: name });
      return await openNodeTerminal(res, name, session, action === "install-updates" ? { cmd: "upgrade" } : {});
    }
    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) return json(res, 404, { error: "BossMox doesn't have that action." });
    if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
    const task = await run(name, session, body);
    // No task means it's already done, so nothing else will clear the old view of it.
    if (!task) cache.delete(session);
    audit(action, session.username, addressOf(req), { node: name, ...(text(body.guest, 12) ? { guest: text(body.guest, 12) } : {}) });
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

const readJson = (req: http.IncomingMessage) => readJsonBody(req, { maxBytes: MAX_BODY, waitMs: BODY_WAIT_MS });

/** Who did what, for anyone looking into an incident. Names and addresses only, never tickets, passwords or request bodies. */
function audit(event: string, who: string, address: string, fields: Record<string, string | number> = {}) {
  console.log(auditLine(new Date(), event, who, address, fields));
}
let lastLockoutLog = 0;
/** A lockout can be hammered, and one line every 10 seconds says all it needs to without filling a small disk. */
function auditRefused(event: string, who: string, address: string, status: number) {
  if (status === 429) {
    if (Date.now() - lastLockoutLog < 10000) return;
    lastLockoutLog = Date.now();
  }
  audit(event, who, address, { status });
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
  audit("upload", session.username, addressOf(req), { node: name, storage, file: filename, bytes: size });
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

/** What the GET routes get from the server (review #61). */
const routeContext = {
  FULL_LOG,
  HEALTH_CACHE_MS,
  VERSION,
  cache,
  guestPath,
  alerts,
  email,
  healthCache,
  ha,
  heartbeat,
  jobs,
  tieBreaker,
  json,
  loadBackups,
  loadCreatePlan,
  loadHealth,
  loadNetwork,
  loadRecommended,
  loadRestorePlan,
  loadServerDetail,
  loadStorageMap,
  nodeDisks,
  overview,
  pve,
  snapshotFixFor,
  updateView,
  viewerOf,
  epoch: () => preferencesEpoch,
};
export type RouteContext = typeof routeContext;
const GET_ROUTES = getRoutes(routeContext);

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
      return json(res, 200, { realms: await realms() });
    }
    if (Object.hasOwn(GET_ROUTES, route)) {
      const id = cookieId(req);
      const session = await sessions.get(id);
      if (!session) return json(res, 401, { error: "Sign in to continue." });
      try {
        const params = new URL(req.url ?? "/", "http://local").searchParams;
        return await (GET_ROUTES[route] as GetRoute)(route, session, params, req, res);
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
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
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

// Node's default would cut off a big ISO upload after 5 minutes. Other requests' bodies have their own limit (readJson).
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
