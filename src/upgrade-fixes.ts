/**
 * The fixes that come before a Proxmox major upgrade (ADR 0042, piece 3), each Proxmox's own tool run in the node's
 * root console. Only the two the lab can prove are actions: turning off LVM autoactivation for existing guest disks,
 * and pinning network port names. The GRUB, systemd-boot and sysctl fixes apply only to setups the lab doesn't have,
 * so BossMox shows Proxmox's command for those instead of running it.
 */
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import type { ShellResult } from "./node-shell.js";
import { parseChecker } from "./upgrade-check.js";

/** Proxmox's migration for disks made before VE 9. Without --assume-yes it asks per storage, or assumes no. */
export const LVM_COMMAND = "/usr/share/pve-manager/migrations/pve-lvm-disable-autoactivation --assume-yes";
/**
 * Proxmox's pinning: .link files and a pending network config, applied at the next restart. In a console it asks
 * "continue (y/N)?" first, so the answer is piped in.
 */
export const PIN_COMMAND = "printf 'y\\n' | pve-network-interface-pinning generate";

export interface LvmResult {
  node: string;
  ok: boolean;
  /** Proxmox's own lines, PASS/INFO/WARN/FAIL. */
  lines: string[];
}
export interface PinResult {
  node: string;
  ok: boolean;
  /** Old name to new name, as the tool printed it. Empty when everything was already pinned. */
  renames: { from: string; to: string }[];
  already: boolean;
  error: string | null;
}

/** The LVM script's output: its own PASS/INFO/WARN/FAIL lines. */
export function readLvm(node: string, r: ShellResult): LvmResult {
  const lines = parseChecker(r.output).findings.map((f) => `${f.level}: ${f.text}`);
  return { node, ok: r.exitCode === 0, lines };
}

/** The pinning tool's output: "Name for link 'ens18' (altnames) will change to 'nic0'", or "Nothing to do". */
export function readPin(node: string, r: ShellResult): PinResult {
  const renames = [...r.output.matchAll(/Name for link '([^']+)'(?: \([^)]*\))? will change to '([^']+)'/g)].map((m) => ({ from: m[1] as string, to: m[2] as string }));
  const already = /Nothing to do/.test(r.output);
  const ok = r.exitCode === 0 && (already || /Successfully updated Proxmox VE configuration files/.test(r.output));
  const said = r.output
    .split("\n")
    .find((l) => /^\s*(Could not|There already|target-name|Aborting)/.test(l))
    ?.trim();
  return { node, ok, renames, already, error: ok ? null : said || `The pinning tool ended with exit code ${r.exitCode}.` };
}

export interface FixDeps {
  console: (node: string, session: Session, line: string) => Promise<ShellResult>;
  onlineNodes: (session: Session) => Promise<string[]>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
}

export function createUpgradeFixes(deps: FixDeps) {
  const rootOnly = (session: Session) => {
    if (session.username !== "root@pam") throw new HttpError(403, "These fixes run in each node's root console. Sign in as root@pam.");
  };
  let busy = false;
  let last: { lvm: LvmResult[] | null; pins: Record<string, PinResult> } = { lvm: null, pins: {} };
  const once = async <T>(job: () => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, "A fix is already running. Wait for it to finish.");
    busy = true;
    try {
      return await job();
    } finally {
      busy = false;
    }
  };

  return {
    /** What the last fixes did, for the window. */
    last: () => last,
    /**
     * Turns off autoactivation for existing guest disks on every LVM storage, on every node. Disks on storage the
     * nodes share are changed once; the other nodes then find nothing left to do.
     */
    async lvm(session: Session, confirm: string): Promise<LvmResult[]> {
      rootOnly(session);
      if (confirm !== "lvm-autoactivation") throw new HttpError(400, "It wasn't confirmed.");
      return once(async () => {
        const out: LvmResult[] = [];
        for (const node of await deps.onlineNodes(session)) {
          const r = readLvm(node, await deps.console(node, session, LVM_COMMAND));
          out.push(r);
          deps.audit("upgrade-fix-lvm", session.username, { node, ok: r.ok ? 1 : 0 });
          if (!r.ok) break;
        }
        last = { ...last, lvm: out };
        return out;
      });
    },

    /** Pins one node's port names. Nothing changes until that node restarts. */
    async pin(session: Session, node: string, confirm: string): Promise<PinResult> {
      rootOnly(session);
      if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
      return once(async () => {
        const r = readPin(node, await deps.console(node, session, PIN_COMMAND));
        deps.audit("upgrade-pin", session.username, { node, renamed: r.renames.length, ok: r.ok ? 1 : 0 });
        last = { ...last, pins: { ...last.pins, [node]: r } };
        return r;
      });
    },
  };
}
export type UpgradeFixes = ReturnType<typeof createUpgradeFixes>;
