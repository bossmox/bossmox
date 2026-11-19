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
  /** The fix BossMox runs for it, when there is one. */
  fixId?: "lvm-autoactivation";
  /** The Help article that explains it in full (ADR 0044): a key in docs/help, never a path. */
  help: HelpKey;
}

/** Every article the upgrade checker can point to. A finding BossMox doesn't know gets the general one. */
export const UPGRADE_HELP = [
  "upgrade-checker",
  "upgrade-running-guests",
  "upgrade-lvm-autoactivation",
  "upgrade-microcode",
  "upgrade-latest-8",
  "upgrade-systemd-boot",
  "upgrade-ceph",
  "upgrade-root-space",
  "upgrade-passthrough",
  "upgrade-storage-plugins",
  "upgrade-port-names",
  "upgrade-free-channel",
] as const;
export type HelpKey = (typeof UPGRADE_HELP)[number];

/** Findings BossMox knows, put in plain words. Anything else is shown as Proxmox wrote it. */
const KNOWN: { match: RegExp; explain: (f: Finding, m: RegExpExecArray) => Omit<Explained, "level" | "original"> }[] = [
  {
    match: /(\d+) running guest\(s\) detected/,
    explain: (_f, m) => ({
      title: `${m[1]} ${m[1] === "1" ? "guest is" : "guests are"} running on this node`,
      detail: "BossMox moves them to another node before upgrading this one, as it does for updates.",
      handling: "bossmox",
      help: "upgrade-running-guests",
    }),
  },
  {
    // "Autoactivation" reads like switching something off, even HA (Rocky, 2026-11-19). Say what changes and what doesn't.
    match: /autoactivation will be disabled[\s\S]*shared LVM/,
    explain: () => ({
      title: "Shared storage: stop every node opening every old VM disk",
      detail:
        "VM disks made before Proxmox VE 9 on the shared storage are opened by every node when it restarts, not just the node running the VM, which Proxmox says causes known problems. The fix changes one setting on each existing disk. It creates no disks and moves no data, and running VMs and HA aren't affected. BossMox runs Proxmox's own command for it.",
      handling: "fix",
      fixId: "lvm-autoactivation",
      help: "upgrade-lvm-autoactivation",
    }),
  },
  {
    match: /autoactivation will be disabled/,
    explain: () => ({
      title: "This node's own storage: an optional disk setting",
      detail:
        "VM disks made before Proxmox VE 9 are opened when the node restarts. On storage only this node uses that does no harm, so changing it is optional. It creates no disks and moves no data. BossMox can run Proxmox's own command for it.",
      handling: "fix",
      fixId: "lvm-autoactivation",
      help: "upgrade-lvm-autoactivation",
    }),
  },
  {
    match: /has guest volumes with autoactivation enabled/,
    explain: (f) => ({ title: "Disks with autoactivation on", detail: f.text, handling: "advice", help: "upgrade-lvm-autoactivation" }),
  },
  {
    match: /systemd-boot package installed on legacy-boot system/,
    explain: () => ({
      title: "A boot package this node doesn't use",
      detail:
        "This node starts the older (BIOS) way, so the systemd-boot package isn't used, and Proxmox's checker suggests removing it. It's a warning only: the upgrade goes ahead with it installed. BossMox doesn't remove it.",
      handling: "advice",
      help: "upgrade-systemd-boot",
    }),
  },
  {
    match: /Hyper-converged Ceph (\d+) (\w+) is too? old/,
    explain: (_f, m) => ({
      title: `Ceph ${m[1]} (${m[2]}) is installed and too old for Proxmox VE 9`,
      detail:
        "Proxmox VE 9 needs Ceph Squid (19.2) first. If this cluster keeps data in Ceph, upgrade Ceph in Proxmox's own interface before upgrading Proxmox: BossMox doesn't upgrade Ceph. If Ceph was set up once and never used, its leftover packages and settings cause this.",
      handling: "blocks",
      help: "upgrade-ceph",
    }),
  },
  {
    match: /unable to determine Ceph (status|daemon versions)|failed to get 'noout' flag status/,
    explain: (f) => ({
      title: "Ceph doesn't answer",
      detail: `Proxmox's checker found Ceph set up on this node but couldn't reach it (${f.text.split("\n")[0]}). Either Ceph is down, or it's left over from a Ceph setup nothing uses any more.`,
      handling: "blocks",
      help: "upgrade-ceph",
    }),
  },
  {
    match: /'noout' flag not set/,
    explain: () => ({
      title: "Ceph's 'noout' flag isn't set",
      detail: "The flag stops Ceph copying data around while a node restarts. It only matters if this cluster keeps data in Ceph.",
      handling: "advice",
      help: "upgrade-ceph",
    }),
  },
  {
    // Proxmox VE 9's checker adds this FAIL beside the WARN below when the package isn't there (8.4's only warned).
    // Every VM and any real node without the package hits it; it says nothing about whether the upgrade works.
    match: /unable to determine installed ([\w-]*microcode) version/,
    explain: (_f, m) => ({
      title: "No processor microcode package",
      detail: `Proxmox VE 9's checker counts a missing ${m[1]} as a failure, but it doesn't stop the upgrade. The package carries security fixes for the processor, from Debian's non-free-firmware section, and can be installed any time. On a virtual machine it does nothing.`,
      handling: "advice",
      help: "upgrade-microcode",
    }),
  },
  {
    match: /microcode package '([\w-]+)' could not be found/,
    explain: (_f, m) => ({
      title: "No processor microcode package",
      detail: `The package ${m[1]} carries security fixes for the processor. It comes from Debian's non-free-firmware section. On a virtual machine it does nothing.`,
      handling: "advice",
      help: "upgrade-microcode",
    }),
  },
  {
    match: /proxmox-ve package (is too old|has version)/,
    explain: (f) =>
      f.level === "PASS"
        ? { title: "On the latest Proxmox VE 8", detail: "", handling: "advice", help: "upgrade-latest-8" }
        : { title: "Not on the latest Proxmox VE 8 yet", detail: "Run Update all nodes first: the upgrade starts from the newest 8.4.", handling: "blocks", help: "upgrade-latest-8" },
  },
  {
    match: /updates? (available|pending)|not all packages up-to-date/i,
    explain: () => ({ title: "Updates are waiting", detail: "Run Update all nodes first: the upgrade starts from the newest 8.4.", handling: "blocks", help: "upgrade-latest-8" }),
  },
];

