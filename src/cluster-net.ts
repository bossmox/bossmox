/**
 * Do VM moves share the cluster heartbeat's only network? (ADR 0028)
 *
 * Proxmox's heartbeat (corosync) needs low, steady latency. A live move fills whatever network it runs on. When the
 * two share a network and that's the heartbeat's only link, heavy moves can make the nodes lose touch, and HA then
 * restarts a node to protect its VMs. Seen on a production cluster 2026-11-10: six moves at once on a 1 Gb link,
 * heartbeat lost, a node fenced, eight VMs restarted.
 *
 * Proxmox's API gives each node's addresses but not port speeds, so this judges by networks, not by speed.
 */

export interface NodeNets {
  name: string;
  /** Heartbeat addresses from the cluster config: ring0_addr, ring1_addr, ... */
  links: string[];
  /** The node's addresses with prefix, as Proxmox lists them ("10.0.0.57/24"). */
  addresses: string[];
}
export interface NetCheck {
  /** False when it couldn't be judged: one node, a heartbeat given as a name, or IPv6. Nothing is claimed then. */
  known: boolean;
  /** Moves run on the heartbeat's only network on at least one node. */
  shared: boolean;
  /** The network moves use: the Migration setting, or else the network of each node's first heartbeat address. */
  moveNet: string | null;
  /** Networks every node is on that moves don't use now, the best candidates first (no heartbeat on them). */
  others: string[];
  /** Moves at once that stay safe for the heartbeat. */
  batch: number;
}

export const SAFE_BATCH = 1;
export const FULL_BATCH = 3;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const toInt = (ip: string): number | null => {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.reduce((a, p) => a * 256 + p, 0);
};
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/** "10.0.0.57/24" → "10.0.0.0/24", or null when it isn't an IPv4 address with a prefix. */
export function networkOf(cidr: string): string | null {
  const [ip, bits] = cidr.trim().split("/");
  const n = toInt(ip ?? "");
  const len = Number(bits);
  if (n === null || !Number.isInteger(len) || len < 0 || len > 32) return null;
  const size = 2 ** (32 - len);
  return `${toIp(Math.floor(n / size) * size)}/${len}`;
}

/** Whether an IPv4 address falls inside a network given as "10.0.100.0/24". */
export function inNetwork(ip: string, net: string): boolean {
  const n = toInt(ip);
  const base = networkOf(net);
  if (n === null || !base) return false;
  const [b, bits] = base.split("/");
  const size = 2 ** (32 - Number(bits));
  return Math.floor(n / size) * size === toInt(b as string);
}

/** The network one of the node's own addresses puts this IP on, or null. */
const netFor = (ip: string, addresses: string[]) => {
  for (const a of addresses) {
    const net = networkOf(a);
    if (net && inNetwork(ip, net)) return net;
  }
  return null;
};

/** The network from Proxmox's Migration setting, given as "type=secure,network=10.0.100.0/24" or already split up. */
export function migrationNetwork(m: string | { network?: string } | undefined): string | null {
  if (typeof m === "string") return /(?:^|,)network=([^,]+)/.exec(m)?.[1] ?? null;
  return m?.network ?? null;
}

export function checkNetworks(nodes: NodeNets[], migrationNet: string | null): NetCheck {
  const unknown: NetCheck = { known: false, shared: false, moveNet: null, others: [], batch: SAFE_BATCH };
  if (nodes.length < 2) return unknown;
  const setNet = migrationNet ? networkOf(migrationNet) : null;
  if (migrationNet && !setNet) return unknown;
  let shared = false;
  let moveNet: string | null = setNet;
  const heartbeat = new Set<string>();
  for (const node of nodes) {
    const nets = node.links.map((l) => netFor(l, node.addresses));
    // A heartbeat given as a host name, or on an address the node doesn't list: can't tell, so don't guess.
    if (!nets.length || nets.some((n) => n === null)) return unknown;
    const hb = new Set(nets as string[]);
    for (const n of hb) heartbeat.add(n);
    const moves = setNet ?? (nets[0] as string);
    moveNet ??= moves;
    if ([...hb].every((n) => n === moves)) shared = true;
  }
  // Networks every node has an address on, other than the one moves use.
  const per = nodes.map((n) => new Set(n.addresses.map(networkOf).filter((x): x is string => !!x)));
  const common = [...(per[0] ?? [])].filter((net) => per.every((s) => s.has(net)) && net !== moveNet);
  common.sort((a, b) => Number(heartbeat.has(a)) - Number(heartbeat.has(b)) || a.localeCompare(b));
  return { known: true, shared, moveNet, others: common, batch: shared ? SAFE_BATCH : FULL_BATCH };
}
