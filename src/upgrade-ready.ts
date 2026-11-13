/**
 * Is the cluster ready to upgrade to the next Proxmox VE major version? (ADR 0042, piece 2.) Runs Proxmox's own
 * checker on every node through its root console, which only reads, and adds what BossMox checks itself: free space
 * on root, passthrough VMs, storage types from outside Proxmox. Nothing on the nodes is changed.
 */
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import { lifeOf } from "./lifecycle.js";
import type { ShellResult } from "./node-shell.js";
import type { PveClient } from "./pve.js";
import { attention, parseChecker, type Explained } from "./upgrade-check.js";

/** Proxmox's guide: at least 5 GB free on root, better more than 10. */
export const ROOT_MIN_GB = 5;
export const ROOT_GOOD_GB = 10;
/** Storage types that ship with Proxmox VE. Anything else is a plugin that needs its own update for the new version. */
const BUILT_IN = new Set(["dir", "lvm", "lvmthin", "zfs", "zfspool", "nfs", "cifs", "glusterfs", "iscsi", "iscsidirect", "rbd", "cephfs", "pbs", "btrfs", "esxi"]);

export interface NodeReady {
  node: string;
  version: string | null;
  /** From the checker's summary. */
  counts: { passed: number; warnings: number; failures: number } | null;
  items: Explained[];
  /** Why the checker couldn't run here, if it couldn't. */
  error: string | null;
}
export interface Readiness {
  checkedAt: number | null;
  running: boolean;
  from: number | null;
  to: number | null;
  nodes: NodeReady[];
  /** Ready when every node was checked and nothing blocks. */
  ready: boolean;
  blocking: number;
}

export interface ReadyDeps {
  pve: PveClient;
  console: (node: string, session: Session, line: string) => Promise<ShellResult>;
  now?: () => number;
}

const GB = 1024 ** 3;

/** BossMox's own findings for one node, in the same shape as the checker's. Pure, for tests. */
export function ownChecks(input: { rootFreeGb: number | null; passthrough: string[]; plugins: string[] }): Explained[] {
  const out: Explained[] = [];
  const own = (e: Omit<Explained, "original">): Explained => ({ ...e, original: "" });
  if (input.rootFreeGb === null) out.push(own({ level: "WARN", title: "BossMox couldn't read the free space on root", detail: "", handling: "blocks" }));
  else if (input.rootFreeGb < ROOT_MIN_GB)
    out.push(
      own({
        level: "FAIL",
        title: `Only ${input.rootFreeGb.toFixed(1)} GB free on root`,
        detail: `The upgrade needs at least ${ROOT_MIN_GB} GB. Remove old ISO images, backups or kernels kept on root first.`,
        handling: "blocks",
      }),
    );
  else if (input.rootFreeGb < ROOT_GOOD_GB)
    out.push(own({ level: "NOTICE", title: `${input.rootFreeGb.toFixed(1)} GB free on root`, detail: `Enough, but Proxmox suggests more than ${ROOT_GOOD_GB} GB.`, handling: "advice" }));
  if (input.passthrough.length)
    out.push(
      own({
        level: "NOTICE",
        title: `Passthrough: ${input.passthrough.join(", ")}`,
        detail: "VMs with hardware passed through may not start on the new kernel (6.14). Proxmox's workaround is to keep using the older kernel on this node until it's fixed.",
        handling: "advice",
      }),
    );
  if (input.plugins.length)
    out.push(
      own({
        level: "WARN",
        title: `Storage from outside Proxmox: ${input.plugins.join(", ")}`,
        detail: "Third-party storage plugins need their own update for the new version. Check with whoever makes it before upgrading.",
        handling: "advice",
      }),
    );
  return out;
}

