/**
 * Switching one node's update sources to the next Debian and Proxmox release (ADR 0042, piece 4), with a backup to
 * go back to. Only Debian's and Proxmox's own sources change, picked by the origin Proxmox reports for each (as the
 * update guard does, ADR 0039); any other source is left as it is and named. Proxmox's old entries are replaced by
 * the new release's deb822 files on the same channel the node already uses. `apt update` has to come back clean, or
 * the backup goes back in by itself.
 */
import type { Session } from "./auth.js";
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

const PROXMOX_URI = /^https?:\/\/(download|enterprise)\.proxmox\.com\/debian\/(pve|ceph-[a-z]+)\/?$/;
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
restore() { rm -rf "$D"; mkdir -p "$D"; rm -f $A/sources.list; tar -C $A -xf "$B"; apt-get update -q >/dev/null 2>&1 || true; }
# Anything that fails from here puts the backup back.
trap 'restore; echo "BMXRESULT restored"; echo "The switch stopped part way, so the old sources were put back."' ERR
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
  if grep -Eq '^URIs:.*proxmox\\.com/debian/(pve|ceph-)' "$f"; then rm -f "$f"; continue; fi
  awk -v from="$FROM" -v to="$TO" -v urifile="$URIS" 'BEGIN{while((getline u < urifile)>0) if(u!="") uris[u]=1; RS=""; ORS="\\n\\n"}
    { deb=0; for (u in uris) if (index($0, u)) deb=1
      if (deb) { n=split($0, L, "\\n"); out=""
        for (i=1;i<=n;i++){ l=L[i]; if (l ~ /^Suites:/) { gsub(from "-backports", "", l); gsub(from, to, l); gsub(/  +/, " ", l); sub(/ +$/, "", l) } out = out (i>1?"\\n":"") l }
        $0=out }
      print }' "$f" > "$f.bmx"
  mv "$f.bmx" "$f"
done
cat > $D/${pveFile} <<'BMX_PVE'
${deb822(pveUri, p.to, p.pveComponent)}BMX_PVE
${ceph ? `cat > $D/ceph.sources <<'BMX_CEPH'\n${ceph}BMX_CEPH` : "true"}
rm -f "$URIS"
trap - ERR
if out=$(apt-get update 2>&1) && ! printf '%s\\n' "$out" | grep -Eq '^(Err|E):'; then echo "BMXRESULT ok"; else
  restore; echo "BMXRESULT restored"; printf '%s\\n' "$out" | grep -E '^(Err|E|W):' | head -5; fi
`;
}

/** Typed on the node: the script, carried as base64. */
export const switchCommand = (p: SwitchPlan) => `printf '%s' '${Buffer.from(switchScript(p), "utf8").toString("base64")}' | base64 -d | bash`;

/** Puts a backup made by the switch back, then refreshes the package lists. */
export const undoCommand = (backup: string) =>
  `case '${backup}' in /root/bossmox-apt-before-*.tar) ;; *) exit 64 ;; esac; [ -f '${backup}' ] && rm -rf /etc/apt/sources.list.d && mkdir -p /etc/apt/sources.list.d && rm -f /etc/apt/sources.list && tar -C /etc/apt -xf '${backup}' && apt-get update -q >/dev/null 2>&1`;

export interface SwitchResult {
  ok: boolean;
  backup: string | null;
  /** apt's own complaint when it had to go back. */
  said: string;
}
export function readSwitch(output: string): SwitchResult {
  const backup = /BMXBACKUP (\/root\/bossmox-apt-before-\S+\.tar)/.exec(output)?.[1] ?? null;
  const ok = /^BMXRESULT ok\s*$/m.test(output);
  const said = ok ? "" : (output.split(/^BMXRESULT restored\s*$/m)[1] ?? "").trim();
  return { ok, backup, said };
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
  console: (node: string, session: Session, line: string) => Promise<ShellResult>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
}
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
  const guard = async <T>(session: Session, node: string, confirm: string, job: () => Promise<T>): Promise<T> => {
    if (session.username !== "root@pam") throw new HttpError(403, "This runs in the node's root console. Sign in as root@pam.");
    if (confirm.toLowerCase() !== node.toLowerCase()) throw new HttpError(400, "Type the node's name to confirm.");
    if (busy) throw new HttpError(409, "BossMox is already changing a node's sources. Wait for it to finish.");
    busy = true;
    try {
      return await job();
    } finally {
      busy = false;
    }
  };
  const repos = (session: Session, node: string) => deps.pve.get<RawRepositories>(`/nodes/${encodeURIComponent(node)}/apt/repositories`, session.ticket);

  return {
    view: () => state,

    /** Switches one node to the next release's sources. A failed apt update puts the old ones back by itself. */
    switchNode(session: Session, node: string, confirm: string, from: string, to: string): Promise<NodeSources> {
      return guard(session, node, confirm, async () => {
        const plan = planSwitch(await repos(session, node), from, to);
        if (plan.problems.length) throw new HttpError(400, plan.problems.join(" "));
        const r = readSwitch((await deps.console(node, session, switchCommand(plan))).output);
        const left = r.ok ? switched(await repos(session, node), from) : [];
        const error = !r.ok
          ? `apt couldn't use the new sources, so the old ones were put back.${r.said ? ` apt said: ${r.said}` : ""}`
          : left.length
            ? `Some Debian or Proxmox sources still name ${from}: ${left.join("; ")}.`
            : null;
        state[node] = { backup: r.ok ? r.backup : null, switchedAt: r.ok ? now() : null, others: plan.others, error };
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
