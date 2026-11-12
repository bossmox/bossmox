/**
 * Storage as disks and pools (ADR 0014): which physical disk each Proxmox storage lives on, what's using its
 * space, and what it can do, in the words someone from Windows, Hyper-V or ESXi would use. Pure: server.ts
 * gathers Proxmox's answers for one node and passes them in.
 */
import { eraseBlocker, type RawDisk, type RawStorageConfig } from "./storage.js";

export interface RawLvm {
  children?: { name: string; children?: { name: string }[] }[];
}
export interface RawZfsDetail {
  name?: string;
  children?: RawZfsDetail[];
  leaf?: number;
}
export interface RawMount {
  path?: string;
  type?: string;
  unitfile?: string;
}
export interface RawStorageStatus {
  storage: string;
  type?: string;
  active?: number;
  enabled?: number;
  shared?: number;
  total?: number;
  used?: number;
  avail?: number;
}
export interface RawVolume {
  volid?: string;
  content?: string;
  size?: number;
  /** Space a disk kept as a file really takes. Proxmox leaves it out for pool volumes. */
  used?: number;
  vmid?: number | string;
}
/** A guest as storage needs it: who it is, and every volume its settings name. */
export interface GuestRefs {
  vmid: number;
  name: string;
  /** False when Proxmox didn't give its settings, so what it refers to is unknown. */
  known: boolean;
  refs: string[];
}

const ITEM_KIND: Record<string, string> = { images: "disk", rootdir: "disk", iso: "disc", vztmpl: "template", backup: "backup", import: "import", snippets: "snippet" };

/**
 * Whether this volume is a backup in this storage's own listing. Delete backup only deletes what this says yes to,
 * so a request naming a guest's disk is refused instead of reaching Proxmox (review S4).
 */
export const isListedBackup = (volumes: RawVolume[], volid: string) => volumes.some((v) => v.volid === volid && v.content === "backup");

/**
 * What's on a pool, and whether each thing can be deleted from BossMox (ADR 0015). Proxmox itself deletes a disk
 * that a VM still uses without a word (measured in the lab), so this is the check, and the server runs it again
 * on every delete. A disk is only ever deletable when no guest in the cluster owns it or refers to it.
 */
