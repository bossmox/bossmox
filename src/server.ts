import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, Sessions, type LoginOutcome, type Session } from "./auth.js";
import { loadConfig } from "./config.js";
import { Terminals, type TermProxy } from "./terminal.js";
import { buildOverview, type Guest, type Overview, type RawConfig, type RawResource, type RawSnapshot } from "./model.js";
import { buildBackups, type BackupSource, type RawBackupFile, type RawBackupJob } from "./backups.js";
import { containerForm, CreateError, discDownload, installerLabel, settingsForm, vmForm, type CreateInput } from "./create.js";
import { buildNetwork, type RawDns, type RawInterface } from "./network.js";
import { PveClient, PveError, type Identity } from "./pve.js";
import {
  buildMovePlan,
  buildRebootPlan,
  buildRollingPlan,
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
  type Section,
  type ServerDetail,
} from "./server-detail.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.js": ["vendor/xterm.js", "text/javascript; charset=utf-8"],
  "/vendor/addon-fit.js": ["vendor/addon-fit.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": ["vendor/xterm.css", "text/css; charset=utf-8"],
  "/vendor/novnc.js": ["vendor/novnc.js", "text/javascript; charset=utf-8"],
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const CACHE_MS = 4000;
const COOKIE = "bossmox_session";
const MAX_BODY = 8 * 1024;

const config = loadConfig();
const pve = new PveClient(config);
const sessions = new Sessions(pve);
const terminals = new Terminals({
  get pveUrl() {
    return pve.activeUrl;
  },
  pveCa: config.pveCa,
  pveTlsName: config.pveTlsName,
} as ConstructorParameters<typeof Terminals>[0]);
const secureCookie = Boolean(config.tls) || config.behindProxy;
const cache = new WeakMap<Session, { at: number; value: Promise<Overview> }>();

async function fetchGuest(r: RawResource, ticket: string): Promise<[number, Guest]> {
  const base = `/nodes/${encodeURIComponent(r.node ?? "")}/${r.type}/${r.vmid}`;
  const [cfg, snaps] = await Promise.allSettled([
    pve.get<RawConfig>(`${base}/config`, ticket),
    pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket),
  ]);
  const guest: Guest = {};
  if (cfg.status === "fulfilled") guest.config = cfg.value;
  if (snaps.status === "fulfilled") guest.snapshots = snaps.value;
  return [r.vmid ?? 0, guest];
}

async function loadOverview(ticket: string): Promise<Overview> {
  const resources = await pve.get<RawResource[]>("/cluster/resources", ticket);
  const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && r.status !== "unknown");
  const [details, notBackedUp] = await Promise.all([
    Promise.all(guests.map((g) => fetchGuest(g, ticket))),
    // Limited accounts can't read this report, and that shouldn't blank the whole screen.
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up", ticket).catch(() => []),
  ]);
  return buildOverview(resources, new Map(details), notBackedUp);
}

function overview(session: Session): Promise<Overview> {
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
    cores: status.cpuinfo?.cpus ?? 0,
    memoryGb: Math.floor((status.memory?.total ?? 0) / 1024 ** 3),
  };
}

