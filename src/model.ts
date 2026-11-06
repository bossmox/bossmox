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

export function buildOverview(
  resources: RawResource[],
  guests: Map<number, Guest>,
  notBackedUp: { vmid: number }[],
  now: Date = new Date(),
) {
  const unprotected = new Set(notBackedUp.map((g) => g.vmid));
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
    .filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template)
    .map((r) => {
      const id = Number(r.vmid ?? 0);
      const name = r.name ?? `VM ${id}`;
      const guest = guests.get(id);
      const config = guest?.config;
      const issues = vmIssues(id, name, config);
      if (unprotected.has(id)) {
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
        running: r.status === "running",
        cpuPct: Math.round((r.cpu ?? 0) * 100),
        cores: Number(r.maxcpu ?? 0),
        memUsedGb: gb(r.mem),
        memTotalGb: gb(r.maxmem),
        diskGb: gb(r.maxdisk),
        os: OS_NAMES[String(config?.ostype ?? "")] ?? (config?.ostype ? String(config.ostype) : "Not set"),
        startsAtBoot: config?.onboot === 1,
        memoryMb: Number(config?.memory ?? Math.round((r.maxmem ?? 0) / 1024 ** 2)),
        disc: String(config?.ide2 ?? "").startsWith("none") ? "" : String(config?.ide2 ?? "").split(",")[0],
        discLocked: String(config?.ide2 ?? "").includes("cloudinit"),
        bridges: [...new Set(Object.entries(config ?? {}).filter(([k]) => /^net\d+$/.test(k)).map(([, v]) => String(v).match(/bridge=([^,]+)/)?.[1]).filter((b): b is string => Boolean(b)))],
        configLoaded: config !== undefined,
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
      node: r.shared ? "All servers" : (r.node ?? ""),
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
  return { updatedAt: now.toISOString(), nodes, vms, storage, issues };
}
export type Overview = ReturnType<typeof buildOverview>;
