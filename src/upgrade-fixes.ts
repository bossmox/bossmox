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
 * Proxmox's pinning for one port: a .link file and a pending network config, applied at the next restart. In a
 * console it asks "continue (y/N)?" first, so the answer is piped in.
 */
export const pinCommand = (port: string) => `printf 'y\\n' | pve-network-interface-pinning generate --interface ${port}`;

/**
 * Which naming file udev applies to each physical port, asked in udev's test mode, which changes nothing. Proxmox's
 * pinning tool only knows its own 50-pve (9: 50-pmx) files: an earlier file that names the port (cloud-init's 10-eth0.link, or a
 * pin made by hand) wins over it, and the bridge then points at a name that never appears. Seen on the lab,
 * 2026-11-13: the node came back without its main network.
 */
export const PORTS_COMMAND =
  'for p in /sys/class/net/*; do [ -e "$p/device" ] || continue; n=$(basename "$p"); ' +
  "f=$(udevadm test-builtin net_setup_link \"$p\" 2>&1 | sed -n 's/.*Config file \\(.*\\) is applied.*/\\1/p' | head -1); " +
  'named=no; [ -n "$f" ] && grep -q "^Name=" "$f" 2>/dev/null && named=yes; [ -n "$f" ] || f=none; ' +
  'echo "BMXPORT $n $(cat "$p/address") $f $named"; done';

export interface Port {
  name: string;
  mac: string;
  /** The .link file udev applies, or "none". */
  file: string;
  /** That file fixes the name, so a new kernel can't change it. */
  named: boolean;
}
export function readPorts(output: string): Port[] {
  return [...output.matchAll(/^BMXPORT (\S+) (\S+) (\S+) (yes|no)\s*$/gm)].map((m) => ({ name: m[1] as string, mac: m[2] as string, file: m[3] as string, named: m[4] === "yes" }));
}
/**
 * Proxmox's pinning tool names its files 50-pve-<name>.link on 8.4 and 50-pmx-<name>.link on 9 (seen on the lab,
 * 2026-11-16). The upgrade pins after the 9 packages are in, so both have to count as Proxmox's own.
 */
const PIN_DIR = "/usr/local/lib/systemd/network";
const proxmoxPin = (file: string, name = "[^/]+") => new RegExp(`/50-p(?:ve|mx)-${name}\\.link$`).test(file);
/** A port only Proxmox's own pin may name: anything else that names it already keeps the name stable. */
const pinnedByProxmox = (p: Port) => proxmoxPin(p.file);

/** Undoes this run's pins before any restart: its .link files, under either of the tool's names, and the pending network config it made. */
export const undoPinCommand = (names: string[], hadPending: boolean) =>
  [...names.map((n) => `rm -f ${PIN_DIR}/50-pve-${n}.link ${PIN_DIR}/50-pmx-${n}.link`), ...(hadPending ? [] : ["rm -f /etc/network/interfaces.new"])].join(" && ");

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
  /** Ports whose name another file already fixes, so they were left alone. */
  kept?: { name: string; file: string }[];
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

  /**
   * Pins only the ports nothing else names, then asks udev again before anything restarts: each pinned port must now
   * get Proxmox's new file. If one doesn't, this run's pins are taken back out, so no restart can cut the node off.
   */
  async function pinNode(session: Session, node: string): Promise<PinResult> {
    const before = readPorts((await deps.console(node, session, PORTS_COMMAND)).output);
    if (!before.length) return { node, ok: false, renames: [], already: false, error: "BossMox couldn't list this node's network ports." };
    const kept = before.filter((p) => p.named && !pinnedByProxmox(p)).map((p) => ({ name: p.name, file: p.file }));
    const todo = before.filter((p) => !p.named);
    if (!todo.length) return { node, ok: true, renames: [], already: true, kept, error: null };
    const pending = (await deps.console(node, session, "test -e /etc/network/interfaces.new")).exitCode === 0;
    const renames: PinResult["renames"] = [];
    for (const p of todo) {
      const r = readPin(node, await deps.console(node, session, pinCommand(p.name)));
      if (!r.ok) return { node, ok: false, renames, already: false, kept, error: r.error };
      renames.push(...r.renames);
    }
    const after = readPorts((await deps.console(node, session, PORTS_COMMAND)).output);
    const fileOf = (ports: Port[], name: string) => ports.find((p) => p.name === name)?.file ?? "";
    const wrong = renames.filter((rn) => !proxmoxPin(fileOf(after, rn.from), rn.to));
    if (wrong.length) {
      await deps.console(
        node,
        session,
        undoPinCommand(
          renames.map((rn) => rn.to),
          pending,
        ),
      );
      const why = wrong.map((rn) => `${rn.from} (named by ${fileOf(after, rn.from) || "another file"})`).join(", ");
      // Ask udev once more: "took them back out" is only said when no pin of this run still applies.
      const undone = readPorts((await deps.console(node, session, PORTS_COMMAND)).output);
      const left = renames.map((rn) => fileOf(undone, rn.from)).filter((f, i) => proxmoxPin(f, (renames[i] as { to: string }).to));
      return {
        node,
        ok: false,
        renames: [],
        already: false,
        kept,
        error: left.length
          ? `Another naming file would win over the new pin for ${why}, so the node would come back without that network. BossMox couldn't take its pins back out: remove ${left.join(", ")} before this node restarts.`
          : `Another naming file would win over the new pin for ${why}, so the node would come back without that network. BossMox took the pins back out; nothing changes at the next restart.`,
      };
    }
    return { node, ok: true, renames, already: false, kept, error: null };
  }

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
      if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
      return pinRecorded(session, node);
    },

    /** The same pinning, run by the upgrade itself right before the node restarts. The upgrade was confirmed already. */
    pinForUpgrade: (session: Session, node: string) => pinRecorded(session, node),
  };

  async function pinRecorded(session: Session, node: string): Promise<PinResult> {
    rootOnly(session);
    return once(async () => {
      const r = await pinNode(session, node);
      deps.audit("upgrade-pin", session.username, { node, renamed: r.renames.length, ok: r.ok ? 1 : 0 });
      last = { ...last, pins: { ...last.pins, [node]: r } };
      return r;
    });
  }
}
export type UpgradeFixes = ReturnType<typeof createUpgradeFixes>;
