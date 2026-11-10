/**
 * Where each guest goes when a node has to be emptied (ADR 0025). Pure: the numbers come in, a plan comes out,
 * so every rule is unit tested. A guest only goes somewhere it fits, and if anything can't be placed nothing moves.
 */

/** How much room a node keeps after taking guests. Fixed for now; ADR 0025 says why. */
export const ROOM = { memFreePct: 15, cpuMaxPct: 80, storageFreePct: 10 } as const;

export interface StorageRoom {
  free: number;
  total: number;
  shared: boolean;
}
export interface NodeRoom {
  name: string;
  version: string | null;
  cpuModel: string | null;
  cores: number;
  /** Cores busy right now. */
  cpuLoad: number;
  memTotal: number;
  memUsed: number;
  /** The storages this node can use right now, by name. */
  storages: Record<string, StorageRoom>;
}
export interface GuestNeed {
  id: number;
  name: string;
  type: "qemu" | "lxc";
  /** Its full set memory: a VM can grow to it. */
  mem: number;
  cores: number;
  cpuLoad: number;
  /** Every storage it uses, so every one has to exist where it goes. */
  storages: string[];
  /** Volumes on the node's own storage, which get copied across. */
  localDisks: { storage: string; bytes: number }[];
  hostCpu: boolean;
  /** Why it can't move to any node, or null. */
  stuck: string | null;
  /** Nodes Proxmox itself refuses for this guest, with the reason. */
  refused: Record<string, string>;
}
export interface Move {
  id: number;
  name: string;
  type: "qemu" | "lxc";
  target: string;
}
export interface MovePlan {
  moves: Move[];
  /** One plain sentence per guest that can't be placed. Any at all means nothing moves. */
  problems: string[];
}

const GB = 1024 ** 3;
export const gbText = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;
const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: GB, T: 1024 ** 4 };
/** Proxmox writes disk sizes like `size=32G`. A bare number is bytes. */
export function parseSize(value: string): number {
  const m = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/.exec(value);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] ? (UNITS[m[2]] ?? 1) : 1));
}

const versionParts = (v: string | null) => (v ?? "").split(/[.-]/).map((p) => Number(p) || 0);
/** Negative when a is older than b. */
export function compareVersions(a: string | null, b: string | null): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export interface RawPrecondition {
  allowed_nodes?: string[];
  not_allowed_nodes?: Record<string, { unavailable_storages?: string[]; "blocking-ha-resources"?: { sid?: string; cause?: string }[] }>;
  "not-allowed-nodes"?: Record<string, { unavailable_storages?: string[]; "blocking-ha-resources"?: { sid?: string; cause?: string }[] }>;
  local_disks?: { volid?: string; size?: number; cdrom?: number | boolean; is_unused?: number | boolean }[];
  local_resources?: unknown[];
}
export interface GuestFacts {
  id: number;
  name: string;
  type: "qemu" | "lxc";
  mem: number;
  cores: number;
  cpuLoad: number;
  config: Record<string, string | number | undefined>;
  hasSnapshots: boolean;
  /** Proxmox's migrate check for this guest. Empty when it couldn't be read (containers on older Proxmox). */
  precondition: RawPrecondition;
  /** The storages on the node it's on now, to tell its own from shared ones. */
  sourceStorages: Record<string, StorageRoom>;
}

const DISK_SLOT = /^(scsi|virtio|sata|ide|efidisk|tpmstate|unused|mp)\d+$|^rootfs$/;

/** Turns what Proxmox says about a guest into what it needs from the node it goes to. */
export function guestNeed(f: GuestFacts): GuestNeed {
  const volumes = Object.entries(f.config)
    .filter(([k, v]) => DISK_SLOT.test(k) && typeof v === "string" && v.includes(":") && !v.startsWith("/dev/"))
    .map(([slot, v]) => ({ slot, value: String(v), storage: String(v).split(":")[0] ?? "" }));
  const storages = [...new Set(volumes.map((v) => v.storage).filter(Boolean))];
  const isLocal = (storage: string) => f.sourceStorages[storage]?.shared !== true;
  const discs = volumes.filter((v) => v.value.includes("media=cdrom") && !v.value.includes("cloudinit"));
  let stuck: string | null = null;
  if ((f.precondition.local_resources ?? []).length > 0) stuck = `${f.name} uses hardware attached to its node, so it can't move.`;
  else if (discs.some((d) => isLocal(d.storage))) stuck = `${f.name} has a disc image from its node's own storage in its drive, so it can't move. Eject the disc first.`;
  const copied = volumes.filter((v) => !v.value.includes("media=cdrom") && isLocal(v.storage));
  if (!stuck && f.hasSnapshots && copied.length > 0 && f.type === "qemu") stuck = `${f.name} has a snapshot on its node's own storage, so it can't move while running. Delete the snapshot or shut it down first.`;
  // Proxmox's own sizes win for VMs; the settings' size= is the fallback and the only source for containers.
  const measured = new Map((f.precondition.local_disks ?? []).filter((d) => d.volid && !d.cdrom).map((d) => [d.volid as string, Number(d.size ?? 0)]));
  const localDisks = copied.map((v) => ({ storage: v.storage, bytes: measured.get(v.value.split(",")[0] ?? "") || parseSize(v.value) }));
  const refused: Record<string, string> = {};
  const notAllowed = f.precondition.not_allowed_nodes ?? f.precondition["not-allowed-nodes"] ?? {};
  for (const [node, why] of Object.entries(notAllowed)) {
    // Proxmox can list a usable node here with an empty entry, so only a stated reason counts.
    if (why.unavailable_storages?.length) refused[node] = `doesn't have the storage ${why.unavailable_storages.join(", ")}`;
    else if (why["blocking-ha-resources"]?.length) refused[node] = `an HA rule keeps it off (${why["blocking-ha-resources"].map((b) => b.sid).filter(Boolean).join(", ")})`;
  }
  const cpu = String(f.config.cpu ?? "");
  const hostCpu = /^(cputype=)?host(,|$)/.test(cpu);
  return { id: f.id, name: f.name, type: f.type, mem: f.mem, cores: f.cores, cpuLoad: f.cpuLoad, storages, localDisks, hostCpu, stuck, refused };
}

