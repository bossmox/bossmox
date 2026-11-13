/**
 * Updates never cross into a new major version (ADR 0039). A node whose Debian or Proxmox sources name a different
 * release than the one it runs would get the whole major upgrade from a normal update, unattended. Proxmox already
 * compares each source with the installed release; this reads its verdict, so no version table lives here.
 */
import type { RawRepositories } from "./server-detail.js";

/** Proxmox's kinds for a source whose suite isn't the installed release. The next release gets its own kind. */
const RELEASE_KINDS = new Set(["warning", "ignore-pre-upgrade-warning"]);
const WATCHED_ORIGINS = new Set(["Debian", "Proxmox"]);
/** For a source with no downloaded lists yet, which is exactly a source switched a moment ago. */
const WATCHED_URI = /^(https?:\/\/([\w-]+\.)*(debian\.org|proxmox\.com)(\/|$)|mirror\+file:\/\/\/etc\/apt\/mirrors\/debian)/i;

const enabled = (v: boolean | number | undefined) => v === true || v === 1;

/** Why this node mustn't get a normal update, in plain words, or null when its sources match what it runs. */
export function releaseMismatch(node: string, repos: RawRepositories | null): string | null {
  if (!repos?.files || !repos.infos) return `BossMox can't read the update sources on ${node}, so it can't check they match the Proxmox version installed there.`;
  const broken = (repos.errors ?? []).map((e) => `${e.path ?? "a sources file"}${e.error ? ` (${e.error})` : ""}`);
  if (broken.length) return `Proxmox can't read some update sources on ${node}: ${broken.join("; ")}. Fix them before updating.`;
  const infos = repos.infos;
  const at = (path: string, index: number) => infos.filter((i) => i.path === path && i.index === index);
  const found: string[] = [];
  for (const file of repos.files) {
    const path = file.path ?? "";
    (file.repositories ?? []).forEach((repo, index) => {
      if (!enabled(repo.Enabled)) return;
      const here = at(path, index);
      const origin = here.find((i) => i.kind === "origin")?.message;
      const watched = origin ? WATCHED_ORIGINS.has(origin) : (repo.URIs ?? []).some((u) => WATCHED_URI.test(u));
      if (!watched) return;
      for (const i of here) if (i.property === "Suites" && RELEASE_KINDS.has(i.kind ?? "")) found.push(`${path}: ${i.message ?? (repo.Suites ?? []).join(" ")}`);
    });
  }
  if (!found.length) return null;
  return (
    `The update sources on ${node} point at a different release than the Proxmox it runs. A normal update would turn into an upgrade to another major version, so BossMox won't run it. ` +
    `Use Proxmox's upgrade steps for that, or set the sources back to the installed release. Proxmox says: ${found.join("; ")}`
  );
}
