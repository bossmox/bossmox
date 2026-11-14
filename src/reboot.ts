/**
 * Restarts a node and waits until it's back: a fresh uptime, and Proxmox counts it online again. Shared by the update
 * run (ADR 0027) and the major upgrade (ADR 0042), so both wait the same way.
 */
import type { Session } from "./auth.js";
import type { RawResource } from "./model.js";
import type { PveClient } from "./pve.js";
import type { RawStatus } from "./server-detail.js";

export const REBOOT_WAIT_MS = 20 * 60 * 1000;

export async function rebootAndWait(
  pve: Pick<PveClient, "get" | "post">,
  session: Session,
  node: string,
  limitMs = REBOOT_WAIT_MS,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<void> {
  const enc = encodeURIComponent(node);
  const asked = now();
  await pve.post<null>(`/nodes/${enc}/status`, session, { command: "reboot" });
  for (const until = asked + limitMs; ; await pause(5000)) {
    const s = await pve.get<RawStatus>(`/nodes/${enc}/status`, session.ticket).catch(() => null);
    const back = s?.uptime !== undefined && s.uptime * 1000 < now() - asked;
    if (back) {
      const resources = await pve.get<RawResource[]>("/cluster/resources?type=node", session.ticket).catch(() => []);
      if (resources.some((r) => r.node === node && r.status === "online")) return;
    }
    if (now() > until) throw new Error(`${node} hasn't come back after ${Math.round(limitMs / 60000)} minutes. Someone may need to look at the node itself.`);
  }
}