export function poolItems(volumes: RawVolume[], guests: GuestRefs[], allNodesOnline: boolean, seesAllGuests = true) {
  const byId = new Map(guests.map((g) => [g.vmid, g]));
  const allKnown = guests.every((g) => g.known);
  return volumes
    .filter((v) => v.volid && v.content)
    .map((v) => {
      const volid = v.volid as string;
      const kind = ITEM_KIND[v.content ?? ""] ?? "other";
      const file = volid.slice(volid.indexOf(":") + 1);
      const vmid = Number(v.vmid ?? 0) || null;
      const owner = vmid ? byId.get(vmid) : undefined;
      // A disk's own name, such as vm-958-disk-0, also turns up inside a linked clone's reference to it.
      const ownName = file.split("/").pop() ?? file;
      const usedBy = guests.filter((g) => g.refs.some((r) => r === volid || (kind === "disk" && r.includes(ownName)))).map((g) => g.name);
      let whyNot = "";
      if (kind === "backup") whyNot = "Backups are kept in the Backups app.";
      else if (kind === "disk" && owner) whyNot = `It's ${owner.name}'s disk.`;
      else if (kind === "snippet" || kind === "other") whyNot = "BossMox doesn't manage these yet.";
      else if (usedBy.length) whyNot = kind === "disc" ? `It's in ${usedBy.join(", ")}'s disc drive.` : `${usedBy.join(", ")} still uses it.`;
      else if (!allNodesOnline) whyNot = "A node is offline, so BossMox can't be sure nothing there uses it.";
      else if (!allKnown) whyNot = eraseBlocker(guests, true) ?? "";
      // A guest this account can't see looks like no guest at all (security review L4), so a disk is only called
      // left over for an account that can see every guest.
      else if (kind === "disk" && !owner) whyNot = eraseBlocker(guests, seesAllGuests) ?? "";
      return {
        volid,
        kind,
        name: kind === "disk" ? ownName : file.replace(/^(iso|vztmpl|import|snippets|backup)\//, ""),
        gb: gb(v.size),
        usedGb: typeof v.used === "number" ? gb(v.used) : null,
        vmid,
        owner: owner?.name ?? "",
        leftover: kind === "disk" && !owner && !usedBy.length,
        canDelete: whyNot === "",
        whyNot,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
export type PoolItem = ReturnType<typeof poolItems>[number];

export interface NodeStorageInput {
  node: string;
  disks: RawDisk[];
  lvm: RawLvm | null;
  zfs: Record<string, RawZfsDetail>;
  directory: RawMount[];
  config: (RawStorageConfig & { thinpool?: string; sparse?: number; is_mountpoint?: string })[];
  status: RawStorageStatus[];
  rootfs: { total?: number } | null;
  content: Record<string, RawVolume[]>;
  /** Storages whose contents couldn't be read. Never treated as empty (security review 2026-11-09, M1). */
  contentUnknown?: string[];
  /** Drives guests use directly, by path, with the guest's name. */
  passedThrough?: { device: string; guest: string }[];
  guests?: GuestRefs[];
  allNodesOnline?: boolean;
  seesAllGuests?: boolean;
}

const GB = 1024 ** 3;
const gb = (n = 0) => Math.round((n / GB) * 10) / 10;
const NETWORK = new Set(["nfs", "cifs", "pbs", "rbd", "cephfs", "glusterfs", "iscsi", "iscsidirect", "esxi"]);
const FILE_TYPES = new Set(["dir", "nfs", "cifs", "glusterfs"]);
const DISK_CONTENT = ["images", "rootdir"];
const FILE_WORDS: Record<string, string> = { iso: "Installer discs", vztmpl: "Container templates", backup: "Backups", import: "Imports", snippets: "Snippets" };
const MOUNTED_FS = new Set(["ext4", "xfs", "btrfs", "ext3"]);

const diskKind = (d: RawDisk) => {
  const t = (d.type ?? "").toLowerCase();
  if (t === "nvme") return "NVMe SSD";
  if (t === "ssd") return "SSD";
  if (t === "hdd") return "Hard drive";
  return "Disk";
};
const badHealth = (h = "") => h !== "" && !["OK", "PASSED", "UNKNOWN"].includes(h.toUpperCase());

/** Finds the whole disk behind a name Proxmox gives: a device, a partition, or a /dev/disk/by-id link. */
function resolver(disks: RawDisk[]) {
  const whole = disks.filter((d) => !d.parent && d.devpath);
  const byPath = new Map(disks.filter((d) => d.devpath).map((d) => [d.devpath as string, d]));
  return (name: string): string | null => {
    const path = name.startsWith("/") ? name : `/dev/${name}`;
    const hit = byPath.get(path);
    if (hit) return hit.parent ?? hit.devpath ?? null;
    const link = path.replace(/-part\d+$/, "");
    const byId = whole.find((d) => (d as RawDisk & { by_id_link?: string }).by_id_link === link);
    return byId?.devpath ?? null;
  };
}

const leaves = (z: RawZfsDetail): string[] => (z.leaf || !z.children?.length ? (z.name ? [z.name] : []) : z.children.flatMap(leaves));

function zfsLayout(z: RawZfsDetail | undefined): string {
  const top = z?.children?.[0]?.children ?? [];
  const groups = top.map((c) => (c.name ?? "").replace(/-\d+$/, ""));
  const n = z ? leaves(z).length : 0;
  if (groups.includes("mirror")) return `Mirror of ${n} disks: one can fail without losing anything.`;
  if (groups.some((g) => g.startsWith("raidz"))) {
    const level = Number(groups.find((g) => g.startsWith("raidz"))?.slice(5) || 1);
    return `RAID-Z across ${n} disks: ${level === 1 ? "one" : level === 2 ? "two" : "three"} can fail without losing anything.`;
  }
  return n > 1 ? `Spread across ${n} disks: if any one fails, everything on it is lost.` : "";
}

function title(type: string, uses: string[]): string {
  const disks = uses.some((u) => DISK_CONTENT.includes(u));
  const files = uses.some((u) => !DISK_CONTENT.includes(u));
  if (type === "nfs") return "Network share (NFS)";
  if (type === "cifs") return "Network share (SMB)";
  if (type === "pbs") return "Backup server";
  if (FILE_TYPES.has(type)) return disks && files ? "Folder for files and disks" : disks ? "Folder for disks" : "Folder for files";
  return disks ? "Pool for VM and container disks" : "Pool, not used for anything yet";
}

function snapshots(type: string): string {
  if (type === "lvmthin" || type === "zfspool" || type === "rbd") return "Snapshots work.";
  if (FILE_TYPES.has(type)) return "Snapshots work for VMs BossMox makes here, not for containers.";
  if (type === "lvm") return "Snapshots don't work here.";
  return "";
}

function otherNodes(type: string, shared: boolean, clustered: boolean): string {
  if (!clustered) return "";
  if (shared) return "Every node can use it, so guests here can move to another node and restart there if this one fails.";
  if (type === "zfspool") return "Only this node can use it. Guests here can be copied to another node on a schedule, if that node has a ZFS pool with the same name.";
  return "Only this node can use it, so guests here can't restart on another node if this one fails.";
}

export interface Pool {
  id: string;
  type: string;
  title: string;
  details: string;
  layout: string;
  uses: string[];
  active: boolean;
  shared: boolean;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  /** Disks here take space only as they fill. */
  thin: boolean;
  /** What the disks given out add up to, when that's more than the pool holds. */
  overGivenGb: number | null;
  /** Each guest's disks here: the size given out, and the space they really take where Proxmox says. */
  guests: { vmid: number; gb: number; usedGb: number | null }[];
  files: { label: string; gb: number }[];
  /** Space used that nothing listed accounts for, such as Proxmox itself on the system disk. */
  otherGb: number;
  otherLabel: string;
  snapshots: string;
  otherNodes: string;
  disks: string[];
  items: PoolItem[];
  contentKnown: boolean;
}
export interface Disk {
  path: string;
  model: string;
  kind: string;
  sizeGb: number;
  health: string;
  failing: boolean;
  wearLeft: number | null;
  system: boolean;
  /** Partitions on it that no storage accounts for, in Proxmox's words (an unused ext4 partition, a Ceph OSD). */
  otherUses: string[];
  /** The guest this whole drive is given to directly, if any. */
  givenTo: string;
}

/**
 * Whether a pool on a local disk can be deleted, and the Proxmox call that does it (ADR 0015). Strict on purpose:
 * never the system disk, never a pool with anything on it or anything using it, never one BossMox can't place.
 */
export function poolRemoval(map: StorageMap, id: string, config: RawStorageConfig | undefined, mounts: (RawMount & { unitfile?: string })[], usedBy: string[]) {
  const pools = map.groups.flatMap((g) => g.pools.map((p) => ({ p, g })));
  const found = pools.find((x) => x.p.id === id);
  if (map.network.some((p) => p.id === id)) throw new Error("That's network storage. Remove unhooks it instead, and nothing on it is erased.");
  if (!found || !config) throw new Error("BossMox can't tell which drive that's on, so it won't erase anything. Use Proxmox's own screen for this one.");
  const { p, g } = found;
  if (g.disks.some((d) => d.system)) throw new Error(`${id} is on the system disk, alongside Proxmox itself. Deleting it would mean changing the system disk, which BossMox doesn't do.`);
  if (usedBy.length) throw new Error(`${usedBy.join(", ")} still ${usedBy.length === 1 ? "uses" : "use"} it. Move or remove ${usedBy.length === 1 ? "that" : "those"} first.`);
  // What Proxmox lists is only what it tracks. A pool that isn't mounted, or whose contents couldn't be read, or
  // with space nothing listed accounts for (another ZFS dataset, loose files), may hold things BossMox never saw.
  if (!p.active) throw new Error(`${id} isn't reachable right now, so BossMox can't see what's on it and won't erase it.`);
  if (!p.contentKnown) throw new Error(`BossMox couldn't read what's on ${id}, so it won't erase it. Try again in a moment.`);
  const unseen = p.thin ? p.usedGb : p.otherGb;
  const allowance = p.thin ? 0.1 : Math.max(1, p.totalGb * 0.015);
  if (!p.items.length && unseen > allowance) throw new Error(`Something Proxmox doesn't keep track of is using ${unseen} GB of ${id}, such as files or other data put there outside Proxmox. BossMox won't erase what it can't see. Check it in Proxmox's own screen.`);
  if (p.items.length) {
    const counts = Object.entries(p.items.reduce<Record<string, number>>((a, i) => {
      a[i.kind] = (a[i.kind] ?? 0) + 1;
      return a;
    }, {})).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
    throw new Error(`There's still something on it: ${counts.join(", ")}. Delete or move ${p.items.length === 1 ? "it" : "them"} first.`);
  }
  const cleanup = "cleanup-config=1&cleanup-disks=1";
  if (config.type === "zfspool") {
    const pool = config.pool ?? "";
    if (!pool || pool.includes("/") || pool === "rpool") throw new Error(`${id} is part of a bigger ZFS pool, so BossMox won't erase it. Use Proxmox's own screen for this one.`);
    return { path: `disks/zfs/${encodeURIComponent(pool)}?${cleanup}`, disks: g.disks.map((d) => d.path) };
  }
  if (config.type === "lvmthin") {
    if (!config.thinpool || !config.vgname || config.vgname === "pve") throw new Error(`BossMox won't erase ${id}. Use Proxmox's own screen for this one.`);
    return { path: `disks/lvmthin/${encodeURIComponent(config.thinpool)}?volume-group=${encodeURIComponent(config.vgname)}&${cleanup}`, disks: g.disks.map((d) => d.path) };
  }
  if (config.type === "dir") {
    const unit = mounts.find((m) => m.path === config.path)?.unitfile ?? "";
    const name = /\/mnt-pve-([^/]+)\.mount$/.exec(unit)?.[1];
    if (!name) throw new Error(`${id} wasn't made by Proxmox's disk tools, so BossMox won't erase it. Use Proxmox's own screen for this one.`);
    return { path: `disks/directory/${encodeURIComponent(name)}?${cleanup}`, disks: g.disks.map((d) => d.path) };
  }
  throw new Error(`BossMox doesn't delete this kind of storage yet. Use Proxmox's own screen for ${id}.`);
}

export function buildStorageMap(input: NodeStorageInput, clustered: boolean) {
  const find = resolver(input.disks);
  const whole = input.disks.filter((d) => !d.parent && d.devpath);
  const parts = input.disks.filter((d) => d.parent);
  const vgDisks = (vg: string) =>
    (input.lvm?.children ?? []).filter((g) => g.name === vg).flatMap((g) => (g.children ?? []).map((pv) => find(pv.name))).filter((p): p is string => !!p);
  const zfsDisks = (pool: string) => (input.zfs[pool] ? leaves(input.zfs[pool]).map(find).filter((p): p is string => !!p) : []);

  // The system disk: Proxmox's own volume group, else its ZFS pool, else the mounted file system the size of root.
  const rootGb = gb(input.rootfs?.total);
  const systemParts = new Set<string>();
  let system = [...new Set(vgDisks("pve"))];
  if (!system.length) system = [...new Set(zfsDisks("rpool"))];
  if (!system.length && rootGb) {
    const best = parts
      .filter((p) => p.mounted && MOUNTED_FS.has(p.used ?? ""))
      .map((p) => ({ p, off: Math.abs(gb(p.size) - rootGb) / rootGb }))
      .sort((a, b) => a.off - b.off)[0];
    if (best && best.off < 0.08 && best.p.parent) {
      system = [best.p.parent];
      systemParts.add(best.p.devpath as string);
    }
  }
  const claimed = new Set(systemParts);

  const status = new Map(input.status.filter((s) => s.enabled !== 0).map((s) => [s.storage, s]));
  const pools: Pool[] = [];
  for (const c of input.config) {
    const s = status.get(c.storage);
    if (!s) continue;
    const type = c.type ?? s.type ?? "";
    const uses = (c.content ?? "").split(",").filter(Boolean);
    const shared = NETWORK.has(type) || c.shared === 1 || s.shared === 1;
    let disks: string[] = [];
    let details = "";
    if (type === "lvmthin" || type === "lvm") {
      disks = vgDisks(c.vgname ?? "");
      details = type === "lvmthin" ? `LVM-thin pool ${c.thinpool ?? ""} in volume group ${c.vgname ?? ""}` : `LVM volume group ${c.vgname ?? ""}`;
    } else if (type === "zfspool") {
      const zpool = (c.pool ?? "").split("/")[0] ?? "";
      disks = zfsDisks(zpool);
      details = `ZFS pool ${c.pool ?? ""}`;
    } else if (type === "dir") {
      details = `Folder ${c.path ?? ""}`;
      const mount = input.directory.find((m) => m.path === c.path);
      if (mount) {
        // Proxmox doesn't say which partition a mount is. The one with that file system and its size is it.
        const total = gb(s.total);
        const best = [...parts, ...whole]
          .filter((p) => p.mounted && p.used === mount.type && !claimed.has(p.devpath as string))
          .map((p) => ({ p, off: total ? Math.abs(gb(p.size) - total) / total : 1 }))
          .sort((a, b) => a.off - b.off)[0];
        if (best && best.off < 0.08) {
          claimed.add(best.p.devpath as string);
          disks = [best.p.parent ?? (best.p.devpath as string)];
          details = `Folder ${c.path ?? ""}, ${mount.type} on ${best.p.devpath}`;
        }
      } else if (!c.is_mountpoint && !/^\/(mnt|media)\//.test(c.path ?? "")) {
        disks = system;
      }
    } else if (shared) {
      details = c.server ? `${c.server}${c.export ?? (c.share ? `/${c.share}` : "")}` : "";
    }

    const volumes = (input.content[c.storage] ?? []).filter((v) => v.content);
    const byGuest = new Map<number, { size: number; used: number | null }>();
    for (const v of volumes.filter((v) => DISK_CONTENT.includes(v.content ?? ""))) {
      const id = Number(v.vmid ?? 0);
      const was = byGuest.get(id) ?? { size: 0, used: 0 };
      byGuest.set(id, { size: was.size + (v.size ?? 0), used: was.used === null || typeof v.used !== "number" ? null : was.used + v.used });
    }
    const fileTotals = new Map<string, number>();
    for (const v of volumes.filter((v) => !DISK_CONTENT.includes(v.content ?? ""))) {
      const label = FILE_WORDS[v.content ?? ""] ?? "Other files";
      fileTotals.set(label, (fileTotals.get(label) ?? 0) + (v.size ?? 0));
    }
    const thin = type === "lvmthin" || (type === "zfspool" && c.sparse === 1);
    const given = [...byGuest.values()].reduce((a, b) => a + b.size, 0);
    const taken = [...byGuest.values()].reduce((a, b) => a + (b.used ?? b.size), 0);
    const listed = [...fileTotals.values()].reduce((a, b) => a + b, 0) + (thin ? 0 : taken);
    const other = Math.max(0, (s.used ?? 0) - (thin ? (s.used ?? 0) : listed));
    pools.push({
      id: c.storage,
      type,
      title: title(type, uses),
      details,
      layout: type === "zfspool" ? zfsLayout(input.zfs[(c.pool ?? "").split("/")[0] ?? ""]) : "",
      uses,
      active: s.active === 1,
      shared,
      totalGb: gb(s.total),
      usedGb: gb(s.used),
      freeGb: gb(s.avail),
      thin,
      overGivenGb: thin && given > (s.total ?? 0) ? gb(given) : null,
      guests: [...byGuest].map(([vmid, b]) => ({ vmid, gb: gb(b.size), usedGb: b.used === null ? null : gb(b.used) })).sort((a, b) => b.gb - a.gb || a.vmid - b.vmid),
      files: [...fileTotals].map(([label, bytes]) => ({ label, gb: gb(bytes) })).sort((a, b) => b.gb - a.gb),
      otherGb: gb(other) >= 0.5 ? gb(other) : 0,
      otherLabel: type === "dir" && disks.length > 0 && disks === system ? "Proxmox itself and other files" : "Other files",
      snapshots: snapshots(type),
      otherNodes: otherNodes(type, shared, clustered),
      disks: [...new Set(disks)],
      items: poolItems(volumes, input.guests ?? [], input.allNodesOnline ?? true, input.seesAllGuests ?? true),
      contentKnown: s.active === 1 && !(input.contentUnknown ?? []).includes(c.storage),
    });
  }

  // Disks joined by a pool (a mirror, a pool spanning two) are shown together, the way a storage pool would be.
  const local = pools.filter((p) => !p.shared);
  const groupOf = new Map<string, number>();
  const groups: string[][] = [];
  for (const p of local.filter((p) => p.disks.length)) {
    const seen = [...new Set(p.disks.map((d) => groupOf.get(d)).filter((g): g is number => g !== undefined))];
    const merged = [...new Set([...p.disks, ...seen.flatMap((g) => groups[g] ?? [])])];
    for (const g of seen) groups[g] = [];
    groups.push(merged);
    for (const d of merged) groupOf.set(d, groups.length - 1);
  }
  for (const d of system) if (!groupOf.has(d)) {
    groups.push([d]);
    groupOf.set(d, groups.length - 1);
  }
  const used = new Set(parts.filter((p) => claimed.has(p.devpath as string)).map((p) => p.devpath));
  const claimedDisks = new Set(local.flatMap((p) => p.disks));
  const givenTo = (d: RawDisk) => {
    const names = [d.devpath, (d as RawDisk & { by_id_link?: string }).by_id_link, ...parts.filter((p) => p.parent === d.devpath).map((p) => p.devpath)];
    return (input.passedThrough ?? []).find((x) => names.includes(x.device) || names.includes(x.device.replace(/-part\d+$/, "")))?.guest ?? "";
  };
  const disk = (d: RawDisk): Disk => {
    const path = d.devpath as string;
    const mine = parts.filter((p) => p.parent === path);
    const vm = givenTo(d);
    const otherUses = system.includes(path) || claimedDisks.has(path)
      ? mine.filter((p) => p.mounted && MOUNTED_FS.has(p.used ?? "") && !used.has(p.devpath) && !system.includes(path)).map((p) => `${p.used} partition ${p.devpath}`)
      : mine.filter((p) => p.used && !/^(EFI|BIOS boot)$/.test(p.used)).map((p) => `${p.used} partition ${p.devpath}`);
    return {
      path,
      model: d.model && d.model !== "unknown" ? d.model.replace(/_/g, " ") : "",
      kind: diskKind(d),
      sizeGb: gb(d.size),
      health: d.health ?? "UNKNOWN",
      failing: badHealth(d.health),
      wearLeft: typeof d.wearout === "number" ? d.wearout : null,
      system: system.includes(path),
      otherUses,
      givenTo: vm,
    };
  };
  const byPath = new Map(whole.map((d) => [d.devpath as string, d]));
  return {
    node: input.node,
    groups: groups
      .filter((g) => g.length)
      .map((g) => ({
        disks: g.map((p) => byPath.get(p)).filter((d): d is RawDisk => !!d).map(disk).sort((a, b) => Number(b.system) - Number(a.system) || a.path.localeCompare(b.path)),
        pools: local.filter((p) => p.disks.some((d) => g.includes(d))).sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => Number(b.disks.some((d) => d.system)) - Number(a.disks.some((d) => d.system)) || (a.disks[0]?.path ?? "").localeCompare(b.disks[0]?.path ?? "")),
    // Nothing on them at all: these are what Make storage can use.
    empty: whole.filter((d) => !groupOf.has(d.devpath as string) && !d.used && !parts.some((p) => p.parent === d.devpath) && !givenTo(d)).map(disk),
    // In use by something that isn't Proxmox storage BossMox can place, such as a Ceph OSD or a leftover partition.
    otherDisks: whole.filter((d) => !groupOf.has(d.devpath as string) && (d.used || parts.some((p) => p.parent === d.devpath) || givenTo(d))).map(disk),
    unplaced: local.filter((p) => !p.disks.length),
    network: pools.filter((p) => p.shared),
  };
}
export type StorageMap = ReturnType<typeof buildStorageMap>;
