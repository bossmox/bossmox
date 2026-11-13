/**
 * Usage graphs (ADR 0022): Proxmox's own usage history for a node or guest, turned into plain units and thinned
 * to a size a small chart can draw. Proxmox 9 keeps a point a minute for the last hour and day and one every
 * 30 minutes for the last week; nothing is collected by BossMox.
 */
export const RANGES = ["hour", "day", "week"] as const;
export type Range = (typeof RANGES)[number];
/** The most points a chart gets. A day's 1,440 minutes become 120 points of 12 minutes each. */
export const MAX_POINTS = 120;

export type RawPoint = Record<string, number | undefined>;

export interface UsagePoint {
  /** Seconds since 1970, the start of the bucket. */
  t: number;
  /** Percent of all the cores. */
  cpu: number | null;
  memGb: number | null;
  /** Megabits a second, in and out of the network. */
  netIn: number | null;
  netOut: number | null;
  /** Megabytes a second read and written; guests only (Proxmox doesn't keep it for nodes). */
  diskRead?: number | null;
  diskWrite?: number | null;
}
export interface Usage {
  range: Range;
  kind: "node" | "guest";
  cores: number | null;
  memTotalGb: number | null;
  points: UsagePoint[];
}

const GB = 1024 ** 3;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, places = 2) => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);
/** The average of the numbers present; null when a whole bucket is a gap (the node was off). */
const mean = (values: (number | null)[]) => {
  const have = values.filter((v): v is number => v !== null);
  return have.length ? have.reduce((a, b) => a + b, 0) / have.length : null;
};
const last = (raw: RawPoint[], key: string) => {
  for (let i = raw.length - 1; i >= 0; i--) {
    const v = num(raw[i]![key]);
    if (v !== null) return v;
  }
  return null;
};

export function buildUsage(raw: RawPoint[], kind: "node" | "guest", range: Range): Usage {
  const sorted = raw.filter((p) => num(p.time) !== null).sort((a, b) => a.time! - b.time!);
  const memKey = kind === "node" ? "memused" : "mem";
  const one = (p: RawPoint) => ({
    t: p.time!,
    cpu: num(p.cpu) === null ? null : num(p.cpu)! * 100,
    memGb: num(p[memKey]) === null ? null : num(p[memKey])! / GB,
    // Proxmox keeps bytes a second; networks are spoken of in bits.
    netIn: num(p.netin) === null ? null : (num(p.netin)! * 8) / 1e6,
    netOut: num(p.netout) === null ? null : (num(p.netout)! * 8) / 1e6,
    ...(kind === "guest" ? { diskRead: num(p.diskread) === null ? null : num(p.diskread)! / 1e6, diskWrite: num(p.diskwrite) === null ? null : num(p.diskwrite)! / 1e6 } : {}),
  });
  const each = sorted.map(one);
  const size = Math.max(1, Math.ceil(each.length / MAX_POINTS));
  const points: UsagePoint[] = [];
  for (let i = 0; i < each.length; i += size) {
    const bucket = each.slice(i, i + size);
    const avg = (k: keyof UsagePoint) => round(mean(bucket.map((p) => (p[k] ?? null) as number | null)));
    points.push({
      t: bucket[0]!.t,
      cpu: avg("cpu"),
      memGb: avg("memGb"),
      netIn: avg("netIn"),
      netOut: avg("netOut"),
      ...(kind === "guest" ? { diskRead: avg("diskRead"), diskWrite: avg("diskWrite") } : {}),
    });
  }
  const memTotal = last(sorted, kind === "node" ? "memtotal" : "maxmem");
  return { range, kind, cores: last(sorted, "maxcpu"), memTotalGb: round(memTotal === null ? null : memTotal / GB), points };
}