interface Projected extends NodeRoom {
  storages: Record<string, StorageRoom>;
}

/** Why this node can't take this guest, or null if it can. */
function whyNot(g: GuestNeed, n: Projected, from: NodeRoom): string | null {
  if (g.refused[n.name]) return g.refused[n.name] as string;
  const missing = g.storages.filter((s) => !n.storages[s]);
  if (missing.length) return `doesn't have the storage ${missing.join(", ")}`;
  if (compareVersions(n.version, from.version) < 0) return `runs an older Proxmox (${n.version ?? "unknown"}) than ${from.name} (${from.version ?? "unknown"})`;
  if (g.hostCpu && n.cpuModel !== from.cpuModel) return `has a different processor, and ${g.name} is set to the host's exact processor type`;
  if (g.cores > n.cores) return `has ${n.cores} cores and ${g.name} needs ${g.cores}`;
  const keep = (n.memTotal * ROOM.memFreePct) / 100;
  const left = n.memTotal - n.memUsed - g.mem;
  if (left < keep) return `would have ${gbText(Math.max(0, left))} of memory left, under the ${ROOM.memFreePct}% it keeps free (${gbText(keep)})`;
  const load = n.cpuLoad + g.cpuLoad;
  if (load > (n.cores * ROOM.cpuMaxPct) / 100) return `would be ${Math.round((load / Math.max(1, n.cores)) * 100)}% busy, over ${ROOM.cpuMaxPct}%`;
  const need = new Map<string, number>();
  for (const d of g.localDisks) need.set(d.storage, (need.get(d.storage) ?? 0) + d.bytes);
  for (const [storage, bytes] of need) {
    const s = n.storages[storage] as StorageRoom;
    const keepDisk = (s.total * ROOM.storageFreePct) / 100;
    if (s.free - bytes < keepDisk) return `would have ${gbText(Math.max(0, s.free - bytes))} left on ${storage} after copying ${gbText(bytes)}, under the ${ROOM.storageFreePct}% it keeps free`;
  }
  return null;
}

/**
 * Places the running guests of `from` on the other nodes. Biggest first, each onto the node with the most memory
 * left after it, so the load spreads. `nodes` are the online nodes, `from` included.
 */
export function planMoves(from: string, guests: GuestNeed[], nodes: NodeRoom[]): MovePlan {
  const source = nodes.find((n) => n.name === from);
  const others: Projected[] = nodes
    .filter((n) => n.name !== from)
    .map((n) => ({ ...n, storages: Object.fromEntries(Object.entries(n.storages).map(([k, s]) => [k, { ...s }])) }));
  if (!source) return { moves: [], problems: [`BossMox can't read ${from}'s numbers.`] };
  if (!others.length && guests.length) return { moves: [], problems: ["There's no other online node to move anything to."] };
  const moves: Move[] = [];
  const problems: string[] = [];
  const order = [...guests].sort((a, b) => b.mem - a.mem || a.name.localeCompare(b.name));
  for (const g of order) {
    if (g.stuck) {
      problems.push(g.stuck);
      continue;
    }
    const reasons: string[] = [];
    let best: Projected | null = null;
    let bestLeft = -Infinity;
    for (const n of others) {
      const why = whyNot(g, n, source);
      if (why) {
        reasons.push(`${n.name} ${why}`);
        continue;
      }
      const left = n.memTotal - n.memUsed - g.mem;
      if (left > bestLeft) {
        best = n;
        bestLeft = left;
      }
    }
    if (!best) {
      problems.push(`${g.name} (${gbText(g.mem)} memory) has nowhere to go: ${reasons.join("; ")}.`);
      continue;
    }
    best.memUsed += g.mem;
    best.cpuLoad += g.cpuLoad;
    for (const d of g.localDisks) {
      const s = best.storages[d.storage];
      if (s && !s.shared) s.free -= d.bytes;
    }
    moves.push({ id: g.id, name: g.name, type: g.type, target: best.name });
  }
  return problems.length ? { moves: [], problems } : { moves, problems };
}
