/**
 * Cluster-wide preferences (ADR 0018): choices that apply to everyone using this BossMox, in every browser, kept
 * on the server beside its settings file. Separate from settings.json, whose existence is what locks setup.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Preferences {
  /** The guests are backed up by something Proxmox doesn't know about (Veeam, a script, another server). */
  backupsElsewhere: boolean;
  /** Check GitHub for a newer BossMox every 6 hours (ADR 0019). On unless someone turns it off. */
  updateCheck: boolean;
}
const DEFAULTS: Preferences = { backupsElsewhere: false, updateCheck: true };

export const preferencesPath = (settingsFile: string) => path.join(path.dirname(settingsFile), "preferences.json");

/** Anything missing, unreadable or of the wrong type falls back to the default, which is the safer one: warn, and check for updates. */
export function readPreferences(file: string): Preferences {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Preferences>;
    return { backupsElsewhere: raw.backupsElsewhere === true, updateCheck: raw.updateCheck !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Written to a temporary file first, so a power cut can't leave half a file. */
export function writePreferences(file: string, prefs: Preferences) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.new`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o640 });
  chmodSync(temp, 0o640);
  renameSync(temp, file);
}

/** Guests to warn about for not being on a schedule: none when backups happen another way. */
export const scheduleWarnings = <T>(prefs: Preferences, notBackedUp: T[]): T[] => (prefs.backupsElsewhere ? [] : notBackedUp);

/**
 * Changing a cluster-wide preference needs the same right as changing the cluster's own settings in Proxmox:
 * Sys.Modify on "/", from Proxmox's answer for that path. A limited account gets a plain no.
 */
export const canChangeCluster = (perms: Record<string, Record<string, number>> | null | undefined) => perms?.["/"]?.["Sys.Modify"] === 1;
