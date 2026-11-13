/**
 * How long each Proxmox VE major version gets updates (ADR 0042). Proxmox publishes the dates only in its FAQ
 * (pve.proxmox.com/wiki/FAQ), not anywhere a program can read, so they live here and are updated with each BossMox
 * release. A version newer than this table is "unknown": BossMox says it doesn't know it, rather than guessing.
 */

export interface Release {
  major: number;
  debian: string;
  /** The last day of updates, or null while Proxmox hasn't announced one. */
  endOfLife: string | null;
}

/** From Proxmox's FAQ, read 2026-11-13. The FAQ gives months; VE 8's day is from Rocky (2026-08-31). */
export const RELEASES: Release[] = [
  { major: 9, debian: "Debian 13 (Trixie)", endOfLife: null },
  { major: 8, debian: "Debian 12 (Bookworm)", endOfLife: "2026-08-31" },
  { major: 7, debian: "Debian 11 (Bullseye)", endOfLife: "2024-07-31" },
  { major: 6, debian: "Debian 10 (Buster)", endOfLife: "2022-09-30" },
];

/** How far ahead Health check starts saying the end is coming. */
export const NOTICE_DAYS = 183;

export type LifeState = "supported" | "ending" | "ended" | "unknown";
export interface Life {
  major: number;
  state: LifeState;
  endOfLife: string | null;
  /** Days until the end; negative once it has passed. */
  daysLeft: number | null;
  /** The newest major version BossMox knows, if it's newer than this one. */
  newer: number | null;
}

const DAY = 86_400_000;
const newest = Math.max(...RELEASES.map((r) => r.major));

/** Where a version such as "8.4.21" stands on a given day. */
export function lifeOf(version: string, now: Date): Life | null {
  const major = Number.parseInt(version, 10);
  if (!Number.isInteger(major) || major < 1) return null;
  const known = RELEASES.find((r) => r.major === major);
  const newer = newest > major ? newest : null;
  if (!known) return { major, state: "unknown", endOfLife: null, daysLeft: null, newer: null };
  if (!known.endOfLife) return { major, state: "supported", endOfLife: null, daysLeft: null, newer };
  // The end date is the last day of updates, so it ends at the close of that day, UTC.
  const daysLeft = Math.floor((Date.parse(`${known.endOfLife}T23:59:59Z`) - now.getTime()) / DAY);
  const state: LifeState = daysLeft < 0 ? "ended" : daysLeft <= NOTICE_DAYS ? "ending" : "supported";
  return { major, state, endOfLife: known.endOfLife, daysLeft, newer };
}

/** "August 31, 2026". */
export const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
