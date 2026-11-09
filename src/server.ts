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
import { containerForm, CreateError, discDownload, discForm, FILE_STORAGE, installerLabel, vmForm, type CreateInput } from "./create.js";
import { changesForm, SettingsError, waitingChanges } from "./guest-settings.js";
import { buildNetwork, type RawDns, type RawInterface } from "./network.js";
import { assertCanWipe, buildStorageList, deviceIsValid, diskStorageForm, hostIsValid, networkForm, readHardDisks, StorageError, storageBlockers, usesForm, type RawDisk, type RawStorageConfig } from "./storage.js";
import { addDiskForm, addNicForm, growForm, HardwareError, pickAddresses, removeDiskForm, removeNicForm } from "./hardware.js";
import { PveClient, PveError, type Identity } from "./pve.js";
import { applyChannel, ChannelError } from "./update-channel.js";
import { buildStorageMap, type RawLvm, type RawMount, type RawStorageStatus, type RawVolume, type RawZfsDetail } from "./storage-map.js";
import {
  buildMovePlan,
  buildRebootPlan,
  buildRollingPlan,
  buildTaskFeed, buildTaskLog,
  groupUpdates,
  moveProblem,
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
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
sessions.onEnd = (session) => terminals.closeSession(session);
sessions.isBusy = (session) => terminals.hasOpen(session);
setInterval(() => void sessions.tick().catch((err: Error) => console.error("Session check failed:", err.message)), 60 * 1000).unref();
const secureCookie = Boolean(config.tls) || config.behindProxy;
// The __Host- prefix stops a sibling site or another port from setting this cookie over the real one.
const COOKIE = secureCookie ? "__Host-bossmox_session" : "bossmox_session";
// A proxy on a custom port often drops that port from Host, so behind one the configured names are enough.
const proxiedNames = config.behindProxy || config.trustedProxies.size > 0 ? config.publicNames : new Set<string>();
type Loaded = Overview & { tasks: TaskFeed };
const cache = new WeakMap<Session, { at: number; value: Promise<Loaded> }>();

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
  const view = buildOverview(resources, new Map(details), notBackedUp);
  return { ...view, tasks: buildTaskFeed(tasks, view.vms) };
}

