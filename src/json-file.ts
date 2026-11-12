import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Saves a value as JSON through a temporary file and a rename, so a power cut can't leave half a file, readable only
 * by BossMox's own account and group. Every state file BossMox keeps goes through here.
 */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.new`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  chmodSync(temp, 0o640);
  renameSync(temp, file);
}
