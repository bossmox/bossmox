/**
 * Help articles (ADR 0044): Markdown files in docs/help, read once at startup into a fixed list. A request never names
 * a file: the page asks for all of them at once, and only the keys BossMox knows are read, so nothing in a request
 * can reach the file system.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { UPGRADE_HELP } from "./upgrade-check.js";

/** Every article BossMox ships. A key here with no file is logged and left out; the page says it isn't available. */
export const HELP_KEYS: readonly string[] = [...UPGRADE_HELP];

/** Articles longer than this are a mistake, not an article. */
const MAX_BYTES = 64 * 1024;

export function loadHelp(dir: string, warn: (msg: string) => void = console.warn): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HELP_KEYS) {
    try {
      const text = readFileSync(path.join(dir, `${key}.md`), "utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) warn(`Help article ${key} is too long; left out.`);
      else out[key] = text;
    } catch {
      warn(`Help article ${key} is missing; left out.`);
    }
  }
  return out;
}
