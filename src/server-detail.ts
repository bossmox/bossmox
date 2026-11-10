/** Turns raw Proxmox node answers into the Servers app's plain-language view. */
import { plainError } from "./plain-errors.js";

export type Section<T> = { available: true; value: T } | { available: false };

export interface RawStatus {
  uptime?: number;
  pveversion?: string;
  kversion?: string;
  cpuinfo?: { model?: string; cpus?: number; cores?: number; sockets?: number };
  memory?: { used?: number; total?: number };
  rootfs?: { used?: number; total?: number };
  loadavg?: string[];
  "current-kernel"?: { release?: string };
}
export interface RawUpdate {
  Package: string;
  Title?: string;
  OldVersion?: string;
  Version?: string;
  Origin?: string;
}
export interface RawRepository {
  Enabled?: boolean | number;
  URIs?: string[];
  Components?: string[];
}
export interface RawRepositories {
  digest?: string;
  files?: { path?: string; repositories?: RawRepository[] }[];
  "standard-repos"?: { handle: string; status?: number }[];
}
export interface RawService {
  service?: string;
  name?: string;
  desc?: string;
  state?: string;
  "unit-state"?: string;
}
export interface RawTask {
  upid: string;
  type?: string;
  id?: string;
  user?: string;
  status?: string;
  starttime?: number;
  endtime?: number;
}
export interface RawSubscription {
  status?: string;
}

const GB = 1024 ** 3;
const gb = (n = 0) => Math.round((n / GB) * 10) / 10;

export function friendlyUptime(seconds = 0): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"}, ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.floor((seconds % 3600) / 60);
  const minuteWords = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return hours > 0 ? `${hours} ${hours === 1 ? "hour" : "hours"}, ${minuteWords}` : minuteWords;
}

const KERNEL = /^(proxmox-kernel|pve-kernel|linux-image)/;
export function groupUpdates(updates: RawUpdate[]) {
  const simple = (u: RawUpdate) => ({ name: u.Package, title: u.Title ?? "", from: u.OldVersion ?? "", to: u.Version ?? "" });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const kernel = updates.filter((u) => KERNEL.test(u.Package));
  const proxmox = updates.filter((u) => !KERNEL.test(u.Package) && /proxmox/i.test(u.Origin ?? ""));
  const other = updates.filter((u) => !KERNEL.test(u.Package) && !/proxmox/i.test(u.Origin ?? ""));
  return {
    total: updates.length,
    rebootNeeded: kernel.length > 0,
    kernel: kernel.map(simple).sort(byName),
    proxmox: proxmox.map(simple).sort(byName),
    other: other.map(simple).sort(byName),
  };
}

const FREE = "Free (no subscription)";
/**
 * The node's update channel in plain words, and which switch to offer (ADR 0013). Ceph counts too: a fresh
 * install turns on Ceph's paid source even without Ceph, and that alone makes every check end in an error.
 */
export function updateChannel(repos: RawRepositories, subscription?: RawSubscription) {
  const enabled = (repos.files ?? [])
    .flatMap((f) => f.repositories ?? [])
    .filter((r) => r.Enabled && (r.URIs ?? []).some((u) => /proxmox\.com\/debian\/(pve|ceph-[a-z]+)\/?$/.test(u)));
  const pveOnly = enabled.filter((r) => (r.URIs ?? []).some((u) => /\/debian\/pve\/?$/.test(u)));
  const components = pveOnly.flatMap((r) => r.Components ?? []);
  const known = subscription !== undefined;
  const active = subscription?.status?.toLowerCase() === "active";
  const paid = enabled.filter((r) => (r.URIs ?? []).some((u) => u.includes("enterprise.proxmox.com")));
  const name = components.includes("pve-enterprise") && (active || !components.includes("pve-no-subscription"))
    ? "Enterprise"
    : components.includes("pve-no-subscription") ? FREE : components.includes("pve-test") ? "Test" : "None";
  const offer = (ok: boolean) => (active ? (name === "Enterprise" ? null : "enterprise") : known && (!ok || name !== FREE) ? "free" : null);
  const result = (ok: boolean, headline: string, note: string) => ({ name, ok, headline, note, offer: offer(ok) as "free" | "enterprise" | null });
  if (name === "None") return result(false, "Updates can't download", "No Proxmox update channel is turned on, so Proxmox can't update.");
  if (known && !active && paid.length) {
    const cephOnly = paid.every((r) => !(r.URIs ?? []).some((u) => /\/debian\/pve\/?$/.test(u)));
    if (name === "Enterprise") return result(false, "Updates can't download", "This channel needs a subscription, so updates can't download.");
    return result(false, "Every check for updates ends in an error", `Updates still download, but ${cephOnly ? "Ceph's" : "the enterprise"} source is also turned on and needs a subscription.`);
  }
  if (name === "Test") return result(true, "", "Test updates aren't meant for production.");
  return result(true, "", "");
}

