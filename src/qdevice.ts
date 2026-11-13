/**
 * A tie-breaker vote for a two-node cluster (ADR 0037). The person sets up the vote machine and types its password
 * into a node's console themselves; BossMox checks the way there, installs corosync-qdevice on the nodes, opens that
 * console with `pvecm qdevice setup` typed in, and checks the vote afterwards.
 */
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import type { PveClient } from "./pve.js";
import { tieBreakerVotes } from "./server-detail.js";

export type TieBreakerState =
  | { state: "single" }
  /** An odd number of nodes: a tie-breaker would make things worse, as Proxmox says. */
  | { state: "odd"; nodes: number }
  | { state: "set"; connected: boolean }
  | { state: "offer"; nodes: number };

export function tieBreakerState(nodes: number, qdevice: Record<string, unknown> | null): TieBreakerState {
  if (nodes < 2) return { state: "single" };
  if (qdevice && Object.keys(qdevice).length) return { state: "set", connected: tieBreakerVotes(qdevice as { State?: string }) };
  if (nodes % 2 === 1) return { state: "odd", nodes };
  return { state: "offer", nodes };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The vote machine has to be outside the cluster: not a node, not a guest on it. */
export function addressProblem(address: string, nodes: Record<string, string[]>, guests: Record<string, string[]>): string | null {
  const m = IPV4.exec(address);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) return "Type the vote machine's IPv4 address, like 192.168.1.50.";
  for (const [name, ips] of Object.entries(nodes)) if (ips.includes(address)) return `${address} is ${name}, one of the cluster's own nodes. The vote has to come from a machine outside the cluster.`;
  for (const [name, ips] of Object.entries(guests)) if (ips.includes(address)) return `${address} is ${name}, a guest on this cluster. If its node went down, the vote would go with it, so it has to be a machine outside the cluster.`;
  return null;
}

/** What `pvecm status` says about the tie-breaker: its vote, and the cluster's votes. */
export function readVotes(output: string): { qdevice: number; total: number | null; expected: number | null } {
  const q = /^\s*0x0+\s+(\d+)\s+Qdevice\b/m.exec(output);
  const total = /Total votes:\s*(\d+)/.exec(output);
  const expected = /Expected votes:\s*(\d+)/.exec(output);
  return { qdevice: q ? Number(q[1]) : 0, total: total ? Number(total[1]) : null, expected: expected ? Number(expected[1]) : null };
}

/** The lines the person runs on the vote machine as root (Debian or Ubuntu). */
export const VOTE_MACHINE_LINES = [
  "apt-get install -y corosync-qnetd",
  "printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/bossmox-tiebreaker.conf && systemctl reload ssh",
];
/** After setup: password logins for root can go again. */
export const VOTE_MACHINE_AFTER = "rm /etc/ssh/sshd_config.d/bossmox-tiebreaker.conf && systemctl reload ssh";

export const setupCommand = (address: string) => `pvecm qdevice setup ${address}`;

export interface TbStep {
  text: string;
  state: "doing" | "ok" | "failed";
}
export interface TbJob {
  running: boolean;
  by: string;
  address: string;
  steps: TbStep[];
  /** "ready": the nodes are ready, and the console step is next. */
  result: "ready" | "failed" | null;
  error: string | null;
  /** The node whose console runs the setup. */
  node: string;
}

export interface TbDeps {
  pve: PveClient;
  console: (node: string, session: Session, line: string) => Promise<{ exitCode: number; output: string }>;
  /** Addresses BossMox knows for each guest: guest agents and container settings. */
  guestAddresses: (session: Session) => Promise<Record<string, string[]>>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
}

const marker = (output: string, name: string) => new RegExp(`(?:^|\\n)__BMX_${name}__:(\\S*)`).exec(output)?.[1] ?? null;

