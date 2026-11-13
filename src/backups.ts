export interface RawBackupFile {
  volid?: string;
  vmid?: number | string;
  ctime?: number;
  size?: number;
  subtype?: string;
  notes?: string;
  protected?: number;
}
export interface RawBackupJob {
  id?: string;
  schedule?: string;
  storage?: string;
  vmid?: string;
  all?: number;
  enabled?: number;
  comment?: string;
  "next-run"?: number;
  "prune-backups"?: string | { "keep-last"?: number };
}
export interface BackupSource {
  node: string;
  storage: string;
  file: RawBackupFile;
}
interface GuestName {
  id: number;
  name: string;
}

const DAYS: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

/** Proxmox schedules are calendar events. The everyday ones read as words, and anything else stays as written. */
export function describeSchedule(schedule = ""): string {
  const s = schedule.trim().toLowerCase();
  if (s === "daily") return "Every day at midnight";
  if (s === "weekly") return "Every Monday at midnight";
  const time = s.match(/^\d{1,2}:\d{2}$/);
  if (time) return `Every day at ${s}`;
  const weekly = s.match(/^(mon|tue|wed|thu|fri|sat|sun) (\d{1,2}:\d{2})$/);
  if (weekly) return `Every ${DAYS[weekly[1] as string]} at ${weekly[2]}`;
  return `On the schedule ${schedule}`;
}

/** Older backups may not say what they are, but the file name always does. */
function backupType(file: RawBackupFile): "qemu" | "lxc" {
  if (file.subtype === "qemu" || file.subtype === "lxc") return file.subtype;
  return /vzdump-qemu-/.test(file.volid ?? "") ? "qemu" : "lxc";
}
const sizeText = (bytes = 0) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** Every backup grouped by guest, newest first, including guests that have since been deleted. */
export function buildBackups(sources: BackupSource[], guests: GuestName[], jobs: RawBackupJob[], notBackedUp: { vmid: number }[]) {
  const names = new Map(guests.map((g) => [g.id, g.name]));
  const groups = new Map<number, { id: number; name: string; exists: boolean; type: "qemu" | "lxc"; backups: ReturnType<typeof entry>[] }>();
  function entry({ node, storage, file }: BackupSource) {
    return { volid: file.volid ?? "", node, storage, type: backupType(file), takenAt: file.ctime ?? null, size: sizeText(file.size), notes: file.notes ?? "", locked: file.protected === 1 };
  }
  for (const source of sources) {
    const id = Number(source.file.vmid);
    if (!Number.isInteger(id) || !source.file.volid) continue;
    const group = groups.get(id) ?? { id, name: names.get(id) ?? `Deleted guest ${id}`, exists: names.has(id), type: backupType(source.file), backups: [] };
    group.backups.push(entry(source));
    groups.set(id, group);
  }
  const list = [...groups.values()];
  for (const g of list) g.backups.sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
  const unprotected = new Set(notBackedUp.map((n) => Number(n.vmid)));
  return {
    groups: list.sort((a, b) => a.name.localeCompare(b.name)),
    unscheduled: guests.filter((g) => unprotected.has(g.id)).map((g) => g.name),
    schedules: jobs.map((j) => {
      const keep = typeof j["prune-backups"] === "string" ? Number(j["prune-backups"].match(/keep-last=(\d+)/)?.[1]) : Number(j["prune-backups"]?.["keep-last"]);
      return {
        id: j.id ?? "",
        when: describeSchedule(j.schedule),
        what:
          j.all === 1
            ? "Everything"
            : (j.vmid ?? "")
                .split(",")
                .filter(Boolean)
                .map((v) => names.get(Number(v)) ?? `Guest ${v}`)
                .join(", "),
        storage: j.storage ?? "",
        on: j.enabled !== 0,
        nextRun: j["next-run"] ?? null,
        keep: keep || null,
      };
    }),
  };
}
export type BackupsView = ReturnType<typeof buildBackups>;