const TASKS: Record<string, string> = {
  vzdump: "Backup",
  qmstart: "Start VM",
  qmstop: "Force stop VM",
  qmshutdown: "Shut down VM",
  qmreboot: "Restart VM",
  qmsnapshot: "Take snapshot",
  qmrollback: "Roll back snapshot",
  qmcreate: "Create VM",
  qmdestroy: "Delete VM",
  qmigrate: "Move VM",
  vzcreate: "Create container",
  vzstart: "Start container",
  vzstop: "Force stop container",
  vzshutdown: "Shut down container",
  vzdestroy: "Delete container",
  startall: "Start all guests",
  stopall: "Stop all guests",
  srvreload: "Reload service",
  srvrestart: "Restart service",
  srvstart: "Start service",
  srvstop: "Stop service",
  vncproxy: "Console",
  spiceproxy: "Console",
  vncshell: "Shell session",
  termproxy: "Shell session",
  clustercreate: "Create cluster",
  clusterjoin: "Join cluster",
  qmclone: "Clone VM",
  vzclone: "Clone container",
  qmtemplate: "Make template",
  vztemplate: "Make template",
  qmresize: "Resize disk",
  vzresize: "Resize disk",
  aptupdate: "Check for updates",
  imgcopy: "Copy disk",
  vzmigrate: "Move container",
  vzreboot: "Restart container",
  vzsnapshot: "Take snapshot",
  vzrollback: "Roll back snapshot",
  vzdelsnapshot: "Delete snapshot",
  qmdelsnapshot: "Delete snapshot",
  qmrestore: "Restore VM",
  vzrestore: "Restore container",
  migrateall: "Move everything",
  download: "Download",
};
export const friendlyTask = (t: RawTask) => (Object.hasOwn(TASKS, t.type ?? "") ? TASKS[t.type as string] : t.type) ?? "Task";

const QUIET_TASKS = new Set(["vncproxy", "vncshell", "termproxy", "spiceproxy"]);
/** What the whole cluster is doing: running work first, then the most recent. Console sessions would drown it out. */
export function buildTaskLog(perNode: { node: string; tasks: RawTask[] }[], unreachable: string[], guests: { id: number; name: string }[], limit: number) {
  const names = new Map(guests.map((g) => [String(g.id), g.name]));
  const items = perNode
    .flatMap(({ node, tasks }) => tasks.map((t) => ({
      upid: t.upid,
      node,
      what: friendlyTask(t),
      target: names.get(t.id ?? "") ?? t.id ?? "",
      who: t.user ?? "",
      startedAt: t.starttime ?? null,
      endedAt: t.endtime ?? null,
      result: taskResult(t),
    })))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { items, more: perNode.some((p) => p.tasks.length >= limit), unreachable };
}

export function buildTaskFeed(tasks: (RawTask & { node?: string })[], guests: { id: number; name: string }[], limit = 6) {
  const names = new Map(guests.map((g) => [String(g.id), g.name]));
  const shown = tasks.filter((t) => !QUIET_TASKS.has(t.type ?? "")).map((t) => ({
    upid: t.upid,
    node: t.node ?? "",
    what: friendlyTask(t),
    target: names.get(t.id ?? "") ?? t.id ?? "",
    who: t.user ?? "",
    startedAt: t.starttime ?? null,
    endedAt: t.endtime ?? null,
    result: taskResult(t),
  }));
  const newest = (a: { startedAt: number | null }, b: { startedAt: number | null }) => (b.startedAt ?? 0) - (a.startedAt ?? 0);
  const running = shown.filter((t) => t.result === "running").sort(newest);
  const finished = shown.filter((t) => t.result !== "running").sort(newest);
  return { running: running.length, items: [...running, ...finished].slice(0, Math.max(limit, running.length)) };
}
export type TaskFeed = ReturnType<typeof buildTaskFeed>;

