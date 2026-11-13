/**
 * Can the heartbeat get a backup link (ADR 0035)? Only on a network that every node has on a different physical port
 * from its heartbeat: a VLAN on the same cable goes down with it. Pure: Proxmox's interface lists go in.
 */
import { inNetwork, networkOf } from "./cluster-net.js";

/** One entry of /nodes/{node}/network. */
export interface RawIface {
  iface?: string;
  type?: string;
  cidr?: string;
  bridge_ports?: string;
  slaves?: string;
  "vlan-raw-device"?: string;
}

/**
 * The physical ports an interface runs over: a bridge's ports, a bond's members, a VLAN's parent, followed down to
 * the network cards. Null when it can't be told (Open vSwitch, a loop, a name that isn't in the list).
 */
export function portsOf(ifaces: RawIface[], name: string, seen: Set<string> = new Set()): Set<string> | null {
  if (seen.has(name)) return null;
  seen.add(name);
  const i = ifaces.find((x) => x.iface === name);
  // A VLAN named eno1.20 or vmbr0.20 needn't be listed with its parent.
  const dot = /^(.+)\.\d+$/.exec(name);
  if (!i) return dot ? portsOf(ifaces, dot[1] as string, seen) : null;
  const words = (s?: string) => (s ?? "").split(/\s+/).filter(Boolean);
  const union = (names: string[]) => {
    const out = new Set<string>();
    for (const n of names) {
      const p = portsOf(ifaces, n, seen);
      if (!p) return null;
      for (const x of p) out.add(x);
    }
    return out;
  };
  switch (i.type) {
    case "eth":
      return new Set([name]);
    case "bridge":
      return union(words(i.bridge_ports));
    case "bond":
      return union(words(i.slaves));
    case "vlan": {
      const parent = i["vlan-raw-device"] ?? dot?.[1];
      return parent ? portsOf(ifaces, parent, seen) : null;
    }
    default:
      return null;
  }
}

export interface NodeIfaces {
  name: string;
  /** Heartbeat addresses by link number (ring0_addr, ring1_addr, ...). */
  rings: Record<number, string>;
  ifaces: RawIface[];
}

export type HeartbeatState =
  /** Two or more links already. */
  | { state: "backed-up"; links: number }
  /** One node, or not a cluster: nothing to back up. */
  | { state: "single" }
  /** Can't be told: a heartbeat given as a name, IPv6, or ports BossMox can't follow. */
  | { state: "unknown"; why: string }
  /** No network every node has on a second port. */
  | { state: "no-port"; nodes: string[] }
  | { state: "offer"; network: string; addresses: Record<string, string>; sharesMoves: boolean; link: number };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** What Settings and Health check say about a backup heartbeat link. */
export function heartbeatState(nodes: NodeIfaces[], moveNet: string | null): HeartbeatState {
  if (nodes.length < 2) return { state: "single" };
  const links = Math.max(...nodes.map((n) => Object.keys(n.rings).length));
  if (links >= 2) return { state: "backed-up", links };
  const choices = new Map<string, Map<string, string>>();
  const without: string[] = [];
  for (const n of nodes) {
    const hb = n.rings[0];
    if (!hb || !IPV4.test(hb)) return { state: "unknown", why: `${n.name}'s heartbeat is given as a name or an IPv6 address.` };
    const home = n.ifaces.find((i) => i.cidr && inNetwork(hb, i.cidr));
    if (!home?.iface) return { state: "unknown", why: `BossMox can't find which port ${n.name}'s heartbeat uses.` };
    const hbPorts = portsOf(n.ifaces, home.iface);
    if (!hbPorts?.size) return { state: "unknown", why: `BossMox can't follow ${n.name}'s heartbeat down to a network port.` };
    const hbNet = networkOf(home.cidr as string);
    const mine = new Map<string, string>();
    for (const i of n.ifaces) {
      if (!i.iface || !i.cidr) continue;
      const net = networkOf(i.cidr);
      if (!net || net === hbNet) continue;
      const ports = portsOf(n.ifaces, i.iface);
      if (!ports?.size || [...ports].some((p) => hbPorts.has(p))) continue;
      mine.set(net, i.cidr.split("/")[0] as string);
    }
    if (!mine.size) without.push(n.name);
    choices.set(n.name, mine);
  }
  if (without.length) return { state: "no-port", nodes: without };
  // Networks every node has on a second port, one moves don't use first.
  const shared = [...(choices.get(nodes[0]?.name as string) as Map<string, string>).keys()]
    .filter((net) => nodes.every((n) => choices.get(n.name)?.has(net)))
    .sort((a, b) => Number(a === moveNet) - Number(b === moveNet) || a.localeCompare(b));
  const network = shared[0];
  if (!network) return { state: "no-port", nodes: [] };
  return {
    state: "offer",
    network,
    addresses: Object.fromEntries(nodes.map((n) => [n.name, choices.get(n.name)?.get(network) as string])),
    sharesMoves: network === moveNet,
    link: 1,
  };
}
