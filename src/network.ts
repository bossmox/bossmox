export interface RawInterface {
  iface?: string;
  type?: string;
  active?: number;
  cidr?: string;
  address?: string;
  netmask?: string;
  gateway?: string;
  bridge_ports?: string;
  slaves?: string;
  comments?: string;
  method?: string;
}
export interface RawDns {
  search?: string;
  dns1?: string;
  dns2?: string;
  dns3?: string;
}
interface GuestBridges {
  name: string;
  node: string;
  bridges: string[];
}

const KINDS: Record<string, string> = {
  bridge: "Virtual switch",
  OVSBridge: "Virtual switch",
  eth: "Network port",
  bond: "Combined ports",
  OVSBond: "Combined ports",
  vlan: "VLAN",
  OVSIntPort: "Internal port",
  vnet: "Virtual network",
};

/** Virtual switches first, because that's what guests plug into. Ports that are in use come before spare ones. */
function rank(i: { kind: string; used: boolean; active: boolean }): number {
  if (i.kind === "Virtual switch") return 0;
  return i.active || i.used ? 1 : 2;
}

/** One server's network in plain terms: what's plugged into what. */
export function buildNetwork(server: string, interfaces: RawInterface[], dns: RawDns | null, guests: GuestBridges[]) {
  const usedBy = new Map<string, string>();
  for (const i of interfaces) {
    for (const port of `${i.bridge_ports ?? ""} ${i.slaves ?? ""}`.split(/\s+/).filter(Boolean)) usedBy.set(port, i.iface ?? "");
  }
  const list = interfaces
    .filter((i) => i.iface)
    .map((i) => {
      const name = i.iface as string;
      const kind = (Object.hasOwn(KINDS, i.type ?? "") ? KINDS[i.type as string] : i.type) ?? "Unknown";
      return {
        name,
        kind,
        active: i.active === 1,
        address: i.cidr ?? (i.address && i.netmask ? `${i.address}/${i.netmask}` : ""),
        gateway: i.gateway ?? "",
        ports: (i.bridge_ports ?? i.slaves ?? "").split(/\s+/).filter(Boolean),
        partOf: usedBy.get(name) ?? "",
        used: usedBy.has(name),
        note: i.comments?.trim() ?? "",
        guests: guests.filter((g) => g.node === server && g.bridges.includes(name)).map((g) => g.name),
      };
    });
  return {
    server,
    interfaces: list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    dnsServers: dns ? [dns.dns1, dns.dns2, dns.dns3].filter((d): d is string => Boolean(d)) : [],
    searchDomain: dns?.search ?? "",
  };
}
export type NetworkView = ReturnType<typeof buildNetwork>;
