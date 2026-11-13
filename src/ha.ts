/**
 * Keep this guest running (ADR 0036): Proxmox HA for one guest, with every requirement checked first, a plain warning
 * about the restarts HA can make that weren't needed, and a way back for a guest HA gave up on.
 */
import type { Session } from "./auth.js";
import type { NetCheck } from "./cluster-net.js";
import { HttpError } from "./http-error.js";
import type { RawConfig, RawResource } from "./model.js";
import type { PveClient } from "./pve.js";
import type { HeartbeatState } from "./redundancy.js";
import { tieBreakerVotes } from "./server-detail.js";

export interface HaProblem {
  text: string;
  /** A fix BossMox already has: take the disc out. */
  fix?: "eject";
}

const QEMU_DISK = /^(scsi|virtio|sata|ide)\d+$|^(efidisk|tpmstate)0$/;
const LXC_DISK = /^rootfs$|^mp\d+$/;

/** Every disk and disc must be on storage every node can reach; a disc on a node's own storage can be ejected. */
export function diskProblems(type: "qemu" | "lxc", config: RawConfig, shared: Set<string>, node: string): HaProblem[] {
  const out: HaProblem[] = [];
  for (const [slot, raw] of Object.entries(config)) {
    if (!(type === "qemu" ? QEMU_DISK : LXC_DISK).test(slot)) continue;
    const value = String(raw ?? "");
    const vol = value.split(",")[0] ?? "";
    if (!vol || vol === "none" || value.includes("cloudinit")) continue;
    const cdrom = value.includes("media=cdrom");
    if (!vol.includes(":")) {
      // A container mount point given as a path is a folder on this node.
      out.push({ text: `${slot} is a folder on ${node} itself, which no other node has.` });
      continue;
    }
    const storage = vol.split(":")[0] as string;
    if (shared.has(storage)) continue;
    if (cdrom) out.push({ text: `The disc ${vol.split(/[:/]/).pop()} is on ${storage}, which only ${node} has. Take it out first.`, fix: "eject" });
    else out.push({ text: `Its disk ${slot} is on ${storage}, which only ${node} has. HA needs every disk on storage all the nodes share.` });
  }
  return out;
}

/** HA needs a majority left when one node fails: three votes, or two nodes and a working tie-breaker. */
export function voteProblem(votes: number, nodes: number): HaProblem | null {
  if (nodes < 2) return { text: "HA needs a cluster: with one node, there's nowhere else to start it." };
  if (votes >= 3) return null;
  return { text: `This cluster has only ${votes} votes. When one node fails, the other loses its majority and can't start anything, so HA can't help. A tie-breaker gives it a third vote.` };
}

/**
 * The first time HA is turned on: what fencing is, aimed at the restarts that weren't needed (Rocky, 2026-11-12: "the
 * problem we ran into though was that the server restarted on another host when it didn't need to"), and what this
 * cluster has against them.
 */
export function fencingWarnings(heartbeat: HeartbeatState | null, net: NetCheck | null): { lines: string[]; safe: boolean } {
  const lines: string[] = [];
  if (heartbeat?.state === "offer") lines.push(`The heartbeat has one network. If that network has a hiccup, HA can restart guests that didn't need it. Give it a backup network first: every node has ${heartbeat.network} on a second port (Settings, Redundancy).`);
  else if (heartbeat?.state === "no-port") lines.push("The heartbeat has one network, and not every node has a second port for a backup. If that network has a hiccup, HA can restart guests that didn't need it.");
  else if (heartbeat?.state === "unknown") lines.push(`BossMox can't tell whether the heartbeat has a backup network: ${heartbeat.why}`);
  if (net?.known && net.shared) lines.push(`VM moves run on ${net.moveNet}, the heartbeat's only network. Moves can fill it, and that's what restarted guests that didn't need it on 2026-11-10. Health check has the fix.`);
  const safe = heartbeat?.state === "backed-up" && !(net?.known && net.shared);
  if (safe) lines.push("The heartbeat has a backup network, and moves don't share its only one. That's what keeps HA from restarting guests that didn't need it.");
  return { lines, safe };
}

export interface HaCheck {
  id: number;
  type: "qemu" | "lxc";
  name: string;
  node: string;
  running: boolean;
  /** HA's state when it already manages this guest. */
  state: string | null;
  problems: HaProblem[];
  /** No guest is protected yet: turning this on arms fencing on every node. */
  firstTime: boolean;
  warnings: string[];
  safe: boolean;
}

export interface HaDeps {
  pve: PveClient;
  /** Proxmox's migrate precheck and BossMox's placement for one guest: why it couldn't go anywhere, if so. */
  cantMove: (ticket: string, node: string, id: number) => Promise<string | null>;
  heartbeat: (session: Session) => Promise<HeartbeatState | null>;
  netCheck: (ticket: string) => Promise<NetCheck | null>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  wait: (ms: number) => Promise<void>;
}

const sidOf = (type: "qemu" | "lxc", id: number) => `${type === "lxc" ? "ct" : "vm"}:${id}`;

