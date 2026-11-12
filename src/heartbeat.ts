/**
 * Setting up a backup heartbeat link (ADR 0035). Reads the cluster from Proxmox, then makes the one change Proxmox's
 * API can't: corosync.conf, in a node's root console. Every step is checked, and a link that doesn't come up is
 * taken out again by putting the old file back.
 */
import { createHash } from "node:crypto";
import type { Session } from "./auth.js";
import { migrationNetwork } from "./cluster-net.js";
import { addLink, CorosyncError, linkStatus, linksIn, linkUp, readConf, setVersion } from "./corosync.js";
import { runOnNode, type ShellConfig } from "./node-shell.js";
import type { PveClient } from "./pve.js";
import { heartbeatState, type HeartbeatState, type RawIface } from "./redundancy.js";
import type { TermProxy } from "./terminal.js";
import { HttpError } from "./http-error.js";

export type HeartbeatView = HeartbeatState & { clusterName: string; quorate: boolean; offline: string[]; canSetUp: boolean };

export interface HeartbeatStep {
  text: string;
  state: "doing" | "ok" | "failed";
}
export interface HeartbeatJob {
  running: boolean;
  by: string;
  startedAt: number;
  steps: HeartbeatStep[];
  /** "added": the link is up everywhere. "restored": it didn't come up and the old file is back. "failed": stopped before changing anything, or couldn't restore. */
  result: "added" | "restored" | "failed" | null;
  error: string | null;
}