export function createUpgradeReady(deps: ReadyDeps) {
  const now = deps.now ?? Date.now;
  let state: Readiness = { checkedAt: null, running: false, from: null, to: null, nodes: [], ready: false, blocking: 0 };

  async function checkNode(session: Session, node: string, plugins: string[]): Promise<NodeReady> {
    const t = session.ticket;
    const base = `/nodes/${encodeURIComponent(node)}`;
    const [version, status, vms] = await Promise.all([
      deps.pve.get<{ version?: string }>(`${base}/version`, t).catch(() => null),
      deps.pve.get<{ rootfs?: { used?: number; total?: number; avail?: number } }>(`${base}/status`, t).catch(() => null),
      deps.pve.get<{ vmid?: number; name?: string }[]>(`${base}/qemu`, t).catch(() => []),
    ]);
    const v = version?.version ?? null;
    const major = v ? Number.parseInt(v, 10) : Number.NaN;
    const passthrough: string[] = [];
    for (const vm of vms) {
      const cfg = await deps.pve.get<Record<string, unknown>>(`${base}/qemu/${vm.vmid}/config`, t).catch(() => ({}));
      if (Object.keys(cfg).some((k) => /^hostpci\d+$/.test(k))) passthrough.push(vm.name ?? `VM ${vm.vmid}`);
    }
    const rootfs = status?.rootfs;
    const rootFreeGb = rootfs ? (rootfs.avail ?? (rootfs.total ?? 0) - (rootfs.used ?? 0)) / GB : null;
    const own = ownChecks({ rootFreeGb, passthrough, plugins });
    if (!Number.isInteger(major)) return { node, version: v, counts: null, items: own, error: "BossMox couldn't read this node's Proxmox version." };
    try {
      // The checker for this version, pve8to9 on 8. It only reads.
      const r = await deps.console(node, session, `pve${major}to${major + 1} --full`);
      const run = parseChecker(r.output);
      if (!run.summary) return { node, version: v, counts: null, items: own, error: `Proxmox's checker didn't finish on ${node} (exit code ${r.exitCode}).` };
      return { node, version: v, counts: { passed: run.summary.passed, warnings: run.summary.warnings, failures: run.summary.failures }, items: [...attention(run), ...own], error: null };
    } catch (err) {
      return { node, version: v, counts: null, items: own, error: (err as Error).message };
    }
  }

  return {
    view(): Readiness {
      return state;
    },

    /** Starts a check of every node, one at a time. The page asks view() until it's done. */
    async start(session: Session): Promise<void> {
      if (session.username !== "root@pam") throw new HttpError(403, "Proxmox's upgrade checker runs in each node's root console. Sign in as root@pam to run it.");
      if (state.running) throw new HttpError(409, "The check is already running.");
      // Taken before the first wait, so two clicks can't start two checks.
      state = { ...state, running: true };
      const t = session.ticket;
      let resources: { node?: string; status?: string }[];
      let storage: { storage?: string; type?: string }[];
      try {
        [resources, storage] = await Promise.all([
          deps.pve.get<{ node?: string; status?: string }[]>("/cluster/resources?type=node", t),
          deps.pve.get<{ storage?: string; type?: string }[]>("/storage", t).catch(() => []),
        ]);
      } catch (err) {
        state = { ...state, running: false };
        throw err;
      }
      const offline = resources.filter((r) => r.node && r.status !== "online").map((r) => r.node as string);
      const online = resources
        .filter((r) => r.node && r.status === "online")
        .map((r) => r.node as string)
        .sort();
      const plugins = storage.filter((s) => s.type && !BUILT_IN.has(s.type)).map((s) => `${s.storage} (${s.type})`);
      void (async () => {
        const nodes: NodeReady[] = [];
        for (const n of online) nodes.push(await checkNode(session, n, plugins));
        for (const n of offline) nodes.push({ node: n, version: null, counts: null, items: [], error: "This node is offline, so it couldn't be checked." });
        const majors = nodes.map((n) => (n.version ? Number.parseInt(n.version, 10) : Number.NaN)).filter(Number.isInteger);
        const from = majors.length ? Math.min(...majors) : null;
        const life = from ? lifeOf(String(from), new Date(now())) : null;
        const blocking = nodes.reduce((sum, n) => sum + (n.error ? 1 : 0) + n.items.filter((i) => i.handling === "blocks").length, 0);
        state = { checkedAt: now(), running: false, from, to: life?.newer ?? null, nodes, ready: blocking === 0 && nodes.length > 0, blocking };
      })().catch((err: Error) => {
        state = { ...state, running: false, nodes: [{ node: "cluster", version: null, counts: null, items: [], error: err.message }], ready: false, blocking: 1 };
      });
    },
  };
}
export type UpgradeReady = ReturnType<typeof createUpgradeReady>;
