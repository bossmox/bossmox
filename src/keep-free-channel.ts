/**
 * Keeping the free update channel through a major upgrade (ADR 0044). Proxmox VE 9's pve-manager ships its paid
 * source, pve-enterprise.sources, switched on; on a node using the free channel without a subscription every update
 * check then fails. BossMox reads the node's sources through Proxmox's API right before the packages and right after,
 * and turns off only paid entries that weren't on before, one at a time. Nothing is downloaded early and no shell is
 * used. Pure helpers here; the upgrade calls them.
 */
import type { RawRepositories, RawSubscription } from "./server-detail.js";

const on = (e: boolean | number | undefined) => e === true || e === 1;
const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

export interface SourceEntry {
  path: string;
  index: number;
}
const key = (e: SourceEntry) => `${e.path}#${e.index}`;

/** Every switched-on entry on Proxmox's paid server, by file and position (pve, ceph, anything there). */
export function paidOn(repos: RawRepositories | null): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const f of repos?.files ?? []) {
    (f.repositories ?? []).forEach((r, index) => {
      if (f.path && on(r.Enabled) && (r.URIs ?? []).some((u) => host(u) === "enterprise.proxmox.com")) out.push({ path: f.path, index });
    });
  }
  return out;
}

/** The node takes Proxmox's free channel: a switched-on pve-no-subscription entry on Proxmox's public server. */
export function onFreeChannel(repos: RawRepositories | null): boolean {
  return (repos?.files ?? []).some((f) =>
    (f.repositories ?? []).some((r) => on(r.Enabled) && (r.Components ?? []).includes("pve-no-subscription") && (r.URIs ?? []).some((u) => host(u) === "download.proxmox.com")),
  );
}

/**
 * What the upgrade should do about the paid source, decided before the packages. Only a node on the free channel with
 * no active subscription is touched; not knowing either is "leave it", said plainly (rule R12).
 */
export interface FreeChannelPlan {
  keep: boolean;
  /** The paid entries already on before the packages: never touched, they were someone's choice. */
  before: string[];
  why: string;
}
export function planFreeChannel(repos: RawRepositories | null, sub: RawSubscription | null): FreeChannelPlan {
  if (!repos || !sub?.status) return { keep: false, before: [], why: "BossMox couldn't read this node's update sources or subscription, so it won't change its sources after the upgrade." };
  if (sub.status?.toLowerCase() === "active") return { keep: false, before: [], why: "This node has a subscription, so the paid source stays as Proxmox sets it." };
  if (!onFreeChannel(repos)) return { keep: false, before: [], why: "This node isn't on the free channel, so its sources stay as they are." };
  return { keep: true, before: paidOn(repos).map(key), why: "" };
}

/** Paid entries on after the packages that weren't on before: the ones the upgrade added. */
export function paidAdded(plan: FreeChannelPlan, after: RawRepositories | null): SourceEntry[] {
  if (!plan.keep) return [];
  const was = new Set(plan.before);
  return paidOn(after).filter((e) => !was.has(key(e)));
}