async function loadRollingPlan(ticket: string) {
  const data = await loadOverview(ticket);
  const [cluster, tieBreaker, servers] = await Promise.all([
    section(pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", ticket)),
    section(pve.get<{ State?: string }>("/cluster/config/qdevice", ticket)),
    Promise.all(data.nodes.map(async (n): Promise<RollingInput> => {
      if (!n.online) return { name: n.name, online: false, version: null, updates: null, rebootNeeded: false, busy: [] };
      const base = `/nodes/${encodeURIComponent(n.name)}`;
      const [status, updates, active] = await Promise.all([
        section(pve.get<RawStatus>(`${base}/status`, ticket)),
        section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
        section(pve.get<RawTask[]>(`${base}/tasks?source=active`, ticket)),
      ]);
      const list = updates.available ? groupUpdates(updates.value) : null;
      return {
        name: n.name,
        online: true,
        version: status.available ? status.value.pveversion?.split("/")[1] ?? null : null,
        updates: list ? list.total : null,
        rebootNeeded: list?.rebootNeeded ?? false,
        busy: buildRebootPlan(active, { available: false }).busy,
      };
    })),
  ]);
  const quorate: Section<boolean> = cluster.available
    ? { available: true, value: cluster.value.find((c) => c.type === "cluster")?.quorate === 1 }
    : { available: false };
  return buildRollingPlan(servers, quorate, tieBreaker);
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown, extra?: Record<string, string>) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

const NODE_NAME = /^[\w.-]{1,64}$/;
const UPID = /^UPID:[\w.-]+:[0-9A-F]{8}:[0-9A-F]{8,}:[0-9A-F]{8}:\w+:[^:\s]*:[\w.@!-]+:$/;

const POWER = new Set(["start", "shutdown", "reboot", "stop"]);
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

/** Everything BossMox can change on Proxmox is listed here. There is no general pass-through. */
const ACTIONS: Record<string, (name: string, who: Identity, body: Record<string, unknown>) => Promise<string | null>> = {
  "check-updates": (name, who) => pve.post<string>(`/nodes/${encodeURIComponent(name)}/apt/update`, who),
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
    return pve.post<string>(`${path}/status/${power}`, who);
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
  "guest-create": (name, who, body) => {
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
    const type = body.type === "qemu" ? "qemu" : "lxc";
    const disc = typeof body.disc === "string" ? body.disc.slice(0, 256) : null;
    const current = disc === null ? {} : await pve.get<RawConfig>(`${path}/config`, who.ticket);
    try {
      const form = settingsForm(type, { name: text(body.name, 63), cores: Number(body.cores), memoryMb: Number(body.memoryMb), startsAtBoot: body.startsAtBoot === true, disc }, { boot: current.boot === undefined ? undefined : String(current.boot), ide2: current.ide2 === undefined ? undefined : String(current.ide2) });
      await pve.put<null>(`${path}/config`, who, form);
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

async function openUpdateTerminal(res: http.ServerResponse, name: string, session: Session) {
  const proxy = await pve.post<TermProxy>(`/nodes/${encodeURIComponent(name)}/termproxy`, session, { cmd: "upgrade" });
  return json(res, 200, { terminal: terminals.prepare(name, session, proxy) });
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
  const session = await sessions.get(cookieId(req));
  if (!session) return json(res, 401, { error: "Sign in to continue." });
  if (action === "guest-console") {
    try {
      return await openConsole(res, await readJson(req), session);
    } catch (err) {
      if (err instanceof PveError && err.status === 403) return json(res, 403, { error: "Your Proxmox account doesn't have permission to do that." });
      if (err instanceof PveError && err.status !== 401 && err.reason) return json(res, 400, { error: `Proxmox refused: ${err.reason}` });
      throw err;
    }
  }
  if (action === "install-updates") {
    const name = text((await readJson(req)).server, 64);
    if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
    try {
      return await openUpdateTerminal(res, name, session);
    } catch (err) {
      if (err instanceof PveError && err.status === 403) {
        return json(res, 403, { error: "Your Proxmox account doesn't have permission to do that." });
      }
      throw err;
    }
  }
  const run = ACTIONS[action];
  if (!run) return json(res, 404, { error: "BossMox doesn't have that action." });
  const body = await readJson(req);
  const name = text(body.server, 64);
  if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
  try {
    return json(res, 200, { task: await run(name, session, body) });
  } catch (err) {
    if (err instanceof PveError && err.status === 403) {
      return json(res, 403, { error: "Your Proxmox account doesn't have permission to do that." });
    }
    if (err instanceof PveError && err.status !== 401 && err.reason) {
      return json(res, 400, { error: `Proxmox refused: ${err.reason}` });
    }
    throw err;
  }
}

const stripPort = (host: string) => host.replace(/:\d+$/, "").toLowerCase();
const hostAllowed = (header = "") => config.allowedHosts.has(stripPort(header));

/** Only this app's own pages can post here: browsers won't add this header across sites without permission. */
function sameSite(req: http.IncomingMessage): boolean {
  if (req.headers["x-bossmox"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return hostAllowed(new URL(origin).host);
  } catch {
    return false;
  }
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

function finishLogin(res: http.ServerResponse, out: LoginOutcome) {
  if (out.kind === "code") return json(res, 200, { needsCode: true, challenge: out.id });
  return json(res, 200, { username: out.username }, setCookie(out.id, 12 * 60 * 60));
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
  if (!sameSite(req)) return json(res, 403, { error: "This request didn't come from BossMox." });
  const address = req.socket.remoteAddress ?? "unknown";
  if (route === "/api/login") {
    const body = await readJson(req);
    const user = text(body.username, 128);
    const realm = text(body.realm, 64);
    const password = text(body.password, 512);
    if (!user || !realm || !password) return json(res, 400, { error: "Enter your username and password." });
    if (!/^[\w.@+-]+$/.test(user) || !/^[\w.-]+$/.test(realm)) return json(res, 401, { error: "Wrong username or password." });
    return finishLogin(res, await sessions.login(`${user}@${realm}`, password, address));
  }
  if (route === "/api/login/code") {
    const body = await readJson(req);
    const code = text(body.code, 32).replace(/\s/g, "");
    const challenge = text(body.challenge, 128);
    if (!/^\d{6,8}$/.test(code) || !challenge) return json(res, 400, { error: "Enter the code from your authenticator app." });
    return finishLogin(res, await sessions.submitCode(challenge, code, address));
  }
  if (route === "/api/logout") {
    sessions.end(cookieId(req));
    return json(res, 200, { ok: true }, setCookie("", 0));
  }
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
      return json(res, 200, { realms: await pve.get<{ realm: string; comment?: string; default?: number }[]>("/access/domains") });
    }
    if (route === "/api/overview" || route === "/api/server" || route === "/api/task" || route === "/api/reboot-plan" || route === "/api/move-plan" || route === "/api/rolling-plan" || route === "/api/snapshot-support" || route === "/api/backups" || route === "/api/restore-plan" || route === "/api/create-plan" || route === "/api/network") {
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
          const [status, log] = await Promise.all([
            pve.get<RawTaskStatus>(`${base}/status`, session.ticket),
            pve.get<{ n?: number; t?: string }[]>(`${base}/log?limit=1000`, session.ticket),
          ]);
          const view = taskView(status, log);
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
          const [active, storages] = await Promise.all([
            section(pve.get<RawTask[]>(`${base}/tasks?source=active`, session.ticket)),
            section(pve.get<RawBackupStorage[]>(`${base}/storage?content=backup`, session.ticket)),
          ]);
          return json(res, 200, buildRebootPlan(active, storages));
        }
        if (route === "/api/server") {
          const name = params.get("name") ?? "";
          if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const detail = await loadServerDetail(name, session.ticket);
          const known = detail.summary || detail.updates || detail.services || detail.tasks;
          return known ? json(res, 200, detail) : json(res, 404, { error: "BossMox can't find that server, or your account can't see it." });
        }
        return json(res, 200, { ...(await overview(session)), username: session.username });
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
    const message = err instanceof Error ? err.message : "BossMox hit an internal error.";
    console.error("Request failed:", message);
    return json(res, 502, { error: message });
  }
};

const server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler);

server.on("upgrade", async (req, socket, head) => {
  const refuse = () => {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const origin = req.headers.origin ?? "";
    // Browsers don't apply same-origin rules to WebSockets, so the Origin check here is required.
    if (url.pathname !== "/api/terminal" || !hostAllowed(req.headers.host) || !origin || !hostAllowed(new URL(origin).host)) return refuse();
    const session = await sessions.get(cookieId(req));
    const term = session && terminals.claim(url.searchParams.get("id") ?? "", session);
    if (!term) return refuse();
    terminals.connect(req, socket, head, term);
  } catch {
    refuse();
  }
});
server.listen(config.port, config.host, () => {
  console.log(`BossMox is running at ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
});