export function createTieBreaker(deps: TbDeps) {
  const { pve } = deps;
  let job: TbJob | null = null;

  async function view(session: Session) {
    const t = session.ticket;
    const [status, qdevice] = await Promise.all([
      pve.get<{ type?: string; name?: string; quorate?: number; online?: number }[]>("/cluster/status", t),
      pve.get<Record<string, unknown>>("/cluster/config/qdevice", t).catch(() => null),
    ]);
    const cluster = status.find((s) => s.type === "cluster");
    const nodes = status.filter((s) => s.type === "node");
    const s = cluster ? tieBreakerState(nodes.length, qdevice) : ({ state: "single" } as const);
    return { ...s, clusterName: cluster?.name ?? "", quorate: cluster?.quorate === 1, offline: nodes.filter((n) => n.online !== 1).map((n) => n.name ?? ""), canSetUp: session.username === "root@pam", lines: VOTE_MACHINE_LINES, after: VOTE_MACHINE_AFTER };
  }

  /** Every node's addresses, from Proxmox's interface lists. */
  async function nodeAddresses(session: Session): Promise<Record<string, string[]>> {
    const members = await pve.get<Record<string, unknown>[]>("/cluster/config/nodes", session.ticket);
    const out: Record<string, string[]> = {};
    for (const m of members) {
      const name = String(m.node ?? m.name ?? "");
      const ifaces = await pve.get<{ cidr?: string }[]>(`/nodes/${encodeURIComponent(name)}/network`, session.ticket).catch(() => []);
      out[name] = [...ifaces.flatMap((i) => (i.cidr ? [i.cidr.split("/")[0] as string] : [])), ...Object.entries(m).filter(([k]) => /^ring\d+_addr$/.test(k)).map(([, v]) => String(v))];
    }
    return out;
  }

  /** Checks the way to the vote machine and installs corosync-qdevice on every node. The console step comes after. */
  async function prepare(session: Session, address: string, confirm: string) {
    if (job?.running) throw new HttpError(409, "The tie-breaker setup is already running.");
    if (session.username !== "root@pam") throw new HttpError(403, "Setting up a tie-breaker needs a root console on the nodes, so sign in as root@pam.");
    const v = await view(session);
    if (v.state !== "offer") throw new HttpError(400, v.state === "set" ? "This cluster already has a tie-breaker." : v.state === "odd" ? "A tie-breaker only helps with an even number of nodes." : "A tie-breaker needs a cluster.");
    if (v.offline.length) throw new HttpError(400, `Bring ${v.offline.join(", ")} back online first.`);
    if (!v.quorate) throw new HttpError(400, "The cluster has lost its majority, so nothing should change now.");
    if (confirm !== v.clusterName) throw new HttpError(400, `Type the cluster's name, ${v.clusterName}, to confirm.`);
    const nodes = await nodeAddresses(session);
    const problem = addressProblem(address, nodes, await deps.guestAddresses(session).catch(() => ({})));
    if (problem) throw new HttpError(400, problem);
    const names = Object.keys(nodes).sort();
    job = { running: true, by: session.username, address, steps: [], result: null, error: null, node: names[0] as string };
    deps.audit("tiebreaker-prepare", session.username, { address });
    const j = job;
    void (async () => {
      const step = (text: string) => {
        const s: TbStep = { text, state: "doing" };
        j.steps.push(s);
        return s;
      };
      const fail = (s: TbStep, text: string) => {
        Object.assign(s, { state: "failed", text });
        j.result = "failed";
        j.error = text;
      };
      let s = step(`Checking every node reaches ${address}`);
      for (const node of names) {
        const r = await deps.console(node, session, `ping -c1 -W2 ${address} >/dev/null 2>&1 && p=yes || p=no; timeout 3 bash -c '</dev/tcp/${address}/5403' 2>/dev/null && q=yes || q=no; printf '\\n__BMX_PING__:%s\\n__BMX_PORT__:%s\\n' $p $q`);
        const ping = marker(r.output, "PING");
        const port = marker(r.output, "PORT");
        if (ping === null || port === null) return fail(s, `BossMox couldn't check the way from ${node}.`);
        if (ping !== "yes") return fail(s, `${node} can't reach ${address}. Check the address, and that the vote machine is on.`);
        if (port !== "yes") return fail(s, `${node} reaches ${address}, but the vote service doesn't answer there (port 5403). Run the lines above on the vote machine first.`);
      }
      Object.assign(s, { state: "ok", text: `Every node reaches the vote service on ${address}` });
      s = step("Installing the tie-breaker software on every node");
      for (const node of names) {
        const r = await deps.console(node, session, "DEBIAN_FRONTEND=noninteractive apt-get install -y -q corosync-qdevice >/dev/null 2>&1; dpkg -s corosync-qdevice >/dev/null 2>&1 && printf '\\n__BMX_QD__:yes\\n' || printf '\\n__BMX_QD__:no\\n'");
        if (marker(r.output, "QD") !== "yes") return fail(s, `corosync-qdevice didn't install on ${node}. Check that node's update channel in Health check.`);
      }
      Object.assign(s, { state: "ok", text: "The tie-breaker software is on every node" });
      j.result = "ready";
    })()
      .catch((err: Error) => {
        j.result = "failed";
        j.error = err.message;
      })
      .finally(() => {
        j.running = false;
        for (const st of j.steps) if (st.state === "doing") st.state = "failed";
        deps.audit("tiebreaker-prepared", session.username, { result: j.result ?? "failed" });
      });
  }

  /** After the console step: is the tie-breaker voting? */
  async function verify(session: Session) {
    const node: string = job?.node ?? Object.keys(await nodeAddresses(session)).sort()[0] ?? "";
    if (!node) throw new HttpError(400, "BossMox couldn't find a node to check from.");
    const r = await deps.console(node, session, "printf '\\n__BMX_ST__\\n'; pvecm status; printf '\\n__BMX_END__\\n'");
    const out = /__BMX_ST__\n([\s\S]*?)\n__BMX_END__/.exec(r.output)?.[1] ?? "";
    const votes = readVotes(out);
    if (votes.qdevice > 0) deps.audit("tiebreaker-voting", session.username, { total: votes.total ?? 0 });
    return { voting: votes.qdevice > 0, ...votes };
  }

  return { view, prepare, verify, job: () => job };
}
