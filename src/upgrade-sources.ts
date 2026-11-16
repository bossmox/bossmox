/**
 * Switching one node's update sources to the next Debian and Proxmox release (ADR 0042, piece 4), with a backup to
 * go back to. Only Debian's and Proxmox's own sources change, picked by the origin Proxmox reports for each (as the
 * update guard does, ADR 0039); any other source is left as it is and named. Proxmox's old entries are replaced by
 * the new release's deb822 files on the same channel the node already uses. `apt update` has to come back clean, or
 * the backup goes back in by itself.
 */
import type { Session } from "./auth.js";
import { gzipSync } from "node:zlib";
import { HttpError } from "./http-error.js";
import type { ShellResult } from "./node-shell.js";
import type { RawRepositories } from "./server-detail.js";

export interface SwitchPlan {
  from: string;
  to: string;
  /** The Proxmox channel the node uses now, kept: pve-no-subscription, pve-enterprise or pve-test. */
  pveComponent: string;
  /** Ceph's channel, when a Ceph source is turned on: no-subscription, enterprise or test. */
  cephComponent: string | null;
  /** Debian's addresses, as they're written in the files, to switch to the new release. */
  debianUris: string[];
  /** Sources that are neither Debian's nor Proxmox's, left as they are. */
  others: { path: string; uri: string }[];
  /** Why it can't be switched, if it can't. */
  problems: string[];
}

export const PROXMOX_URI = /^https?:\/\/(download|enterprise)\.proxmox\.com\/debian\/(pve|ceph-[a-z]+)\/?$/;
const CEPH_COMPONENTS = new Set(["no-subscription", "enterprise", "test"]);
const PVE_COMPONENTS = new Set(["pve-no-subscription", "pve-enterprise", "pve-test"]);

