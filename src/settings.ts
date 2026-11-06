import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const settingsPath = (env: NodeJS.ProcessEnv) => env.BOSSMOX_SETTINGS ?? "/var/lib/bossmox/settings.json";

/** The settings the wizard is allowed to save. Anything else in the file is ignored. */
const SAVED = ["PVE_URL", "PVE_CA_FILE", "PVE_TLS_NAME", "BOSSMOX_ALLOWED_HOSTS"] as const;
export type Saved = Partial<Record<(typeof SAVED)[number], string>>;

/**
 * Fills in anything the environment doesn't already set, so Docker and scripted installs keep working
 * and win over the file. Returns true when there's still no Proxmox to talk to, which means setup mode.
 */
export function applySettings(env: NodeJS.ProcessEnv): boolean {
  const file = settingsPath(env);
  if (!env.PVE_URL && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
    for (const key of SAVED) {
      const value = saved[key];
      if (typeof value === "string" && value && env[key] === undefined) env[key] = value;
    }
  }
  return !env.PVE_URL;
}

/** Written to a temporary file first, so a power cut can't leave half a settings file. */
export function saveSettings(env: NodeJS.ProcessEnv, values: Saved) {
  const file = settingsPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.new`;
  writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o640 });
  chmodSync(temp, 0o640);
  renameSync(temp, file);
}
