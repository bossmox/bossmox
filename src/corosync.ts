/**
 * Reading and changing /etc/pve/corosync.conf, the cluster heartbeat's settings (ADR 0035). Pure: the text goes in and
 * comes out. Changes are made line by line, so everything BossMox doesn't touch stays exactly as it was.
 */

export class CorosyncError extends Error {}

interface Block {
  path: string[];
  start: number;
  end: number;
  values: Map<string, { value: string; line: number }>;
  indent: string;
}

/** Every block in the file, with its key: value lines. Refuses text whose braces don't balance. */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  const stack: Block[] = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "");
    const open = /^(\s*)([\w.-]+)\s*\{\s*$/.exec(line);
    if (open) {
      const b: Block = { path: [...stack.map((s) => s.path.at(-1) as string), open[2] as string], start: i, end: -1, values: new Map(), indent: open[1] ?? "" };
      stack.push(b);
      out.push(b);
      return;
    }
    if (/^\s*\}\s*$/.test(line)) {
      const b = stack.pop();
      if (!b) throw new CorosyncError("The heartbeat settings file has a closing brace too many.");
      b.end = i;
      return;
    }
    const kv = /^\s*([\w.-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv && stack.length) stack.at(-1)?.values.set(kv[1] as string, { value: kv[2] as string, line: i });
  });
  if (stack.length) throw new CorosyncError("The heartbeat settings file has a block that isn't closed.");
  return out;
}

export interface Conf {
  clusterName: string;
  version: number;
  /** Each node with its heartbeat addresses by link number. */
  nodes: { name: string; nodeid: number; rings: Record<number, string> }[];
  /** The link numbers totem has an interface for. */
  interfaces: number[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function readConf(text: string): Conf {
  const all = blocks(text.split("\n"));
  const totem = all.find((b) => b.path.join("/") === "totem");
  if (!totem) throw new CorosyncError("The heartbeat settings file has no totem section.");
  const version = Number(totem.values.get("config_version")?.value);
  if (!Number.isInteger(version)) throw new CorosyncError("The heartbeat settings file has no config_version.");
  const nodes = all
    .filter((b) => b.path.join("/") === "nodelist/node")
    .map((b) => {
      const rings: Record<number, string> = {};
      for (const [k, v] of b.values) {
        const m = /^ring(\d+)_addr$/.exec(k);
        if (m) rings[Number(m[1])] = v.value;
      }
      return { name: b.values.get("name")?.value ?? "", nodeid: Number(b.values.get("nodeid")?.value), rings };
    });
  if (!nodes.length || nodes.some((n) => !n.name || !Number.isInteger(n.nodeid))) throw new CorosyncError("The heartbeat settings file's node list isn't complete.");
  const interfaces = all.filter((b) => b.path.join("/") === "totem/interface").map((b) => Number(b.values.get("linknumber")?.value ?? 0));
  return { clusterName: totem.values.get("cluster_name")?.value ?? "", version, nodes, interfaces };
}

/** The link numbers in use: any node's ringN_addr, or a totem interface. */
export function linksIn(conf: Conf): number[] {
  return [...new Set([...conf.nodes.flatMap((n) => Object.keys(n.rings).map(Number)), ...conf.interfaces])].sort((a, b) => a - b);
}

/**
 * The file with one more link: a ringN_addr for every node, a totem interface for link N, and config_version one
 * higher. Every node must get an IPv4 address, and nothing else may already use link N.
 */
export function addLink(text: string, link: number, addresses: Record<string, string>): string {
  const conf = readConf(text);
  if (linksIn(conf).includes(link)) throw new CorosyncError(`Link ${link} is already in the heartbeat settings.`);
  for (const n of conf.nodes) {
    const a = addresses[n.name];
    if (!a || !IPV4.test(a)) throw new CorosyncError(`There's no address for ${n.name} on the new network.`);
  }
  if (Object.keys(addresses).some((name) => !conf.nodes.some((n) => n.name === name))) throw new CorosyncError("The new addresses name a node the heartbeat settings don't have.");
  const lines = text.split("\n");
  const all = blocks(lines);
  // Inserted from the bottom up, so the line numbers found above stay right.
  const inserts: { after: number; text: string }[] = [];
  for (const b of all.filter((x) => x.path.join("/") === "nodelist/node")) {
    const name = b.values.get("name")?.value as string;
    const rings = [...b.values].filter(([k]) => /^ring\d+_addr$/.test(k)).map(([, v]) => v.line);
    const after = rings.length ? Math.max(...rings) : b.end - 1;
    const indent = /^(\s*)/.exec(lines[after] ?? "")?.[1] ?? `${b.indent}  `;
    inserts.push({ after, text: `${indent}ring${link}_addr: ${addresses[name]}` });
  }
  const totem = all.find((b) => b.path.join("/") === "totem") as Block;
  const ifaces = all.filter((b) => b.path.join("/") === "totem/interface");
  const lastIface = ifaces.at(-1);
  const inner = lastIface ? lastIface.indent : `${totem.indent}  `;
  const valueIndent = lastIface ? (/^(\s*)/.exec(lines[lastIface.start + 1] ?? "")?.[1] ?? `${inner}  `) : `${inner}  `;
  inserts.push({ after: lastIface ? lastIface.end : totem.start, text: `${inner}interface {\n${valueIndent}linknumber: ${link}\n${inner}}` });
  const out = [...lines];
  for (const ins of inserts.sort((a, b) => b.after - a.after)) out.splice(ins.after + 1, 0, ins.text);
  return setVersion(out.join("\n"), conf.version + 1);
}

/** The same text with config_version set. Corosync only reloads a higher version, so putting a file back raises it too. */
export function setVersion(text: string, version: number): string {
  const lines = text.split("\n");
  const totem = blocks(lines).find((b) => b.path.join("/") === "totem");
  const at = totem?.values.get("config_version")?.line;
  if (at === undefined) throw new CorosyncError("The heartbeat settings file has no config_version.");
  lines[at] = (lines[at] as string).replace(/(config_version\s*:\s*)\d+/, `$1${version}`);
  return lines.join("\n");
}

/**
 * Each link's state from `corosync-cfgtool -s`, by node ID: "connected", "localhost", "disconnected", ...
 *   LINK ID 1 udp
 *     addr = 10.0.31.244
 *     status:
 *       nodeid:  2:  connected
 */
export function linkStatus(output: string): Record<number, Record<number, string>> {
  const out: Record<number, Record<number, string>> = {};
  let link: number | null = null;
  for (const line of output.split("\n")) {
    const l = /^\s*LINK ID (\d+)/.exec(line);
    if (l) {
      link = Number(l[1]);
      out[link] = {};
      continue;
    }
    const n = /^\s*nodeid:\s*(\d+):\s*(\S+)/.exec(line);
    if (n && link !== null) (out[link] as Record<number, string>)[Number(n[1])] = n[2] as string;
  }
  return out;
}

/** Whether a node sees the link connected to every other node. */
export function linkUp(status: Record<number, Record<number, string>>, link: number, nodeIds: number[]): boolean {
  const s = status[link];
  return !!s && nodeIds.every((id) => s[id] === "connected" || s[id] === "localhost");
}
