export class StorageError extends Error {}

export const USES: Record<string, string> = {
  images: "VM disks",
  rootdir: "Container disks",
  backup: "Backups",
  iso: "Installer discs",
  vztmpl: "Container templates",
};
const BLOCK_ONLY = new Set(["zfspool", "lvmthin", "lvm", "rbd"]);
const KIND_WORDS: Record<string, string> = {
  nfs: "Network share (NFS)",
  cifs: "Network share (SMB)",
  dir: "Folder",
  zfspool: "ZFS",
  lvmthin: "LVM-thin",
  lvm: "LVM",
  rbd: "Ceph",
  cephfs: "CephFS",
  pbs: "Proxmox Backup Server",
};

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;
const EXPORT = /^\/[\w./-]{0,250}$/;
const SHARE = /^[\w.-][\w. -]{0,79}$/;
const USER = /^[\w.@-]{1,64}$/;
const DOMAIN = /^[\w.-]{1,64}$/;
const POOL = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;
const DEVICE = /^\/dev\/[a-z][a-z0-9/_-]{0,60}$/;

export const hostIsValid = (host: string) => HOST.test(host);
export const deviceIsValid = (disk: string) => DEVICE.test(disk);

/**
 * The storage's new content list. Uses BossMox doesn't show (snippets, imports) are kept as they were, so changing
 * what a storage is for here never quietly turns off something set up in Proxmox.
 */
export function usesForm(type: string, uses: unknown, current = ""): string {
  const list = Array.isArray(uses) ? uses.filter((u): u is string => typeof u === "string" && Object.hasOwn(USES, u)) : [];
  const allowed = BLOCK_ONLY.has(type) ? list.filter((u) => u === "images" || u === "rootdir") : list;
  if (!allowed.length) throw new StorageError("Pick at least one thing to keep there.");
  const kept = current.split(",").filter((u) => u && !Object.hasOwn(USES, u));
  return [...new Set([...allowed, ...kept])].join(",");
}

export interface NetworkShare {
  kind: string;
  id: string;
  host: string;
  path: string;
  username: string;
  password: string;
  domain: string;
  uses: unknown;
}

/** One thing can't be slipped in through another: Proxmox reads these values, so each is checked for its own shape. */
export function networkForm(v: NetworkShare): Record<string, string> {
  if (!ID.test(v.id)) throw new StorageError("A name starts with a letter and uses letters, numbers, dots and dashes.");
  if (!HOST.test(v.host)) throw new StorageError("That address isn't valid.");
  if (v.kind === "nfs") {
    if (!EXPORT.test(v.path)) throw new StorageError("Pick a shared folder.");
    return { storage: v.id, type: "nfs", server: v.host, export: v.path, content: usesForm("nfs", v.uses) };
  }
  if (v.kind !== "smb") throw new StorageError("Pick NFS or SMB.");
  if (!SHARE.test(v.path)) throw new StorageError("Pick a shared folder.");
  if (v.username && !USER.test(v.username)) throw new StorageError("That username isn't valid.");
  if (v.domain && !DOMAIN.test(v.domain)) throw new StorageError("That domain isn't valid.");
  if (v.username && !v.password) throw new StorageError("Enter the password for that username.");
  return {
    storage: v.id,
    type: "cifs",
    server: v.host,
    share: v.path,
    content: usesForm("cifs", v.uses),
    ...(v.username ? { username: v.username, password: v.password } : {}),
    ...(v.domain ? { domain: v.domain } : {}),
  };
}

export interface RawDisk {
  devpath?: string;
  size?: number;
  model?: string;
  vendor?: string;
  serial?: string;
  type?: string;
  used?: string;
  health?: string;
  wearout?: number | string;
  mounted?: number | boolean;
  parent?: string;
}

/** Health Proxmox reports when it knows a disk is in trouble, as opposed to not knowing at all. */
const healthBad = (h = "") => h !== "" && !["OK", "PASSED", "UNKNOWN"].includes(h.toUpperCase());
/** Wiping these takes live data with it even though nothing shows as mounted. */
const HOLDS_DATA = /LVM|ZFS|Device Mapper|mounted|ceph|raid|crypt|LUKS|bcache/i;

/**
 * `passedThrough` names devices guests use directly (/dev/disk/by-id/... or /dev/sdX, from their settings) with the
 * guest's name. Such a drive looks unused on the node, but a VM is reading and writing it (security review M2).
 */
