import { readSettings } from "./guest-settings.js";
import { readDisks, readNics } from "./hardware.js";
/** Turns raw Proxmox answers into the plain-language view the screens use. */

export interface RawResource {
  type: string;
  id?: string;
  node?: string;
  name?: string;
  status?: string;
  vmid?: number;
  storage?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  template?: number;
  shared?: number;
  uptime?: number;
}
export type RawConfig = Record<string, string | number | undefined>;
export interface RawSnapshot {
  name: string;
  description?: string;
  snaptime?: number;
}
export interface Guest {
  config?: RawConfig;
  snapshots?: RawSnapshot[];
}
export interface Issue {
  kind: "disk-controller" | "network-card" | "no-backup" | "storage-full" | "server-offline";
  title: string;
  detail: string;
  vmId?: number;
}

const GB = 1024 ** 3;
const gb = (n = 0) => Math.round((n / GB) * 10) / 10;
const pct = (used = 0, total = 0) => (total > 0 ? Math.round((used / total) * 100) : 0);

const OS_NAMES: Record<string, string> = {
  l26: "Linux",
  l24: "Linux (old kernel)",
  win11: "Windows 11 or Server 2022+",
  win10: "Windows 10 or Server 2016/2019",
  win8: "Windows 8 or Server 2012",
  win7: "Windows 7 or Server 2008 R2",
  other: "Other",
  solaris: "Solaris",
};
const SLOW_CONTROLLERS = new Set(["pvscsi", "lsi", "lsi53c810", "megasas"]);
const SLOW_NICS = new Set(["e1000", "e1000e", "vmxnet3", "rtl8139"]);

export function vmIssues(id: number, name: string, config: RawConfig = {}): Issue[] {
  const out: Issue[] = [];
  const disks = Object.entries(config).filter(
    ([k, v]) => /^(ide|sata)\d+$/.test(k) && typeof v === "string" && !v.includes("media=cdrom"),
  );
  const controller = String(config.scsihw ?? "");
  const hasScsiDisk = Object.keys(config).some((k) => /^scsi\d+$/.test(k));
  if (disks.length > 0 || (hasScsiDisk && SLOW_CONTROLLERS.has(controller))) {
    const was = disks[0] ? disks[0][0].replace(/\d+$/, "").toUpperCase() : controller;
    out.push({
      kind: "disk-controller",
      vmId: id,
      title: `${name} is on a slower disk setup`,
      detail: `Its disk uses ${was}, which is slower than VirtIO SCSI. Windows VMs need the driver prepared before switching, or they won't boot.`,
    });
  }
  const nics = Object.entries(config)
    .filter(([k]) => /^net\d+$/.test(k))
    .map(([, v]) => String(v).split("=")[0] ?? "");
  const slowNic = nics.find((n) => SLOW_NICS.has(n));
  if (slowNic) {
    out.push({
      kind: "network-card",
      vmId: id,
      title: `${name} is using a slower network card`,
      detail: `Its network card is ${slowNic}. VirtIO is usually faster.`,
    });
  }
  return out;
}

