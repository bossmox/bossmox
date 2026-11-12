/**
 * Recommended settings (ADR 0029): Proxmox settings BossMox suggests, each shown as a switch with what it does and
 * why. Everything here is read from and written to Proxmox itself, so nothing is kept in BossMox.
 */
import { FULL_BATCH, type NetCheck } from "./cluster-net.js";

export type SettingId = "move-network" | "move-limit" | "ha-shutdown" | "boot";
export interface Choice {
  value: string;
  label: string;
}
export interface Recommended {
  id: SettingId;
  title: string;
  on: boolean;
  /** What BossMox suggests, or null when it doesn't lean either way. */
  recommend: boolean | null;
  detail: string;
  /** Whether the switch can be flipped now. When it can't, `why` says what's missing. */
  can: boolean;
  why?: string;
  /** A pick that goes with switching it on: which network, how fast. */
  choices?: Choice[];
  choice?: string;
  /** Can only be switched on here. Turning it off is done one guest at a time, on each guest's page. */
  onlyOn?: boolean;
  /** The guests the boot switch would change. */
  guests?: number[];
}

export interface RecommendedInput {
  nodes: number;
  net: NetCheck & { current: string | null };
  /** Proxmox's move speed limit in KiB/s, or null when there isn't one. */
  moveLimit: number | null;
  /** Proxmox's HA shutdown policy; Proxmox's default is "conditional". */
  haPolicy: string;
  haGuests: number;
  noBoot: { id: number; name: string }[];
  /** Whether this person may change the cluster's options (Sys.Modify on /). */
  canChange: boolean;
}

/** Speeds offered for the move limit, in MB/s. 50 leaves about half of a 1 Gb port for everything else. */
export const LIMITS = [25, 50, 100, 250];
export const DEFAULT_LIMIT = 50;
const kib = (mb: number) => mb * 1024;

/** Proxmox gives property strings ("a=1,b=2") either as text or already split up, depending on the version. */
export function props(v: unknown): Record<string, string> {
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
  if (typeof v !== "string" || !v) return {};
  return Object.fromEntries(v.split(",").map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? ["", part] : [part.slice(0, at), part.slice(at + 1)];
  }));
}
const joinProps = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => (k ? `${k}=${v}` : v)).join(",");

const list = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

