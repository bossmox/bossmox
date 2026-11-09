/**
 * Switching a node between Proxmox's free and enterprise update channels (ADR 0013).
 * Pure functions: server.ts reads Proxmox's answer, asks these what to change, and makes the calls.
 */
import type { RawRepositories } from "./server-detail.js";

export type Channel = "free" | "enterprise";

const PVE_URI = /^https?:\/\/(download|enterprise)\.proxmox\.com\/debian\/pve\/?$/;
const CEPH_URI = /^https?:\/\/(download|enterprise)\.proxmox\.com\/debian\/ceph-[a-z]+\/?$/;
const CEPH_HANDLE = /^ceph-([a-z]+)-(enterprise|no-subscription|test)$/;

/** The component each channel uses, for Proxmox itself and for Ceph. */
const COMPONENT: Record<Channel, { pve: string; ceph: string }> = {
  free: { pve: "pve-no-subscription", ceph: "no-subscription" },
  enterprise: { pve: "pve-enterprise", ceph: "enterprise" },
};
const CEPH_SUFFIX: Record<Channel, string> = { free: "no-subscription", enterprise: "enterprise" };

const isOn = (status: number | undefined) => status === 1;

/** Proxmox's standard handles to add, Proxmox's own first. Adding one that's present but off turns it on. */
export function channelAdds(repos: RawRepositories, target: Channel): string[] {
  const standard = repos["standard-repos"] ?? [];
  const status = (handle: string) => standard.find((s) => s.handle === handle)?.status;
  const adds: string[] = [];
  const pve = target === "free" ? "no-subscription" : "enterprise";
  if (!isOn(status(pve))) adds.push(pve);
  // Each Ceph release that has a source turned on moves to the same release on the new channel.
  const releases = new Set(standard.filter((s) => isOn(s.status)).map((s) => CEPH_HANDLE.exec(s.handle)?.[1]).filter((r): r is string => !!r));
  for (const release of [...releases].sort()) {
    const handle = `ceph-${release}-${CEPH_SUFFIX[target]}`;
    if (!isOn(status(handle))) adds.push(handle);
  }
  return adds;
}

interface Entry {
  path: string;
  index: number;
  uri: string;
  components: string[];
}
function proxmoxEntries(repos: RawRepositories): Entry[] {
  return (repos.files ?? []).flatMap((f) =>
    (f.repositories ?? []).flatMap((r, index) => {
      if (!r.Enabled || !f.path) return [];
      const uri = (r.URIs ?? []).find((u) => PVE_URI.test(u) || CEPH_URI.test(u));
      return uri ? [{ path: f.path, index, uri, components: r.Components ?? [] }] : [];
    }),
  );
}

/** True once the target channel for Proxmox itself is turned on. */
export function channelOn(repos: RawRepositories, target: Channel): boolean {
  return proxmoxEntries(repos).some((e) => PVE_URI.test(e.uri) && e.components.includes(COMPONENT[target].pve));
}

/** Proxmox and Ceph sources still turned on that aren't the target channel. Nothing else is touched. */
export function channelDisables(repos: RawRepositories, target: Channel): { path: string; index: number }[] {
  return proxmoxEntries(repos)
    .filter((e) => !e.components.includes(PVE_URI.test(e.uri) ? COMPONENT[target].pve : COMPONENT[target].ceph))
    .map(({ path, index }) => ({ path, index }));
}