function overview(session: Session): Promise<Loaded> {
  const hit = cache.get(session);
  if (hit && Date.now() - hit.at <= CACHE_MS) return hit.value;
  const value = loadOverview(session.ticket);
  cache.set(session, { at: Date.now(), value });
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
  return buildBackups(files.flat(), data.vms.map((v) => ({ id: v.id, name: v.name })), jobs, notBackedUp);
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

/** Plain reasons why running VMs on a server won't be able to move off it. */
async function moveProblems(name: string, data: Overview, ticket: string): Promise<string[]> {
  const vms = data.vms.filter((v) => v.node === name && v.running && v.type === "qemu");
  const found = await Promise.all(vms.map(async (v) => {
    const raw = await pve.get<RawMovePrecondition>(`/nodes/${encodeURIComponent(name)}/qemu/${v.id}/migrate`, ticket).catch(() => ({}));
    return moveProblem(v.name, raw, v.snapshots.length > 0);
  }));
  return found.filter((p): p is string => p !== null);
}

async function loadRollingPlan(ticket: string) {
  const data = await loadOverview(ticket);
  const [cluster, tieBreaker, servers] = await Promise.all([
    section(pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", ticket)),
    section(pve.get<{ State?: string }>("/cluster/config/qdevice", ticket)),
    Promise.all(data.nodes.map(async (n): Promise<RollingInput> => {
      if (!n.online) return { name: n.name, online: false, version: null, updates: null, rebootNeeded: false, busy: [], cantMove: [] };
      const base = `/nodes/${encodeURIComponent(n.name)}`;
      const [status, updates, active, cantMove] = await Promise.all([
        section(pve.get<RawStatus>(`${base}/status`, ticket)),
        section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
        section(pve.get<RawTask[]>(`${base}/tasks?source=active`, ticket)),
        moveProblems(n.name, data, ticket),
      ]);
      const list = updates.available ? groupUpdates(updates.value) : null;
      return {
        name: n.name,
        online: true,
        version: status.available ? status.value.pveversion?.split("/")[1] ?? null : null,
        updates: list ? list.total : null,
        rebootNeeded: list?.rebootNeeded ?? false,
        busy: buildRebootPlan(active, { available: false }).busy,
        cantMove,
      };
    })),
  ]);
  const quorate: Section<boolean> = cluster.available
    ? { available: true, value: cluster.value.find((c) => c.type === "cluster")?.quorate === 1 }
    : { available: false };
  return buildRollingPlan(servers, quorate, tieBreaker);
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
const nodeDisks = async (name: string, ticket: string) =>
  readHardDisks(await pve.get<RawDisk[]>(`/nodes/${encodeURIComponent(name)}/disks/list?include-partitions=1`, ticket));
const usesStorageNames = (body: unknown) => (Array.isArray(body) ? body.filter((d): d is string => typeof d === "string").slice(0, 32) : []);
const kindOf = (body: Record<string, unknown>) => (body.type === "lxc" ? "lxc" as const : "qemu" as const);
const VOLUME = /^[\w.-]+:[\w./-]+$/;
const STORAGE = /^[\w.-]{1,64}$/;
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

/**
 * Everything one node says about its disks and storage, asked in parallel (ADR 0014). A part the person's account
 * can't read comes back empty, so the map still shows what it can, with those pools under "disk not identified".
 */
async function loadStorageMap(name: string, session: Session) {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const t = session.ticket;
  const quiet = <T>(p: Promise<T>, fallback: T) => p.catch((err) => {
    if (err instanceof PveError && err.status === 401) throw err;
    return fallback;
  });
  const [disks, lvm, zfsList, directory, config, status, nodeStatus, data] = await Promise.all([
    quiet(pve.get<RawDisk[]>(`${base}/disks/list?include-partitions=1`, t), []),
    quiet(pve.get<RawLvm>(`${base}/disks/lvm`, t), null),
    quiet(pve.get<{ name: string }[]>(`${base}/disks/zfs`, t), []),
    quiet(pve.get<RawMount[]>(`${base}/disks/directory`, t), []),
    pve.get<RawStorageConfig[]>("/storage", t),
    pve.get<RawStorageStatus[]>(`${base}/storage`, t),
    quiet(pve.get<{ rootfs?: { total?: number } }>(`${base}/status`, t), {}),
    overview(session),
  ]);
  const zfsEntries = await Promise.all(zfsList.map(async (z) => [z.name, await quiet(pve.get<RawZfsDetail>(`${base}/disks/zfs/${encodeURIComponent(z.name)}`, t), {})] as const));
  const active = status.filter((s) => s.enabled !== 0 && s.active === 1);
  const contentEntries = await Promise.all(active.map(async (s) => [s.storage, await quiet(pve.get<RawVolume[]>(`${base}/storage/${encodeURIComponent(s.storage)}/content`, t), [])] as const));
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
  }, data.nodes.length > 1);
  return { map, diskList: readHardDisks(disks) };
}

/** Whether a storage keeps VM disks as files, from the node's own list, which only shows what the person can use. */
async function keepsFiles(node: string, storage: string, ticket: string): Promise<boolean> {
  const list = await pve.get<{ storage: string; type?: string }[]>(`/nodes/${encodeURIComponent(node)}/storage`, ticket);
  return FILE_STORAGE.has(list.find((s) => s.storage === storage)?.type ?? "");
}

/** Everything BossMox can change on Proxmox is listed here. There is no general pass-through. */
const ACTIONS: Record<string, (name: string, who: Identity, body: Record<string, unknown>) => Promise<string | null>> = {
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
  "move-all": (name, who, body) => {
    const vms = text(body.guests, 256);
    const target = text(body.target, 64);
    if (!/^\d+(,\d+)*$/.test(vms) || !NODE_NAME.test(target) || target === name) throw new AuthError(400, "That move request isn't valid.");
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/migrateall`, who, { target, vms, "with-local-disks": "1", maxworkers: "1" });
  },
  "guest-power": (name, who, body) => {
    const { id, path } = guestPath(name, body);
    const power = text(body.power, 16);
    if (!POWER.has(power)) throw new AuthError(400, "That request isn't valid.");
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
    // Force off has to win over a shutdown that's stuck waiting for the guest.
    return pve.post<string>(`${path}/status/${power}`, who, power === "stop" ? { "overrule-shutdown": "1" } : {});
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
    const { path } = guestPath(name, { ...body, type: "qemu" });
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
    const current = await pve.get<RawConfig>(`${path}/config`, who.ticket);
    try {
      await pve.put<null>(`${path}/config`, who, discForm(body.disc, current as { boot?: string; ide2?: string }));
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
    const disks = await nodeDisks(name, who.ticket);
    const form = rule(() => diskStorageForm(kind, disks, { name: text(body.name, 32), devices: usesStorageNames(body.devices), raid: text(body.raid, 8), filesystem: text(body.filesystem, 8) }));
    return pve.post<string>(`/nodes/${encodeURIComponent(name)}/disks/${kind}`, who, form);
  },
  "disk-wipe": async (name, who, body) => {
    const disk = text(body.disk, 64);
    if (body.confirm !== "erase" || !deviceIsValid(disk)) throw new AuthError(400, "That wasn't confirmed.");
    const disks = await nodeDisks(name, who.ticket);
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
  "guest-delete": (name, who, body) => {
    const { id, path } = guestPath(name, body);
    if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
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
    if (!(err instanceof PveError)) throw err;
    if (err.status === 403) return json(res, 403, { error: "Your Proxmox account doesn't have permission to do that." });
    if (err.status === 401) {
      sessions.end(id);
      return json(res, 401, { error: "Sign in to continue." });
    }
    if (err.reason) return json(res, 400, { error: `Proxmox refused: ${err.reason}` });
    throw err;
  }
}

const stripPort = (host: string) => host.replace(/:\d+$/, "").toLowerCase();
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
  const session = await sessions.get(cookieId(req));
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
    if (err instanceof PveError && err.status !== 401) return json(res, 200, { shares: null });
    throw err;
  }
}

/** The one POST that isn't JSON: a file, passed straight through to Proxmox as it arrives. */
async function upload(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = await sessions.get(cookieId(req));
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
  const task = await pve.upload(`/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}/upload`, session, { content: "iso" }, { name: filename, size, stream: req });
  return json(res, 200, { task });
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
    const route = new URL(req.url ?? "/", "http://local").pathname;
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
    if (route === "/api/overview" || route === "/api/server" || route === "/api/task" || route === "/api/reboot-plan" || route === "/api/move-plan" || route === "/api/rolling-plan" || route === "/api/snapshot-support" || route === "/api/backups" || route === "/api/restore-plan" || route === "/api/create-plan" || route === "/api/network" || route === "/api/guest-addresses" || route === "/api/templates" || route === "/api/tasks" || route === "/api/storage-list" || route === "/api/disks" || route === "/api/disk-smart" || route === "/api/storage-map" || route === "/api/guest-waiting" || route === "/api/cpu-types") {
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
        if (route === "/api/storage-map") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          return json(res, 200, await loadStorageMap(name, session));
        }
        if (route === "/api/disks" || route === "/api/disk-smart") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          if (route === "/api/disks") return json(res, 200, { disks: await nodeDisks(name, session.ticket) });
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
          return json(res, 200, { supported: feature.hasFeature === 1 });
        }
        if (route === "/api/reboot-plan") {
          const name = params.get("server") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const base = `/nodes/${encodeURIComponent(name)}`;
          const [active, storages, cantMove] = await Promise.all([
            section(pve.get<RawTask[]>(`${base}/tasks?source=active`, session.ticket)),
            section(pve.get<RawBackupStorage[]>(`${base}/storage?content=backup`, session.ticket)),
            overview(session).then((data) => moveProblems(name, data, session.ticket)),
          ]);
          return json(res, 200, buildRebootPlan(active, storages, cantMove));
        }
        if (route === "/api/server") {
          const name = params.get("name") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const detail = await loadServerDetail(name, session.ticket);
          const known = detail.summary || detail.updates || detail.services || detail.tasks;
          return known ? json(res, 200, detail) : json(res, 404, { error: "BossMox can't find that node, or your account can't see it." });
        }
        // Only after sign-in: the exact version tells an attacker what to try.
        return json(res, 200, { ...(await overview(session)), username: session.username, version: VERSION });
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