export function buildRecommended(h: RecommendedInput): Recommended[] {
  const out: Recommended[] = [];
  const cant = h.canChange ? {} : { can: false, why: "Your Proxmox account can't change settings for the whole cluster. That needs the Sys.Modify permission on /." };
  if (h.nodes >= 2) {
    const n = h.net;
    const own = n.known && !n.shared;
    let move: Recommended;
    if (!n.known) {
      move = { id: "move-network", title: "VM moves use their own network", on: false, recommend: true, can: false, detail: "BossMox couldn't tell which networks the nodes share. That happens when a node is offline or a heartbeat address is a name rather than a number.", why: "BossMox moves one VM at a time until it can tell." };
    } else if (own) {
      move = {
        id: "move-network", title: "VM moves use their own network", on: true, recommend: true,
        detail: `Moves run on ${n.moveNet}, so they can't crowd out the heartbeat that tells the nodes the others are alive. BossMox moves up to ${FULL_BATCH} VMs at a time.`,
        can: n.current !== null,
        ...(n.current === null ? { why: "The heartbeat has a second link of its own, so there's nothing to change." } : {}),
        choices: [n.current ?? "", ...n.others.filter((o) => o !== n.current)].filter(Boolean).map((v) => ({ value: v, label: v })),
        choice: n.current ?? "",
      };
    } else {
      move = {
        id: "move-network", title: "VM moves use their own network", on: false, recommend: true,
        detail: `Moves run on ${n.moveNet}, the heartbeat's only network. Heavy moves there can make the nodes lose touch, and HA then restarts a node to protect its guests. Until this is on, BossMox moves one VM at a time.${n.others.length > 1 ? " If you know which network is faster, pick that one." : ""}`,
        can: n.others.length > 0,
        ...(n.others.length ? { choices: n.others.map((v) => ({ value: v, label: v })), choice: n.others[0] } : { why: "Every node needs an address on a second network first, ideally on a second network card." }),
      };
    }
    out.push(move.can ? { ...move, ...cant } : move);

    const shared = n.known && n.shared;
    const limitOn = h.moveLimit !== null && h.moveLimit > 0;
    const mb = limitOn ? Math.round((h.moveLimit as number) / 1024) : DEFAULT_LIMIT;
    const speeds = [...new Set([...LIMITS, mb])].sort((a, b) => a - b);
    out.push({
      id: "move-limit", title: "Limit how fast moves run", on: limitOn, recommend: shared ? true : own ? false : null,
      detail: shared
        ? "Moves share the heartbeat's only network. A limit leaves it room, at the cost of slower moves. 50 MB/s keeps about half of a 1 Gb port free."
        : own
          ? "Moves have a network of their own, so a limit only makes them slower."
          : "A limit slows moves down so other traffic on their network keeps room.",
      can: true, choices: speeds.map((s) => ({ value: String(s), label: `${s} MB/s` })), choice: String(mb), ...cant,
    });

    const haOn = h.haPolicy === "migrate";
    out.push({
      id: "ha-shutdown", title: "HA moves its guests before a node shuts down", on: haOn, recommend: h.haGuests > 0 ? true : null,
      detail: `${h.haGuests ? `${h.haGuests === 1 ? "One guest is" : `${h.haGuests} guests are`} managed by HA. ` : "No guests are managed by HA yet, so this changes nothing today. "}When a node is restarted outside BossMox, from Proxmox or by hand, ${haOn ? "HA moves those guests to another node first and brings them back after." : "Proxmox's default stops them and leaves them waiting for that node to come back."} BossMox's own restarts move guests first either way. A guest that can't move holds up the shutdown.`,
      can: true, ...cant,
    });
  }
  const bootOn = h.noBoot.length === 0;
  out.push({
    id: "boot", title: "Running guests start again after a node restart", on: bootOn, recommend: true, onlyOn: true,
    detail: bootOn
      ? "Every running guest starts by itself when its node starts. To turn it off for one guest, use that guest's page."
      : `${list(h.noBoot.map((g) => g.name))} ${h.noBoot.length === 1 ? "won't start by itself" : "won't start by themselves"} after a power cut or an update restart.`,
    can: !bootOn,
    guests: h.noBoot.map((g) => g.id),
  });
  return out;
}

/**
 * The change to Proxmox's cluster options for one switch, as the form for PUT /cluster/options. Keeps every part of
 * a setting it doesn't own (the move type, other speed limits).
 */
export function optionsForm(id: Exclude<SettingId, "boot">, on: boolean, choice: string, options: Record<string, unknown>, net: NetCheck & { current: string | null }): Record<string, string> {
  if (id === "move-network") {
    const m = props(options.migration);
    const type = m.type ?? Object.entries(m).find(([k, v]) => k === "" && (v === "secure" || v === "insecure"))?.[1] ?? "secure";
    if (on) {
      if (!net.known || !(net.others.includes(choice) || choice === net.current)) throw new RecommendedError("Pick one of the networks shown.");
      return { migration: `type=${type},network=${choice}` };
    }
    return type === "secure" ? { delete: "migration" } : { migration: `type=${type}` };
  }
  if (id === "move-limit") {
    const b = props(options.bwlimit);
    delete b.migration;
    if (on) {
      const mb = Number(choice);
      if (!Number.isInteger(mb) || mb < 1 || mb > 10000) throw new RecommendedError("Pick one of the speeds shown.");
      return { bwlimit: joinProps({ ...b, migration: String(kib(mb)) }) };
    }
    return Object.keys(b).length ? { bwlimit: joinProps(b) } : { delete: "bwlimit" };
  }
  const ha = props(options.ha);
  delete ha.shutdown_policy;
  if (on) return { ha: joinProps({ ...ha, shutdown_policy: "migrate" }) };
  return Object.keys(ha).length ? { ha: joinProps(ha) } : { delete: "ha" };
}

export class RecommendedError extends Error {}
