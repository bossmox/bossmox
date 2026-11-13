/**
 * Proxmox's own upgrade checker (`pve8to9 --full`), read and put in plain words (ADR 0042). The checker only reports;
 * it never changes anything. Its output is text: "= SECTION =" headings, then lines starting PASS, INFO, SKIP,
 * NOTICE, WARN or FAIL, some running on over several lines, and a summary of counts at the end.
 */
import { plainText } from "./node-shell.js";

export type Level = "PASS" | "INFO" | "SKIP" | "NOTICE" | "WARN" | "FAIL";
export interface Finding {
  level: Level;
  section: string;
  /** Proxmox's own words, continuation lines included. */
  text: string;
}
export interface CheckerRun {
  findings: Finding[];
  summary: { total: number; passed: number; skipped: number; warnings: number; failures: number } | null;
}

const START = /^(PASS|INFO|SKIP|NOTICE|WARN|FAIL): ?(.*)$/;
const SECTION = /^= (.+) =$/;
const COUNT = /^(TOTAL|PASSED|SKIPPED|WARNINGS|FAILURES):\s+(\d+)$/;

export function parseChecker(raw: string): CheckerRun {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  let section = "";
  let current: Finding | null = null;
  for (const line of plainText(raw).split("\n")) {
    const t = line.trimEnd();
    const head = SECTION.exec(t);
    const count = COUNT.exec(t.trim());
    const start = START.exec(t);
    if (head) {
      section = head[1] as string;
      current = null;
    } else if (count) {
      counts[(count[1] as string).toLowerCase()] = Number(count[2]);
      current = null;
    } else if (start) {
      current = { level: start[1] as Level, section, text: (start[2] as string).trim() };
      findings.push(current);
    } else if (current && t.trim() && !/^(Checking|Analy[sz]ing) .*\.\.$/.test(t.trim()) && !/^ATTENTION:/.test(t.trim())) {
      // A finding's own lines run on until the next finding or a blank step line.
      current.text += `\n${t.trim()}`;
    } else if (!t.trim()) {
      current = current && current.level !== "WARN" && current.level !== "NOTICE" && current.level !== "FAIL" ? null : current;
    }
  }
  const summary = counts.total !== undefined ? { total: counts.total, passed: counts.passed ?? 0, skipped: counts.skipped ?? 0, warnings: counts.warnings ?? 0, failures: counts.failures ?? 0 } : null;
  return { findings, summary };
}

export type Handling = "bossmox" | "fix" | "advice" | "blocks";
export interface Explained {
  level: Level;
  /** Plain words. */
  title: string;
  detail: string;
  /** Who deals with it: BossMox during the upgrade, a fix BossMox offers, advice only, or it must be fixed first. */
  handling: Handling;
  /** Proxmox's own words, for anyone who wants them. */
  original: string;
}

/** Findings BossMox knows, put in plain words. Anything else is shown as Proxmox wrote it. */
const KNOWN: { match: RegExp; explain: (f: Finding, m: RegExpExecArray) => Omit<Explained, "level" | "original"> }[] = [
  {
    match: /(\d+) running guest\(s\) detected/,
    explain: (_f, m) => ({
      title: `${m[1]} guests are running on this node`,
      detail: "BossMox moves them to another node before upgrading this one, as it does for updates.",
      handling: "bossmox",
    }),
  },
  {
    match: /autoactivation will be disabled[\s\S]*shared LVM/,
    explain: () => ({
      title: "Shared LVM storage: turn off autoactivation first",
      detail:
        "Proxmox VE 9 creates new disks on LVM storage with autoactivation off. Disks made before still have it on, and on storage shared between nodes that has known problems, so Proxmox strongly recommends turning it off. BossMox can run Proxmox's own command for it.",
      handling: "fix",
    }),
  },
  {
    match: /autoactivation will be disabled/,
    explain: () => ({
      title: "LVM storage: autoactivation can be turned off",
      detail: "Proxmox VE 9 creates new disks with autoactivation off. Turning it off for older disks is optional on storage only this node uses. BossMox can run Proxmox's own command for it.",
      handling: "fix",
    }),
  },
  {
    match: /has guest volumes with autoactivation enabled/,
    explain: (f) => ({ title: "Disks with autoactivation on", detail: f.text, handling: "advice" }),
  },
  {
    match: /microcode package '([\w-]+)' could not be found/,
    explain: (_f, m) => ({
      title: "No processor microcode package",
      detail: `The package ${m[1]} carries security fixes for the processor. It comes from Debian's non-free-firmware section. On a virtual machine it does nothing.`,
      handling: "advice",
    }),
  },
  {
    match: /proxmox-ve package (is too old|has version)/,
    explain: (f) =>
      f.level === "PASS"
        ? { title: "On the latest Proxmox VE 8", detail: "", handling: "advice" }
        : { title: "Not on the latest Proxmox VE 8 yet", detail: "Run Update all nodes first: the upgrade starts from the newest 8.4.", handling: "blocks" },
  },
  {
    match: /updates? (available|pending)|not all packages up-to-date/i,
    explain: () => ({ title: "Updates are waiting", detail: "Run Update all nodes first: the upgrade starts from the newest 8.4.", handling: "blocks" }),
  },
];

export function explain(f: Finding): Explained {
  for (const k of KNOWN) {
    const m = k.match.exec(f.text);
    if (m) return { level: f.level, original: f.text, ...k.explain(f, m) };
  }
  const first = f.text.split("\n")[0] ?? f.text;
  return { level: f.level, title: first, detail: f.text === first ? "" : f.text.slice(first.length + 1), handling: f.level === "FAIL" ? "blocks" : "advice", original: f.text };
}

/** What needs the person's attention: failures, warnings and notices, explained. Passes and info stay out of the way. */
export function attention(run: CheckerRun): Explained[] {
  return run.findings.filter((f) => f.level === "FAIL" || f.level === "WARN" || f.level === "NOTICE").map(explain);
}