export function readHardDisks(raw: RawDisk[], passedThrough: { device: string; guest: string }[] = []) {
  const parts = raw.filter((d) => d.parent);
  const ownerOf = (d: RawDisk) => {
    const names = [d.devpath, (d as RawDisk & { by_id_link?: string }).by_id_link, ...parts.filter((p) => p.parent === d.devpath).map((p) => p.devpath)].filter(Boolean);
    return passedThrough.find((x) => names.includes(x.device) || names.includes(x.device.replace(/-part\d+$/, "")))?.guest ?? "";
  };
  return raw
    .filter((d) => !d.parent && d.devpath)
    .map((d) => {
      const children = parts.filter((p) => p.parent === d.devpath);
      const vm = ownerOf(d);
      const busy = Boolean(vm) || Boolean(d.mounted) || children.some((p) => Boolean(p.mounted) || HOLDS_DATA.test(p.used ?? "")) || HOLDS_DATA.test(d.used ?? "");
      const free = !vm && !d.used && !children.length;
      return {
        path: d.devpath as string,
        sizeGb: Math.round(((d.size ?? 0) / 1024 ** 3) * 10) / 10,
        model: d.model && d.model !== "unknown" ? d.model.replace(/_/g, " ") : "",
        kind: d.type && d.type !== "unknown" ? d.type.toUpperCase() : "",
        used: vm ? `given to ${vm}` : d.used ?? "",
        health: d.health ?? "UNKNOWN",
        failing: healthBad(d.health),
        wearLeft: typeof d.wearout === "number" ? d.wearout : null,
        free,
        canWipe: !free && !busy,
      };
    });
}
export type HardDisk = ReturnType<typeof readHardDisks>[number];

const needs = (ok: boolean, line: string) => {
  if (!ok) throw new StorageError(line);
};

export function diskStorageForm(kind: string, disks: HardDisk[], v: { name: string; devices: string[]; raid: string; filesystem: string }): Record<string, string> {
  if (!["zfs", "lvmthin", "directory"].includes(kind)) throw new StorageError("Pick a type of storage.");
  needs(POOL.test(v.name), "A name starts with a letter and uses letters, numbers, dashes and underscores.");
  needs(v.devices.length > 0, "Pick a disk.");
  needs(new Set(v.devices).size === v.devices.length, "Pick each disk once.");
  for (const d of v.devices) {
    const found = disks.find((x) => x.path === d);
    needs(found !== undefined, "One of those disks isn't on this node.");
    needs(found?.free === true, `${d} is already in use. Wipe it first.`);
  }
  if (kind !== "zfs") {
    needs(v.devices.length === 1, "This type uses one disk.");
    const [device] = v.devices as [string];
    if (kind === "lvmthin") return { name: v.name, device, add_storage: "1" };
    needs(["ext4", "xfs"].includes(v.filesystem), "Pick ext4 or xfs.");
    return { name: v.name, device, filesystem: v.filesystem, add_storage: "1" };
  }
  const n = v.devices.length;
  const rule: Record<string, [boolean, string]> = {
    single: [n === 1, "One disk on its own has no copies. Use one disk for this."],
    mirror: [n >= 2, "A mirror needs at least 2 disks."],
    raidz: [n >= 3, "This needs at least 3 disks."],
    raidz2: [n >= 4, "This needs at least 4 disks."],
    raid10: [n >= 4 && n % 2 === 0, "This needs an even number of disks, at least 4."],
  };
  const check = Object.hasOwn(rule, v.raid) ? rule[v.raid] : undefined;
  if (!check) throw new StorageError("Pick how the disks work together.");
  needs(check[0], check[1]);
  return { name: v.name, raidlevel: v.raid, devices: v.devices.join(","), ashift: "12", compression: "on", add_storage: "1" };
}

export function assertCanWipe(disks: HardDisk[], path: string) {
  const d = disks.find((x) => x.path === path);
  needs(d !== undefined, "That disk isn't on this node.");
  needs(d?.free === false, `${path} is already empty.`);
  needs(d?.canWipe === true, `${path} is in use, so BossMox won't wipe it. Anything mounted, or holding LVM or ZFS, has to be cleared in Proxmox first.`);
}

export type Purpose = "vms" | "files" | "both";
const PURPOSE_USES: Record<Purpose, string> = { vms: "images,rootdir", files: "iso,vztmpl,backup", both: "images,rootdir,iso,vztmpl,backup" };

/**
 * Guided Add storage (ADR 0015): the person says which drives and what for, and this picks the type and says in
 * plain words what will happen. The same answer drives the summary and the doing, so they can't disagree.
 */
