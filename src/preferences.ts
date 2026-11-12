/**
 * Cluster-wide preferences (ADR 0018): choices that apply to everyone using this BossMox, in every browser, kept
 * on the server beside its settings file. Separate from settings.json, whose existence is what locks setup.
 */
import { readFileSync, } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-file.js";

export interface Preferences {
  /** The guests are backed up by something Proxmox doesn't know about (Veeam, a script, another server). */
  backupsElsewhere: boolean;
  /** Check GitHub for a newer BossMox every 6 hours (ADR 0019). On unless someone turns it off. */
  updateCheck: boolean;
  /** How much of each node to keep free when BossMox moves guests: memory, storage and processor (ADR 0025). */
  keepFreePct: number;
}
/** The choices offered. Anything else read from the file falls back to the default. */
export const KEEP_FREE_CHOICES = [5, 10, 15, 20, 25, 30];
const DEFAULTS: Preferences = { backupsElsewhere: false, updateCheck: true, keepFreePct: 10 };

export const preferencesPath = (settingsFile: string) => path.join(path.dirname(settingsFile), "preferences.json");

/** Anything missing, unreadable or of the wrong type falls back to the default, which is the safer one: warn, and check for updates. */
export function readPreferences(file: string): Preferences {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Preferences>;
    const keep = typeof raw.keepFreePct === "number" && KEEP_FREE_CHOICES.includes(raw.keepFreePct) ? raw.keepFreePct : DEFAULTS.keepFreePct;
    return { backupsElsewhere: raw.backupsElsewhere === true, updateCheck: raw.updateCheck !== false, keepFreePct: keep };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Written to a temporary file first, so a power cut can't leave half a file. */
export function writePreferences(file: string, prefs: Preferences) {
  writeJsonAtomic(file, prefs);
}

/** Guests to warn about for not being on a schedule: none when backups happen another way. */
export const scheduleWarnings = <T>(prefs: Preferences, notBackedUp: T[]): T[] => (prefs.backupsElsewhere ? [] : notBackedUp);

/**
 * Changing a cluster-wide preference needs the same right as changing the cluster's own settings in Proxmox:
 * Sys.Modify on "/", from Proxmox's answer for that path. A limited account gets a plain no.
 */
export const canChangeCluster = (perms: Record<string, Record<string, number>> | null | undefined) => perms?.["/"]?.["Sys.Modify"] === 1;
