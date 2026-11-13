/**
 * The header's notice about Proxmox itself (ADR 0042): a version that has stopped getting updates, and nodes with
 * updates waiting. It reads what Proxmox already knows (each node refreshes its own update list daily) and checks
 * nothing new on the nodes. BossMox has no Proxmox account of its own, so the count is refreshed with a signed-in
 * person's ticket, at most every 5 minutes per person, and each person sees what their own permissions allow. Five
 * minutes, so the header catches up soon after Update all nodes finishes.
 */
import type { Session } from "./auth.js";
import { lifeOf, longDate } from "./lifecycle.js";
import type { PveClient } from "./pve.js";
import { groupUpdates, type RawUpdate } from "./server-detail.js";

export interface ProxmoxNotice {
  /** The oldest version on the cluster whose updates have stopped. */
  ended: { major: number; endOfLife: string; text: string; newer: number | null } | null;
  /** Nodes with updates waiting, by name. */
  updates: { nodes: string[]; total: number } | null;
}

/** The notice for a set of nodes. Pure, for tests. */
export function buildNotice(nodes: { node: string; version: string | null; waiting: number | null }[], now: Date): ProxmoxNotice | null {
  let ended: ProxmoxNotice["ended"] = null;
  for (const n of nodes) {
    const life = n.version ? lifeOf(n.version, now) : null;
    if (life?.state !== "ended" || !life.endOfLife) continue;
    if (!ended || life.major < ended.major) ended = { major: life.major, endOfLife: life.endOfLife, text: `Proxmox VE ${life.major} has ended (${longDate(life.endOfLife)})`, newer: life.newer };
  }
  const waiting = nodes.filter((n) => (n.waiting ?? 0) > 0);
  const updates = waiting.length ? { nodes: waiting.map((n) => n.node), total: waiting.reduce((s, n) => s + (n.waiting ?? 0), 0) } : null;
  return ended || updates ? { ended, updates } : null;
}

export const NOTICE_EVERY_MS = 5 * 60 * 1000;

export function createProxmoxNotice(pve: PveClient, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; notice: ProxmoxNotice | null }>();
  const refreshing = new Set<string>();

  async function read(session: Session): Promise<ProxmoxNotice | null> {
    const t = session.ticket;
    const resources = await pve.get<{ node?: string; status?: string }[]>("/cluster/resources?type=node", t);
    const online = resources.filter((r) => r.node && r.status === "online").map((r) => r.node as string);
    const nodes = await Promise.all(
      online.map(async (node) => {
        const base = `/nodes/${encodeURIComponent(node)}`;
        const [version, updates] = await Promise.all([pve.get<{ version?: string }>(`${base}/version`, t).catch(() => null), pve.get<RawUpdate[]>(`${base}/apt/update`, t).catch(() => null)]);
        return { node, version: version?.version ?? null, waiting: updates ? groupUpdates(updates).total : null };
      }),
    );
    return buildNotice(nodes, new Date(now()));
  }

  return {
    /**
     * What this person last saw, refreshed in the background once it's 5 minutes old, so the overview the desktop
     * asks for every 10 seconds never waits on it. The first call returns nothing and starts the first read.
     */
    get(session: Session): ProxmoxNotice | null {
      const mine = kept.get(session.username);
      if ((!mine || now() - mine.at > NOTICE_EVERY_MS) && !refreshing.has(session.username)) {
        refreshing.add(session.username);
        read(session)
          .then((notice) => kept.set(session.username, { at: now(), notice }))
          .catch(() => kept.set(session.username, { at: now(), notice: mine?.notice ?? null }))
          .finally(() => refreshing.delete(session.username));
      }
      return mine?.notice ?? null;
    },
  };
}
