/** Turns raw Proxmox node answers into the Servers app's plain-language view. */

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
  files?: { path?: string; repositories?: RawRepository[] }[];
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

export function updateChannel(repos: RawRepositories, subscription?: RawSubscription) {
  const enabled = (repos.files ?? [])
    .flatMap((f) => f.repositories ?? [])
    .filter((r) => r.Enabled && (r.URIs ?? []).some((u) => /proxmox\.com\/debian\/pve/.test(u)));
  const components = enabled.flatMap((r) => r.Components ?? []);
  const active = subscription?.status?.toLowerCase() === "active";
  if (components.includes("pve-no-subscription") && !active) {
    return { name: "Free (no subscription)", ok: true, note: "" };
  }
  if (components.includes("pve-enterprise")) {
    return subscription && !active
      ? { name: "Enterprise", ok: false, note: "This channel needs a subscription, so updates can't download." }
      : { name: "Enterprise", ok: true, note: "" };
  }
  if (components.includes("pve-no-subscription")) return { name: "Free (no subscription)", ok: true, note: "" };
  if (components.includes("pve-test")) return { name: "Test", ok: true, note: "Test updates aren't meant for production." };
  return { name: "None", ok: false, note: "No Proxmox update channel is turned on, so Proxmox can't update." };
}

const TASKS: Record<string, string> = {
  aptupdate: "Check for updates",
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
  vncshell: "Shell session",
  termproxy: "Shell session",
};
export const friendlyTask = (t: RawTask) => TASKS[t.type ?? ""] ?? t.type ?? "Task";

export function taskResult(t: RawTask): "running" | "ok" | "warning" | "failed" {
  if (!t.status && !t.endtime) return "running";
  if (t.status === "OK") return "ok";
  if (t.status?.startsWith("WARNINGS")) return "warning";
  return "failed";
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
          processor: s.cpuinfo?.model ?? "Unknown",
          cpus: s.cpuinfo?.cpus ?? 0,
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
      ? tasks.value.map((t) => ({ what: friendlyTask(t), target: t.id ?? "", who: t.user ?? "", startedAt: t.starttime ?? null, result: taskResult(t) }))
      : null,
  };
}
export type ServerDetail = ReturnType<typeof buildServerDetail>;