export const DISC_SLOT = /^(ide|sata|scsi)\d+$/;
/** A VM's disc drives, in slot order, with what's in each: "" for empty, "cdrom" for the node's own drive. */
export function discDrives(config: RawConfig): { slot: string; disc: string }[] {
  return Object.entries(config)
    .filter(([k, v]) => DISC_SLOT.test(k) && String(v).includes("media=cdrom") && !String(v).includes("cloudinit"))
    .map(([slot, v]) => ({ slot, disc: String(v).startsWith("none") ? "" : (String(v).split(",")[0] ?? "") }))
    .sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

export function buildOverview(
  resources: RawResource[],
  guests: Map<number, Guest>,
  notBackedUp: { vmid: number }[],
  now: Date = new Date(),
) {
  const unprotected = new Set(notBackedUp.map((g) => Number(g.vmid)));
  const nodes = resources
    .filter((r) => r.type === "node")
    .map((r) => ({
      name: r.node ?? r.id ?? "unknown",
      online: r.status === "online",
      cpuPct: Math.round((r.cpu ?? 0) * 100),
      cores: r.maxcpu ?? 0,
      memPct: pct(r.mem, r.maxmem),
      memUsedGb: gb(r.mem),
      memTotalGb: gb(r.maxmem),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const vms = resources
    .filter((r) => r.type === "qemu" || r.type === "lxc")
    .map((r) => {
      const id = Number(r.vmid ?? 0);
      const guest = guests.get(id);
      const config = guest?.config;
      // Proxmox's summary list lags a new guest by several seconds, so its own settings win.
      const name = r.name ?? String(config?.name ?? config?.hostname ?? `VM ${id}`);
      const template = r.template === 1 || config?.template === 1;
      // A template never runs, so the usual advice about guests doesn't apply to one.
      const issues = template ? [] : vmIssues(id, name, config);
      if (unprotected.has(id) && !template) {
        issues.push({
          kind: "no-backup",
          vmId: id,
          title: `${name} isn't on a backup schedule`,
          detail: "No backup job includes it. A one-off backup may exist, but nothing is keeping it current.",
        });
      }
      return {
        id,
        name,
        kind: r.type === "lxc" ? "Container" : "Virtual machine",
        type: r.type === "lxc" ? "lxc" : "qemu",
        node: r.node ?? "",
        // A paused guest is still on: Proxmox pauses one for a moment while it's being cloned, among other reasons.
        running: r.status === "running" || r.status === "paused",
        paused: r.status === "paused",
        cpuPct: Math.round((r.cpu ?? 0) * 100),
        cores: Number(r.maxcpu ?? 0),
        memUsedGb: gb(r.mem),
        memTotalGb: gb(r.maxmem),
        diskGb: gb(r.maxdisk),
        os: (Object.hasOwn(OS_NAMES, String(config?.ostype ?? "")) ? OS_NAMES[String(config?.ostype)] : undefined) ?? (config?.ostype ? String(config.ostype) : "Not set"),
        template,
        settings: config ? readSettings(r.type === "lxc" ? "lxc" : "qemu", config) : null,
        // Everything that would break if a storage went away, disc drives and left-over disks included.
        usesStorage: [...new Set(Object.entries(config ?? {}).filter(([k, v]) => /^(scsi|virtio|sata|ide|mp|unused|efidisk|tpmstate)\d+$|^rootfs$/.test(k) && String(v).includes(":")).map(([, v]) => String(v).split(":")[0] as string))],
        disks: config ? readDisks(r.type === "lxc" ? "lxc" : "qemu", config) : [],
        nics: config ? readNics(r.type === "lxc" ? "lxc" : "qemu", config) : [],
        agent: String(config?.agent ?? "").startsWith("1") || /enabled=1/.test(String(config?.agent ?? "")),
        startsAtBoot: config?.onboot === 1,
        memoryMb: Number(config?.memory ?? Math.round((r.maxmem ?? 0) / 1024 ** 2)),
        disc: String(config?.ide2 ?? "").startsWith("none") ? "" : String(config?.ide2 ?? "").split(",")[0],
        // Anything on that slot that isn't a disc drive, such as a data disk, must never be rewritten as one.
        discLocked: config?.ide2 !== undefined && (String(config.ide2).includes("cloudinit") || !String(config.ide2).includes("media=cdrom")),
        // Every disc drive it has, on any slot. The cloud-init drive isn't one a person changes.
        discDrives: discDrives(config ?? {}),
        bridges: [...new Set(Object.entries(config ?? {}).filter(([k]) => /^net\d+$/.test(k)).map(([, v]) => String(v).match(/bridge=([^,]+)/)?.[1]).filter((b): b is string => Boolean(b)))],
        configLoaded: config !== undefined,
        // Every volume its settings name (disks, disc drives, a linked clone's base), so nothing in use gets deleted.
        // Drives handed to it directly, which look unused from the node.
        devices: Object.entries(config ?? {}).filter(([k, v]) => /^(scsi|virtio|sata|ide|mp)\d+$|^rootfs$/.test(k) && String(v).startsWith("/dev/")).map(([, v]) => String(v).split(",")[0] as string),
        refs: Object.values(config ?? {}).map((v) => String(v).split(",")[0] as string).filter((v) => /^[A-Za-z][\w.-]*:[^=\s]+$/.test(v)),
        tech: {
          "Machine type": config?.machine ?? "i440fx (default)",
          Firmware: config?.bios ?? "seabios (default)",
          "Disk controller": config?.scsihw ?? "lsi (default)",
          "CPU type": config?.cpu ?? "kvm64 (default)",
          "VM ID": id,
        },
        snapshots: (guest?.snapshots ?? [])
          .filter((s) => s.name !== "current")
          .map((s) => ({ name: s.name, description: s.description ?? "", takenAt: s.snaptime ?? null })),
        issues,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const storage = resources
    .filter((r) => r.type === "storage")
    .filter((r) => {
      const key = r.shared ? `shared/${r.storage}` : `${r.node}/${r.storage}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      name: r.storage ?? "unknown",
      node: r.shared ? "All nodes" : (r.node ?? ""),
      online: r.status === "available",
      usedGb: gb(r.disk),
      totalGb: gb(r.maxdisk),
      freeGb: gb((r.maxdisk ?? 0) - (r.disk ?? 0)),
      usedPct: pct(r.disk, r.maxdisk),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const issues: Issue[] = vms.flatMap((v) => v.issues);
  for (const n of nodes) {
    if (!n.online) {
      issues.unshift({ kind: "server-offline", title: `${n.name} is offline`, detail: "Proxmox can't reach this server." });
    }
  }
  for (const s of storage) {
    if (s.usedPct >= 85) {
      issues.push({ kind: "storage-full", title: `${s.name} is ${s.usedPct}% full`, detail: `${s.freeGb} GB left on ${s.node}.` });
    }
  }
  const online = nodes.filter((n) => n.online);
  const coreCount = online.reduce((sum, n) => sum + n.cores, 0);
  const memUsedGb = online.reduce((sum, n) => sum + n.memUsedGb, 0);
  const memTotalGb = online.reduce((sum, n) => sum + n.memTotalGb, 0);
  const diskUsedGb = storage.filter((s) => s.online).reduce((sum, s) => sum + s.usedGb, 0);
  const diskTotalGb = storage.filter((s) => s.online).reduce((sum, s) => sum + s.totalGb, 0);
  const cluster = {
    // A busy small node shouldn't count the same as a busy big one.
    cpuPct: coreCount ? Math.round(online.reduce((sum, n) => sum + n.cpuPct * n.cores, 0) / coreCount) : 0,
    cores: coreCount,
    memPct: pct(memUsedGb, memTotalGb),
    memUsedGb: Math.round(memUsedGb * 10) / 10,
    memTotalGb: Math.round(memTotalGb * 10) / 10,
    diskPct: pct(diskUsedGb, diskTotalGb),
    diskUsedGb: Math.round(diskUsedGb * 10) / 10,
    diskTotalGb: Math.round(diskTotalGb * 10) / 10,
  };
  return { updatedAt: now.toISOString(), nodes, vms, storage, issues, cluster };
}
export type Overview = ReturnType<typeof buildOverview>;

/** Linked clones of a template: their disks are built on its base disks, so it can't go while they exist. */
export const clonesOf = (id: number, vms: { id: number; name: string; refs: string[] }[]) =>
  vms.filter((v) => v.id !== id && v.refs.some((r) => r.includes(`base-${id}-disk-`))).map((v) => v.name);