export function setupPlan(disks: HardDisk[], devices: string[], purpose: string, name: string) {
  if (purpose !== "vms" && purpose !== "files" && purpose !== "both") throw new StorageError("Pick what it's for.");
  needs(POOL.test(name), "A name starts with a letter and uses letters, numbers, dashes and underscores.");
  needs(devices.length > 0, "Pick a drive.");
  needs(new Set(devices).size === devices.length, "Pick each drive once.");
  const picked = devices.map((d) => {
    const found = disks.find((x) => x.path === d);
    needs(found !== undefined, "One of those drives isn't on this node.");
    needs(found!.free || found!.canWipe, `${d} is in use by something BossMox won't erase. Check it in Proxmox first.`);
    return found!;
  });
  const n = picked.length;
  if (purpose !== "vms") needs(n === 1, purpose === "files" ? "Pick one drive for backups and installer discs." : "To use several drives together, pick VMs and containers. Backups belong on a different drive from the guests anyway.");
  const smallest = Math.min(...picked.map((d) => d.sizeGb));
  const kind = purpose === "vms" ? (n === 1 ? "lvmthin" : "zfs") : "directory";
  const raid = kind === "zfs" ? (n === 2 ? "mirror" : "raidz") : "";
  const names = picked.map((d) => (d.model ? `${d.model} (${d.path})` : d.path)).join(" and ");
  const what = { vms: "VM and container disks", files: "backups, installer discs and templates", both: "VM and container disks, backups, installer discs and templates" }[purpose];
  const how = kind === "lvmthin"
    ? "a pool where disks take space only as they fill, with snapshots"
    : kind === "directory"
      ? `a folder${purpose === "both" ? ", where VM disks are kept as files that can be snapshotted" : ""}`
      : raid === "mirror"
        ? "a mirror, where both drives hold the same data so one can fail without losing anything"
        : `a RAID-Z pool across ${n} drives, where one can fail without losing anything`;
  const usable = kind === "zfs" ? (raid === "mirror" ? smallest : smallest * (n - 1)) : smallest;
  const uneven = n > 1 && picked.some((d) => d.sizeGb > smallest * 1.1) ? " The drives aren't the same size, so each only gives as much as the smallest." : "";
  const erased = picked.filter((d) => !d.free);
  return {
    kind,
    raid,
    filesystem: kind === "directory" ? "ext4" : "",
    uses: PURPOSE_USES[purpose],
    wipe: erased.map((d) => d.path),
    summary: `BossMox will make ${name} on ${names}. It will be ${how}, and hold ${what}, about ${Math.round(usable)} GB.${uneven} Everything on ${n === 1 ? "this drive" : "these drives"} is erased${erased.length ? `, including the old data on ${erased.map((d) => d.path).join(" and ")}` : ""}.`,
  };
}

export interface RawStorageConfig {
  storage: string;
  type?: string;
  content?: string;
  shared?: number;
  disable?: number;
  nodes?: string;
  server?: string;
  export?: string;
  share?: string;
  path?: string;
  pool?: string;
  vgname?: string;
  thinpool?: string;
}
interface Usage {
  name: string;
  node: string;
  freeGb: number;
  totalGb: number;
  online: boolean;
}

export function buildStorageList(config: RawStorageConfig[], usage: Usage[]) {
  return config
    .map((s) => {
      const here = usage.filter((u) => u.name === s.storage);
      const type = s.type ?? "";
      // A share looks the same from every node, so its space only counts once.
      const shared = s.shared === 1 || type === "nfs" || type === "cifs" || type === "cephfs" || type === "rbd" || type === "pbs";
      const counted = (shared ? here.filter((u) => u.online).slice(0, 1) : here.filter((u) => u.online));
      const where = s.server ? `${s.server}${s.export ?? (s.share ? `/${s.share}` : "")}` : s.path ?? s.pool ?? s.vgname ?? "";
      return {
        id: s.storage,
        type,
        kind: KIND_WORDS[type] ?? type,
        where,
        uses: (s.content ?? "").split(",").filter((c) => Object.hasOwn(USES, c)),
        usesAllowed: Object.keys(USES).filter((u) => !BLOCK_ONLY.has(type) || u === "images" || u === "rootdir"),
        disabled: s.disable === 1,
        network: type === "nfs" || type === "cifs",
        nodes: here.map((u) => u.node),
        missing: here.filter((u) => !u.online).map((u) => u.node),
        freeGb: Math.round(counted.reduce((sum, u) => sum + u.freeGb, 0)),
        totalGb: Math.round(counted.reduce((sum, u) => sum + u.totalGb, 0)),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** What would break if this storage went away. Saved copies on it aren't listed: they stay where they are. */
export function storageBlockers(id: string, guests: { name: string; usesStorage: string[] }[], jobs: { storage?: string }[]) {
  const out = guests.filter((g) => g.usesStorage.includes(id)).map((g) => g.name);
  if (jobs.some((j) => j.storage === id)) out.push("a backup schedule");
  return out;
}