/** What to change, from Proxmox's own reading of the node's sources. Pure, for tests. */
export function planSwitch(repos: RawRepositories, from: string, to: string): SwitchPlan {
  const problems: string[] = [];
  const origins = new Map((repos.infos ?? []).filter((i) => i.kind === "origin").map((i) => [`${i.path}#${i.index}`, i.message ?? ""]));
  let pveComponent = "";
  let cephComponent: string | null = null;
  const debianUris = new Set<string>();
  const others: SwitchPlan["others"] = [];
  for (const f of repos.files ?? []) {
    (f.repositories ?? []).forEach((r, index) => {
      if (!(r.Enabled === true || r.Enabled === 1)) return;
      const origin = origins.get(`${f.path}#${index}`);
      for (const uri of r.URIs ?? []) {
        const proxmox = PROXMOX_URI.exec(uri);
        if (proxmox) {
          const comps = r.Components ?? [];
          if (proxmox[2] === "pve") pveComponent ||= comps.find((c) => PVE_COMPONENTS.has(c)) ?? "";
          else cephComponent ??= comps.find((c) => CEPH_COMPONENTS.has(c)) ?? null;
        } else if (origin === "Debian" || /(^|\.)debian\.org(\/|$)|^mirror\+file:\/\/\/etc\/apt\/mirrors\/debian/.test(uri.replace(/^\w+:\/\//, ""))) {
          debianUris.add(uri);
        } else others.push({ path: f.path ?? "", uri });
      }
    });
  }
  if (!pveComponent) problems.push("No Proxmox source is turned on, so BossMox can't tell which channel to keep. Set the update channel first.");
  if (!debianUris.size) problems.push("BossMox found no Debian source to switch.");
  return { from, to, pveComponent, cephComponent, debianUris: [...debianUris], others, problems };
}

const deb822 = (uri: string, suite: string, component: string) => `Types: deb\nURIs: ${uri}\nSuites: ${suite}\nComponents: ${component}\nSigned-By: /usr/share/keyrings/proxmox-archive-keyring.gpg\n`;

/**
 * The script typed on the node, as base64 so nothing in it is read by the console's shell. It prints BMXBACKUP with
 * the backup's path first, and BMXRESULT ok, or BMXRESULT restored with apt's complaint.
 */
export function switchScript(p: SwitchPlan): string {
  const enterprise = p.pveComponent === "pve-enterprise";
  const pveFile = enterprise ? "pve-enterprise.sources" : "proxmox.sources";
  const pveUri = enterprise ? "https://enterprise.proxmox.com/debian/pve" : "http://download.proxmox.com/debian/pve";
  const ceph = p.cephComponent ? deb822(`${p.cephComponent === "enterprise" ? "https://enterprise" : "http://download"}.proxmox.com/debian/ceph-squid`, p.to, p.cephComponent) : "";
  // Quoted heredocs: what's between the markers is written exactly, with nothing expanded by the shell.
  return `set -eu
FROM=${p.from}; TO=${p.to}; A=/etc/apt; D=$A/sources.list.d
B=/root/bossmox-apt-before-$TO-$(date +%Y%m%d-%H%M%S).tar
tar -C $A -cf "$B" sources.list.d $([ -e $A/sources.list ] && echo sources.list)
echo "BMXBACKUP $B"
# The backup is read through before anything is deleted, so a bad backup never leaves the node with no sources.
restore() { tar -tf "$B" >/dev/null || { echo "BMXRESULT unrestored"; return 0; }; rm -rf "$D"; mkdir -p "$D"; rm -f $A/sources.list; tar -C $A -xf "$B"; apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null 2>&1 || true; echo "BMXRESULT restored"; }
# Anything that fails from here, or a stop part way, puts the backup back.
trap 'trap - ERR; restore; echo "The switch stopped part way, so the old sources were put back."' ERR
trap 'trap - ERR; restore; exit 1' HUP INT TERM
URIS=$(mktemp)
cat > "$URIS" <<'BMX_URIS'
${p.debianUris.join("\n")}
BMX_URIS
for f in $A/sources.list $D/*.list; do
  [ -f "$f" ] || continue
  # Proxmox's old one-line entries go, on or off; Debian's lines move to the new release, backports dropped.
  awk -v from="$FROM" -v to="$TO" -v urifile="$URIS" 'BEGIN{while((getline u < urifile)>0) if(u!="") uris[u]=1}
    /proxmox\\.com\\/debian\\/(pve|ceph-)/ {next}
    { deb=0; for (u in uris) if (index($0, u)) deb=1
      if (deb && index($0, from "-backports")) next
      if (deb) gsub(from, to)
      print }' "$f" > "$f.bmx"
  mv "$f.bmx" "$f"
done
for f in $D/*.sources; do
  [ -f "$f" ] || continue
  # Proxmox's own stanzas go (the new ones are written below); any other stanza in the same file stays.
  awk -v from="$FROM" -v to="$TO" -v urifile="$URIS" 'BEGIN{while((getline u < urifile)>0) if(u!="") uris[u]=1; RS=""; ORS="\\n\\n"}
    /(^|\\n)URIs:[^\\n]*proxmox\\.com\\/debian\\/(pve|ceph-)/ {next}
    { deb=0; for (u in uris) if (index($0, u)) deb=1
      if (deb) { n=split($0, L, "\\n"); out=""
        for (i=1;i<=n;i++){ l=L[i]; if (l ~ /^Suites:/) { gsub(from "-backports", "", l); gsub(from, to, l); gsub(/  +/, " ", l); sub(/ +$/, "", l) } out = out (i>1?"\\n":"") l }
        $0=out }
      print }' "$f" > "$f.bmx"
  if [ -s "$f.bmx" ]; then mv "$f.bmx" "$f"; else rm -f "$f" "$f.bmx"; fi
done
cat > $D/${pveFile} <<'BMX_PVE'
${deb822(pveUri, p.to, p.pveComponent)}BMX_PVE
${ceph ? `cat > $D/ceph.sources <<'BMX_CEPH'\n${ceph}BMX_CEPH` : "true"}
rm -f "$URIS"
trap - ERR
if out=$(apt-get -o DPkg::Lock::Timeout=600 update 2>&1) && ! printf '%s\\n' "$out" | grep -Eq '^(Err|E):'; then echo "BMXRESULT ok"; else
  restore; printf '%s\\n' "$out" | grep -E '^(Err|E|W):' | head -5; fi
`;
}

const SOURCES_UNIT = "bossmox-sources";
const SOURCES_SCRIPT = "/root/bossmox-sources.sh";
export const SOURCES_LOG = "/root/bossmox-sources.log";
/** How the switch on the node is going: running, or what it printed once it ended. */
export const followSwitchCommand = () => `if systemctl is-active --quiet ${SOURCES_UNIT}; then echo "BMXSRC running"; else cat ${SOURCES_LOG} 2>/dev/null; echo "BMXSRC ended"; fi`;
/**
 * Typed on the node: the script, gzipped and carried as base64 so nothing in it is read by the console's shell and the
 * typed line stays well short of the terminal's limit, written to a file and run as its own systemd job. A switch
 * already running isn't started again: BossMox follows it instead.
 */
export const switchCommand = (p: SwitchPlan) =>
  `if ! systemctl is-active --quiet ${SOURCES_UNIT}; then printf '%s' '${gzipSync(Buffer.from(switchScript(p), "utf8")).toString("base64")}' | base64 -d | gunzip > ${SOURCES_SCRIPT} && rm -f ${SOURCES_LOG} && systemd-run --quiet --wait --collect --unit=${SOURCES_UNIT} /bin/bash -c 'exec >${SOURCES_LOG} 2>&1; exec bash ${SOURCES_SCRIPT}'; fi; ${followSwitchCommand()}`;

/** Only a backup this switch made can be put back: a fixed folder and name, nothing a shell would read. */
const BACKUP_PATH = /^\/root\/bossmox-apt-before-[a-z]+-\d{8}-\d{6}\.tar$/;

/** Puts a backup made by the switch back, then refreshes the package lists. */
export const undoCommand = (backup: string) => {
  if (!BACKUP_PATH.test(backup)) throw new HttpError(400, "That isn't a backup BossMox made.");
  // Read the backup through first: nothing is deleted unless it can be put back.
  return `[ -f '${backup}' ] && tar -tf '${backup}' >/dev/null && rm -rf /etc/apt/sources.list.d && mkdir -p /etc/apt/sources.list.d && rm -f /etc/apt/sources.list && tar -C /etc/apt -xf '${backup}' && apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null 2>&1`;
};

export interface SwitchResult {
  ok: boolean;
  /** The old sources were put back, read from the node: only then may BossMox say so. */
  restored: boolean;
  backup: string | null;
  /** apt's own complaint when it had to go back. */
  said: string;
}
export function readSwitch(output: string): SwitchResult {
  const found = /BMXBACKUP (\S+)/.exec(output)?.[1] ?? null;
  const backup = found && BACKUP_PATH.test(found) ? found : null;
  const ok = /^BMXRESULT ok\s*$/m.test(output);
  const restored = !ok && /^BMXRESULT restored\s*$/m.test(output);
  const said = restored ? (output.split(/^BMXRESULT restored\s*$/m)[1] ?? "").replace(/^BMXSRC ended\s*$/m, "").trim() : "";
  return { ok, restored, backup, said };
}

/**
 * After switching: every Debian and Proxmox source that's on must now name the new release, which Proxmox flags as
 * the next one. Anything still on the old release, or no flag at all, means the switch didn't take.
 */
export function switched(repos: RawRepositories, from: string): string[] {
  const origins = new Map((repos.infos ?? []).filter((x) => x.kind === "origin").map((x) => [`${x.path}#${x.index}`, x.message ?? ""]));
  const left: string[] = [];
  for (const f of repos.files ?? [])
    (f.repositories ?? []).forEach((r, index) => {
      if (!(r.Enabled === true || r.Enabled === 1)) return;
      const origin = origins.get(`${f.path}#${index}`);
      const ours = origin === "Debian" || origin === "Proxmox" || (r.URIs ?? []).some((u) => PROXMOX_URI.test(u) || /debian\.org|mirror\+file:\/\/\/etc\/apt\/mirrors\/debian/.test(u));
      if (ours && (r.Suites ?? []).some((s) => s === from || s.startsWith(`${from}-`))) left.push(`${f.path}: ${(r.Suites ?? []).join(" ")}`);
    });
  return left;
}

export interface SourcesDeps {
  pve: { get<T>(path: string, ticket: string): Promise<T> };
  console: (node: string, session: Session, line: string, timeoutMs?: number) => Promise<ShellResult>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  /** The node being upgraded, if one is: its sources mustn't change under it. */
  upgrading?: () => string | null;
  wait?: (ms: number) => Promise<void>;
}
/** A switch is a backup, a few file edits and apt's update: 15 minutes covers a very slow mirror. */
const SWITCH_LIMIT_MS = 15 * 60 * 1000;
export interface NodeSources {
  /** The backup to go back to, while the node is switched. */
  backup: string | null;
  switchedAt: number | null;
  others: SwitchPlan["others"];
  error: string | null;
}

export function createUpgradeSources(deps: SourcesDeps, now: () => number = Date.now) {
  const state: Record<string, NodeSources> = {};
  let busy = false;
  const pause = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const guard = async <T>(session: Session, node: string, confirm: string, job: () => Promise<T>): Promise<T> => {
    if (session.username !== "root@pam") throw new HttpError(403, "This runs in the node's root console. Sign in as root@pam.");
    if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
    if (busy) throw new HttpError(409, "BossMox is already changing a node's sources. Wait for it to finish.");
    const upgrading = deps.upgrading?.();
    if (upgrading) throw new HttpError(409, `BossMox is upgrading ${upgrading}. Its sources can't change until that ends.`);
    busy = true;
    try {
      return await job();
    } finally {
      busy = false;
    }
  };
  const repos = (session: Session, node: string) => deps.pve.get<RawRepositories>(`/nodes/${encodeURIComponent(node)}/apt/repositories`, session.ticket);

  /** Runs the switch as its job on the node and follows it to its end, through a console that closes. */
  async function runSwitch(session: Session, node: string, plan: SwitchPlan): Promise<string> {
    const until = now() + SWITCH_LIMIT_MS;
    let out = await deps.console(node, session, switchCommand(plan), SWITCH_LIMIT_MS).then(
      (r) => r.output,
      () => "",
    );
    while (!/^BMXSRC ended\s*$/m.test(out)) {
      if (now() > until) return out;
      await pause(10_000);
      out = await deps.console(node, session, followSwitchCommand()).then(
        (r) => r.output,
        () => "",
      );
    }
    return out;
  }

  return {
    view: () => state,

    /** True while a source change is under way. The upgrade only takes a node once nothing else is changing it. */
    busy: () => busy,

    /**
     * Once the upgrade starts, the old sources must never go back: the node would be half on each release. The backup
     * file stays on the node for anyone who needs it by hand.
     */
    forget(node: string) {
      delete state[node];
    },

    /** Switches one node to the next release's sources. A failed apt update puts the old ones back by itself. */
    switchNode(session: Session, node: string, confirm: string, from: string, to: string): Promise<NodeSources> {
      return guard(session, node, confirm, async () => {
        const plan = planSwitch(await repos(session, node), from, to);
        if (plan.problems.length) throw new HttpError(400, plan.problems.join(" "));
        const r = readSwitch(await runSwitch(session, node, plan));
        const left = r.ok ? switched(await repos(session, node), from) : [];
        const error = r.ok
          ? left.length
            ? `Some Debian or Proxmox sources still name ${from}: ${left.join("; ")}.`
            : null
          : r.restored
            ? `apt couldn't use the new sources, so the old ones were put back.${r.said ? ` apt said: ${r.said}` : ""}`
            : `BossMox couldn't tell how the switch on ${node} ended, so its sources may be part way.${r.backup ? ` Put the old sources back restores the backup ${r.backup}.` : ` Check /etc/apt on ${node}; the log is ${SOURCES_LOG}.`}`;
        // The backup stays on offer unless the node itself said the old sources are back.
        state[node] = { backup: r.restored ? null : r.backup, switchedAt: r.ok ? now() : null, others: plan.others, error };
        deps.audit("upgrade-sources", session.username, { node, to, ok: error ? 0 : 1 });
        return state[node];
      });
    },

    /** Puts the backup from the switch back. */
    undo(session: Session, node: string, confirm: string): Promise<NodeSources> {
      return guard(session, node, confirm, async () => {
        const backup = state[node]?.backup;
        if (!backup) throw new HttpError(400, `BossMox has no backup of ${node}'s sources to put back.`);
        const r = await deps.console(node, session, undoCommand(backup));
        state[node] =
          r.exitCode === 0
            ? { backup: null, switchedAt: null, others: [], error: null }
            : { ...(state[node] as NodeSources), error: `Putting the old sources back ended with exit code ${r.exitCode}. The backup is ${backup}.` };
        deps.audit("upgrade-sources-undo", session.username, { node, ok: r.exitCode === 0 ? 1 : 0 });
        return state[node] as NodeSources;
      });
    },
  };
}
export type UpgradeSources = ReturnType<typeof createUpgradeSources>;