export function explain(f: Finding): Explained {
  for (const k of KNOWN) {
    const m = k.match.exec(f.text);
    if (m) return { level: f.level, original: f.text, ...k.explain(f, m) };
  }
  const first = f.text.split("\n")[0] ?? f.text;
  return {
    level: f.level,
    title: first,
    detail: f.text === first ? "" : f.text.slice(first.length + 1),
    handling: f.level === "FAIL" ? "blocks" : "advice",
    original: f.text,
    help: "upgrade-checker",
  };
}

/** What needs the person's attention: failures, warnings and notices, explained. Passes and info stay out of the way. */
export function attention(run: CheckerRun): Explained[] {
  return run.findings.filter((f) => f.level === "FAIL" || f.level === "WARN" || f.level === "NOTICE").map(explain);
}

/**
 * What stops an upgrade step: every finding explained as 'blocks', plus any failure the summary counts that wasn't
 * read as a FAIL line, so a line the reader missed still stops it. Known harmless failures (microcode) don't.
 */
export function blockers(run: CheckerRun): string[] {
  const out = attention(run)
    .filter((e) => e.handling === "blocks")
    .map((e) => e.title);
  const unread = (run.summary?.failures ?? 0) - run.findings.filter((f) => f.level === "FAIL").length;
  for (let i = 0; i < unread; i++) out.push("a failure BossMox couldn't read");
  return out;
}