export interface HeartbeatDeps {
  pve: PveClient;
  /** Runs one line in a node's root console and returns its exit code and what it printed. */
  console: (node: string, session: Session, line: string) => Promise<{ exitCode: number; output: string }>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

/** The real console: Proxmox's termproxy, as updates use (ADR 0027). */
export function nodeConsole(pve: PveClient, shell: () => ShellConfig) {
  return async (node: string, session: Session, line: string) => {
    const proxy = await pve.post<TermProxy>(`/nodes/${encodeURIComponent(node)}/termproxy`, session);
    return runOnNode(shell(), node, session.ticket, proxy, `( ${line} ); echo __BOSSMOX_DONE__:$?\n`, 2 * 60 * 1000);
  };
}

const CONF = "/etc/pve/corosync.conf";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
/** What a console printed between two marker lines. The typed line's echo never matches: there the markers follow a printf. */
function between(output: string, start: string, end: string): string | null {
  const m = new RegExp(`(?:^|\\n)${start}\\n([\\s\\S]*?)\\n${end}(?:\\n|$)`).exec(output);
  return m ? (m[1] as string) : null;
}
const SETTLE_MS = 60 * 1000;

export function createHeartbeat(deps: HeartbeatDeps) {
  const { pve } = deps;
  let job: HeartbeatJob | null = null;

  /** What Settings and Health check show, read fresh from Proxmox. */
  async function view(session: Session): Promise<HeartbeatView> {
    const t = session.ticket;
    const [status, members, options] = await Promise.all([
      pve.get<{ type?: string; name?: string; quorate?: number; online?: number }[]>("/cluster/status", t),
      pve.get<Record<string, unknown>[]>("/cluster/config/nodes", t).catch(() => []),
      pve.get<{ migration?: string | { network?: string } }>("/cluster/options", t).catch((): { migration?: string | { network?: string } } => ({})),
    ]);
    const cluster = status.find((s) => s.type === "cluster");
    const offline = status.filter((s) => s.type === "node" && s.online !== 1).map((s) => s.name ?? "");
    const base = { clusterName: cluster?.name ?? "", quorate: cluster?.quorate === 1, offline, canSetUp: session.username === "root@pam" };
    if (!cluster || members.length < 2) return { state: "single", ...base };
    if (offline.length) return { state: "unknown", why: `${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} offline, so BossMox can't see ${offline.length === 1 ? "its" : "their"} network ports.`, ...base };
    const nodes = await Promise.all(members.map(async (m) => {
      const name = String(m.node ?? m.name ?? "");
      const rings = Object.fromEntries(Object.entries(m).filter(([k]) => /^ring\d+_addr$/.test(k)).map(([k, v]) => [Number(/\d+/.exec(k)?.[0]), String(v)]));
      const ifaces = await pve.get<RawIface[]>(`/nodes/${encodeURIComponent(name)}/network`, t);
      return { name, rings, ifaces };
    }));
    return { ...heartbeatState(nodes, migrationNetwork(options.migration)), ...base };
  }

  /** Starts the setup after checking everything again here; the page's copy of the plan is only a request. */
  async function start(session: Session, network: string, confirm: string): Promise<void> {
    if (job?.running) throw new HttpError(409, "A heartbeat change is already running.");
    if (session.username !== "root@pam") throw new HttpError(403, "Changing the heartbeat needs a root console on the nodes, so sign in as root@pam.");
    const v = await view(session);
    if (v.state !== "offer") throw new HttpError(400, v.state === "backed-up" ? "The heartbeat already has a backup link." : "A backup link can't be set up right now. Settings says why.");
    if (v.network !== network) throw new HttpError(400, "The network has changed since the page was drawn. Look again.");
    if (!v.quorate) throw new HttpError(400, "The cluster has lost its majority, so nothing should change now.");
    if (confirm !== v.clusterName) throw new HttpError(400, `Type the cluster's name, ${v.clusterName}, to confirm.`);
    job = { running: true, by: session.username, startedAt: deps.now(), steps: [], result: null, error: null };
    deps.audit("heartbeat-link-start", session.username, { network });
    void run(job, session, v).catch((err: Error) => {
      if (!job) return;
      job.error = err.message;
      job.result ??= "failed";
    }).finally(() => {
      if (!job) return;
      job.running = false;
      for (const s of job.steps) if (s.state === "doing") s.state = "failed";
      deps.audit("heartbeat-link-end", session.username, { result: job.result ?? "failed" });
    });
  }

  async function run(j: HeartbeatJob, session: Session, v: Extract<HeartbeatView, { state: "offer" }>) {
    const step = (text: string) => {
      const s: HeartbeatStep = { text, state: "doing" };
      j.steps.push(s);
      return { ok: (t?: string) => Object.assign(s, { state: "ok", ...(t ? { text: t } : {}) }), fail: (t: string) => Object.assign(s, { state: "failed", text: t }) };
    };
    const nodes = Object.keys(v.addresses);
    const first = nodes[0] as string;
    const fail = (s: { fail: (t: string) => unknown }, text: string) => {
      s.fail(text);
      j.result = "failed";
      j.error = text;
    };

    // 1. The file as it is now.
    let s = step(`Reading the heartbeat settings on ${first}`);
    const read = await deps.console(first, session, `printf '\\n__BMX_B64__\\n'; base64 -w0 ${CONF}; printf '\\n__BMX_END__\\n'`);
    const raw = between(read.output, "__BMX_B64__", "__BMX_END__");
    if (read.exitCode !== 0 || raw === null) return fail(s, `BossMox couldn't read ${CONF} on ${first}.`);
    const before = Buffer.from(raw.trim(), "base64").toString("utf8");
    let after: string;
    let ids: number[];
    try {
      const conf = readConf(before);
      if (linksIn(conf).length !== 1) return fail(s, "The heartbeat already has more than one link in its settings file.");
      if (conf.nodes.length !== nodes.length || conf.nodes.some((n) => !(n.name in v.addresses))) return fail(s, "The settings file's nodes don't match the cluster's. Nothing was changed.");
      after = addLink(before, v.link, v.addresses);
      ids = conf.nodes.map((n) => n.nodeid);
    } catch (err) {
      return fail(s, err instanceof CorosyncError ? err.message : "BossMox couldn't read the heartbeat settings file.");
    }
    s.ok(`Read the heartbeat settings on ${first}`);

    // 2. Every node reaches every other node on the new network.
    s = step(`Checking every node reaches the others on ${v.network}`);
    for (const node of nodes) {
      const others = nodes.filter((n) => n !== node).map((n) => v.addresses[n]).join(" ");
      const r = await deps.console(node, session, `bad=""; for a in ${others}; do ping -c1 -W2 $a >/dev/null 2>&1 || bad="$bad $a"; done; printf '\\n__BMX_PING__\\n%s\\n__BMX_END__\\n' "$bad"`);
      const missed = between(r.output, "__BMX_PING__", "__BMX_END__");
      if (missed === null) return fail(s, `BossMox couldn't check the network from ${node}.`);
      const where = missed.trim().split(/\s+/).filter(Boolean);
      if (where.length) return fail(s, `${node} can't reach ${where.join(", ")} on ${v.network}. Nothing was changed.`);
    }
    s.ok(`Every node reaches the others on ${v.network}`);

    // 3. The change, only if the file is still the one read.
    s = step(`Adding the backup link on ${v.network}`);
    const write = (from: string, to: string) =>
      deps.console(first, session, `[ "$(sha256sum ${CONF} | cut -c1-64)" = "${sha(from)}" ] || exit 3; echo ${b64(to)} | base64 -d > ${CONF}.new && [ "$(sha256sum ${CONF}.new | cut -c1-64)" = "${sha(to)}" ] || exit 4; cp ${CONF} ${CONF}.bak && mv ${CONF}.new ${CONF}`);
    const w = await write(before, after);
    if (w.exitCode === 3) return fail(s, "The heartbeat settings changed while BossMox was working. Nothing was changed; look again.");
    if (w.exitCode !== 0) return fail(s, `BossMox couldn't write the new settings on ${first}. Nothing was changed.`);
    s.ok(`Added the backup link on ${v.network}. The old settings are kept in ${CONF}.bak`);
    deps.audit("heartbeat-link-written", session.username, { network: v.network });

    // 4. Every node sees the new link connected to every other node.
    s = step("Waiting for every node to connect over the backup link");
    const upEverywhere = async (link: number) => {
      const down: string[] = [];
      for (const node of nodes) {
        const r = await deps.console(node, session, "printf '\\n__BMX_CFG__\\n'; corosync-cfgtool -s; printf '\\n__BMX_END__\\n'");
        const out = between(r.output, "__BMX_CFG__", "__BMX_END__");
        if (out === null || !linkUp(linkStatus(out), link, ids)) down.push(node);
      }
      return down;
    };
    let down: string[] = nodes;
    for (const until = deps.now() + SETTLE_MS; ; await deps.wait(5000)) {
      down = await upEverywhere(v.link);
      if (!down.length || deps.now() > until) break;
    }
    if (!down.length) {
      s.ok("Every node is connected over the backup link");
      j.result = "added";
      return;
    }
    s.fail(`After a minute, ${down.join(", ")} ${down.length === 1 ? "isn't" : "aren't"} connected over the backup link.`);

    // 5. Not up everywhere: the old file goes back, with a higher version so corosync loads it.
    s = step("Putting the old heartbeat settings back");
    const back = setVersion(before, readConf(after).version + 1);
    const r = await write(after, back);
    if (r.exitCode !== 0) {
      j.result = "failed";
      j.error = `BossMox couldn't put the old settings back. They're in ${CONF}.bak on ${first}; the cluster still runs on link 0.`;
      return s.fail(j.error);
    }
    deps.audit("heartbeat-link-restored", session.username, { network: v.network });
    await deps.wait(10_000);
    const stillDown = await upEverywhere(0);
    const status = await pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", session.ticket).catch(() => []);
    const quorate = status.find((x) => x.type === "cluster")?.quorate === 1;
    if (stillDown.length || !quorate) {
      j.result = "failed";
      j.error = `The old settings are back, but ${stillDown.length ? `${stillDown.join(", ")} ${stillDown.length === 1 ? "doesn't" : "don't"} show the main link connected` : "the cluster hasn't got its majority"} yet. Look at the nodes.`;
      return s.fail(j.error);
    }
    s.ok("The old settings are back, and every node is connected on the main link");
    j.result = "restored";
  }

  return { view, start, job: () => job };
}