export function createHa(deps: HaDeps) {
  const { pve } = deps;

  async function guest(ticket: string, id: number) {
    const all = await pve.get<RawResource[]>("/cluster/resources?type=vm", ticket);
    const r = all.find((x) => Number(x.vmid) === id);
    if (!r?.node) throw new HttpError(404, "That guest isn't there anymore.");
    return { r, type: r.type === "lxc" ? ("lxc" as const) : ("qemu" as const), node: r.node };
  }

  /** Everything the switch needs, read fresh. */
  async function check(session: Session, id: number): Promise<HaCheck> {
    const t = session.ticket;
    const { r, type, node } = await guest(t, id);
    const [config, storages, members, qdevice, resources] = await Promise.all([
      pve.get<RawConfig>(`/nodes/${encodeURIComponent(node)}/${type}/${id}/config`, t),
      pve.get<RawResource[]>("/cluster/resources?type=storage", t),
      pve.get<{ quorum_votes?: string | number }[]>("/cluster/config/nodes", t).catch(() => []),
      pve.get<{ State?: string }>("/cluster/config/qdevice", t).catch(() => null),
      pve.get<{ sid?: string }[]>("/cluster/ha/resources", t),
    ]);
    const shared = new Set(storages.filter((s) => s.node === node && s.shared === 1).map((s) => s.storage ?? ""));
    const votes = members.reduce((a, m) => a + Number(m.quorum_votes ?? 1), 0) + (qdevice && tieBreakerVotes(qdevice) ? 1 : 0);
    const problems: HaProblem[] = [];
    const vote = voteProblem(votes, members.length);
    if (vote) problems.push(vote);
    problems.push(...diskProblems(type, config, shared, node));
    // Where it could go, once its disks are fine: a disk problem would only be said twice.
    if (!problems.length) {
      const why = await deps.cantMove(t, node, id).catch((err: Error) => `BossMox couldn't check where it could go: ${err.message}`);
      if (why) problems.push({ text: why });
    }
    const firstTime = !resources.some((x) => /^(vm|ct):/.test(x.sid ?? ""));
    const { lines, safe } = firstTime ? fencingWarnings(await deps.heartbeat(session).catch(() => null), await deps.netCheck(t).catch(() => null)) : { lines: [], safe: true };
    return { id, type, name: r.name ?? `VM ${id}`, node, running: r.status === "running", state: r.hastate ?? null, problems, firstTime, warnings: lines, safe };
  }

  async function protect(session: Session, id: number) {
    const c = await check(session, id);
    if (c.state) throw new HttpError(400, `${c.name} is already protected.`);
    if (c.problems.length) throw new HttpError(400, (c.problems[0] as HaProblem).text);
    await pve.post<null>("/cluster/ha/resources", session, { sid: sidOf(c.type, id), state: "started" });
    deps.audit("ha-protect", session.username, { guest: id });
  }

  async function unprotect(session: Session, id: number) {
    const { type } = await guest(session.ticket, id);
    await pve.delete<null>(`/cluster/ha/resources/${encodeURIComponent(sidOf(type, id))}`, session);
    deps.audit("ha-unprotect", session.username, { guest: id });
  }

  /** A guest HA gave up on: unlock it if it's locked, then disabled and started again under HA. */
  async function recover(session: Session, id: number) {
    const { r, type, node } = await guest(session.ticket, id);
    if (r.hastate !== "error") throw new HttpError(400, `HA hasn't given up on ${r.name ?? id}.`);
    const config = await pve.get<RawConfig>(`/nodes/${encodeURIComponent(node)}/${type}/${id}/config`, session.ticket);
    if (config.lock) {
      if (session.username !== "root@pam" || type !== "qemu")
        throw new HttpError(403, `${r.name ?? id} is locked (${config.lock}). As root on ${node}, run "${type === "lxc" ? "pct" : "qm"} unlock ${id}", then use Fix this again.`);
      await pve.put<null>(`/nodes/${encodeURIComponent(node)}/qemu/${id}/config`, session, { delete: "lock", skiplock: "1" });
    }
    const sid = encodeURIComponent(sidOf(type, id));
    await pve.put<null>(`/cluster/ha/resources/${sid}`, session, { state: "disabled" });
    // HA takes a cycle (about 10 s) to leave its error state; started before then is refused. Proxmox then reports HA's
    // own state ("stopped"), not the word disabled, so the wait is for "no longer error" (lab, 2026-11-12).
    for (let i = 0; ; i++) {
      await deps.wait(3000);
      if ((await guest(session.ticket, id)).r.hastate !== "error") break;
      if (i >= 20) throw new HttpError(502, `HA didn't take ${r.name ?? id} out of its error state within a minute. It's unlocked and set to disabled; try Fix this again shortly.`);
    }
    await pve.put<null>(`/cluster/ha/resources/${sid}`, session, { state: "started" });
    deps.audit("ha-recover", session.username, { guest: id, unlocked: config.lock ? String(config.lock) : "" });
  }

  /** The protected guests with HA's state each, for Settings. */
  async function list(ticket: string) {
    const all = await pve.get<RawResource[]>("/cluster/resources?type=vm", ticket);
    return all.filter((r) => r.hastate).map((r) => ({ id: Number(r.vmid), name: r.name ?? `VM ${r.vmid}`, node: r.node ?? "", state: r.hastate as string })).sort((a, b) => a.name.localeCompare(b.name));
  }

  return { check, protect, unprotect, recover, list };
}