export function taskResult(t: RawTask): "running" | "ok" | "warning" | "failed" {
  if (!t.status && !t.endtime) return "running";
  if (t.status === "OK") return "ok";
  if (t.status?.startsWith("WARNINGS")) return "warning";
  return "failed";
}

export interface RawTaskStatus {
  status?: string;
  exitstatus?: string;
}
export function taskView(status: RawTaskStatus, log: { n?: number; t?: string }[], max = 200) {
  const finished = status.status === "stopped";
  const exit = status.exitstatus ?? "";
  return {
    finished,
    result: !finished ? "running" : exit === "OK" ? "ok" : exit.startsWith("WARNINGS") ? "warning" : "failed",
    message: finished && exit !== "OK" ? plainError(exit) : "",
    lines: log.map((l) => l.t ?? "").filter((l) => l !== "no content").slice(-max),
  };
}

export interface RawBackupStorage {
  shared?: number;
  storage: string;
  avail?: number;
  active?: number;
  enabled?: number;
}
/** What a person needs to see before restarting a server. Running jobs block the restart. */
export function buildRebootPlan(active: Section<RawTask[]>, storages: Section<RawBackupStorage[]>, cantMove: string[] = []) {
  return {
    cantMove,
    // Someone's open console isn't work in progress, and it shouldn't hold up a restart.
    busy: active.available ? active.value.filter((t) => !QUIET_TASKS.has(t.type ?? "")).map((t) => `${friendlyTask(t)}${t.id ? ` on ${t.id}` : ""}`) : [],
    busyKnown: active.available,
    backupStorages: storages.available
      ? storages.value.filter((s) => s.active !== 0 && s.enabled !== 0).map((s) => ({ name: s.storage, freeGb: gb(s.avail), shared: s.shared === 1 }))
      : [],
  };
}

export interface RawMovePrecondition {
  allowed_nodes?: string[];
  not_allowed_nodes?: Record<string, { unavailable_storages?: string[] }>;
  local_disks?: unknown[];
  local_resources?: unknown[];
  running?: number | boolean;
}
/** What a person needs to see before moving a VM. Containers restart to move; VMs move live. */
export function buildMovePlan(type: "qemu" | "lxc", from: string, nodes: string[], raw: RawMovePrecondition, running: boolean) {
  const others = nodes.filter((n) => n !== from);
  // Proxmox can list a usable server here with an empty entry, so only a stated reason counts.
  const blocked = Object.fromEntries(
    Object.entries(raw.not_allowed_nodes ?? {}).filter(([, b]) => Object.keys(b).length > 0),
  );
  const targets = (raw.allowed_nodes ?? others).filter((n) => n !== from && !blocked[n]);
  const local = (raw.local_resources ?? []).length > 0;
  return {
    targets,
    blocked: Object.entries(blocked).map(([name, b]) => ({ name, storages: b.unavailable_storages ?? [] })),
    localResources: local,
    localDisks: (raw.local_disks ?? []).length > 0,
    interrupts: running && type === "lxc",
  };
}

export interface RollingInput {
  name: string;
  online: boolean;
  version: string | null;
  updates: number | null;
  rebootNeeded: boolean;
  busy: string[];
  cantMove: string[];
  /** Guests that only need a disc ejected to move (ADR 0026). */
  ejectable?: { id: number; name: string; slots: string[]; node: string }[];
}
const versionParts = (v: string | null) => (v ?? "").split(/[.-]/).map((p) => Number(p) || 0);
function olderFirst(a: RollingInput, b: RollingInput): number {
  const [x, y] = [versionParts(a.version), versionParts(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return a.name.localeCompare(b.name);
}
/**
 * What has to be true before updating a cluster one server at a time. Oldest goes first, because guests
 * should only ever move to the same or a newer version. A cluster that keeps fewer than three votes still
 * works, but can't make changes while a server is down, so that's a warning and not a refusal.
 */
export function buildRollingPlan(servers: RollingInput[], quorate: Section<boolean>, tieBreaker: Section<{ State?: string }>) {
  const blocked: string[] = [];
  const offline = servers.filter((s) => !s.online).map((s) => s.name);
  if (offline.length) blocked.push(`Bring these back online first: ${offline.join(", ")}.`);
  if (!quorate.available) blocked.push("BossMox can't tell whether the cluster is healthy.");
  else if (!quorate.value) blocked.push("The cluster has lost its majority, so it can't make changes right now.");
  const unknown = servers.filter((s) => s.online && s.updates === null).map((s) => s.name);
  if (unknown.length) blocked.push(`BossMox can't read the updates on: ${unknown.join(", ")}.`);
  for (const s of servers) if (s.busy.length) blocked.push(`${s.name} is busy. Wait for this to finish: ${s.busy.join(", ")}.`);
  // Guests only have to move off a server that's going to restart.
  for (const s of servers) if (s.rebootNeeded && (s.updates ?? 0) > 0) blocked.push(...s.cantMove);
  const tieVote = tieBreaker.available && tieBreaker.value.State === "Connected" ? 1 : 0;
  const votes = servers.length + tieVote;
  return {
    blocked,
    // Offered beside the reasons, so a disc can be ejected from the same window.
    ejectable: servers.filter((s) => s.rebootNeeded && (s.updates ?? 0) > 0).flatMap((s) => s.ejectable ?? []),
    votes,
    keepsMajority: votes >= 3,
    servers: [...servers].sort(olderFirst).filter((s) => (s.updates ?? 0) > 0).map(({ name, version, updates, rebootNeeded }) => ({ name, version, updates, rebootNeeded })),
  };
}

export function buildServerDetail(
  name: string,
  status: Section<RawStatus>,
  updates: Section<RawUpdate[]>,
  repos: Section<RawRepositories>,
  subscription: Section<RawSubscription>,
  services: Section<RawService[]>,
  tasks: Section<RawTask[]>,
  clusterStatus: Section<{ type?: string }[]>,
) {
  const s = status.available ? status.value : undefined;
  // A standalone server never starts corosync, so that isn't a fault. Unknown means assume clustered.
  const standalone = clusterStatus.available && !clusterStatus.value.some((c) => c.type === "cluster");
  const expectedOff = (v: RawService) => standalone && (v.service ?? v.name) === "corosync";
  return {
    name,
    summary: s
      ? {
          proxmoxVersion: s.pveversion?.split("/")[1] ?? "Unknown",
          kernel: s["current-kernel"]?.release ?? "Unknown",
          uptime: friendlyUptime(s.uptime),
          uptimeSeconds: s.uptime ?? 0,
          processor: s.cpuinfo?.model ?? "Unknown",
          cpus: Number(s.cpuinfo?.cpus ?? 0),
          memUsedGb: gb(s.memory?.used),
          memTotalGb: gb(s.memory?.total),
          diskUsedGb: gb(s.rootfs?.used),
          diskTotalGb: gb(s.rootfs?.total),
        }
      : null,
    updates: updates.available ? groupUpdates(updates.value) : null,
    channel: repos.available ? updateChannel(repos.value, subscription.available ? subscription.value : undefined) : null,
    services: services.available
      ? services.value
          .filter((v) => v["unit-state"] !== "not-found" && v["unit-state"] !== "masked")
          .map((v) => ({ name: v.desc || v.name || v.service || "Unknown", running: v.state === "running", enabled: v["unit-state"] === "enabled" && !expectedOff(v) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : null,
    tasks: tasks.available
      ? tasks.value.map((t) => ({ upid: t.upid, what: friendlyTask(t), target: t.id ?? "", who: t.user ?? "", startedAt: t.starttime ?? null, result: taskResult(t) }))
      : null,
  };
}
export type ServerDetail = ReturnType<typeof buildServerDetail>;
