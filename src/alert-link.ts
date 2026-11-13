/**
 * How Proxmox hands alerts to BossMox for email (ADR 0040). Proxmox's webhook trusts only the node's own certificate
 * list, so each node is given BossMox's CA, which can vouch for BossMox's own addresses and nothing else. Proxmox then
 * posts each alert over HTTPS with a key it keeps in its private config; BossMox keeps only the key's hash, takes alerts
 * only from the nodes it gave the CA to, and sends them on by email.
 */
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Session } from "./auth.js";
import type { Email } from "./email.js";
import { HttpError } from "./http-error.js";
import { writeJsonAtomic } from "./json-file.js";
import type { ShellResult } from "./node-shell.js";
import type { PveClient } from "./pve.js";

export const INBOUND_PATH = "/api/alerts/inbound";
const CA_ON_NODE = "/usr/local/share/ca-certificates/bossmox-ca.crt";
/** Proxmox's own alerts are a handful a day. More than this in an hour is something wrong, not news. */
const PER_HOUR = 60;

interface Saved {
  keyHash: string;
  /** Every address each node has, not just its cluster one: it may reach BossMox from another network. */
  nodes: { name: string; ips: string[] }[];
  /** The CA's SHA-256 fingerprint when it was given to the nodes: a new CA means giving it to them again. */
  ca: string;
}

export interface LinkDeps {
  file: string;
  caFile: string;
  namesFile: string;
  port: number;
  /** Host names BossMox answers to: Proxmox has to post to one of these. */
  hostAllowed: (host: string) => boolean;
  pve: PveClient;
  console: (node: string, session: Session, line: string) => Promise<ShellResult>;
  email: Pick<Email, "send">;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  now?: () => number;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** The address as a node sees it connect: no IPv4-in-IPv6 prefix. */
export const plainAddress = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "");

/** The address Proxmox posts to: the first name BossMox's certificate covers and BossMox answers to, with the port when it isn't 443. */
export function inboundUrl(names: string[], port: number, hostAllowed: (host: string) => boolean = () => true): string | null {
  const first = names.find((n) => n && hostAllowed(n));
  if (!first) return null;
  const host = first.includes(":") ? `[${first}]` : first;
  return `https://${host}${port === 443 ? "" : `:${port}`}${INBOUND_PATH}`;
}

/** What's typed on each node: the CA into the system's list, then the list rebuilt. Nothing else on the node changes. */
export function trustLine(caPem: string): string {
  const b64 = Buffer.from(caPem, "utf8").toString("base64");
  return `printf %s '${b64}' | base64 -d > ${CA_ON_NODE}.new && mv ${CA_ON_NODE}.new ${CA_ON_NODE} && update-ca-certificates --fresh >/dev/null`;
}

export function createAlertLink(deps: LinkDeps) {
  const now = deps.now ?? Date.now;
  let recent: number[] = [];

  const load = (): Saved | null => {
    if (!existsSync(deps.file)) return null;
    try {
      return JSON.parse(readFileSync(deps.file, "utf8")) as Saved;
    } catch {
      return null;
    }
  };
  const readCa = () => {
    try {
      const pem = readFileSync(deps.caFile, "utf8");
      return { pem, fingerprint: new X509Certificate(pem).fingerprint256 };
    } catch {
      return null;
    }
  };
  const names = () => {
    try {
      return readFileSync(deps.namesFile, "utf8").trim().split(",").filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    /** Nodes that don't have BossMox's current CA: new since, or the CA changed (BossMox's address did). */
    missing(nodeNames: string[]): string[] {
      const saved = load();
      // Asked only while Proxmox sends to BossMox: no record means no node can get through.
      if (!saved) return nodeNames;
      const ca = readCa();
      if (!ca || ca.fingerprint !== saved.ca) return nodeNames;
      return nodeNames.filter((n) => !saved.nodes.some((s) => s.name === n));
    },

    /**
     * Gives every node BossMox's CA through its root console and makes a new key. Returns the address and key for
     * Proxmox's webhook target, and `keep`, which records the key's hash: called only once Proxmox has the key, so
     * a failed save leaves the old key working on both sides.
     */
    async connect(session: Session): Promise<{ url: string; key: string; keep: () => void }> {
      if (session.username !== "root@pam") throw new HttpError(403, "Setting up email alerts gives each node BossMox's certificate through its root console. Sign in as root@pam to do it.");
      const ca = readCa();
      if (!ca) throw new HttpError(400, "This BossMox install has no certificate authority yet. Update BossMox, then set up email.");
      const url = inboundUrl(names(), deps.port, deps.hostAllowed);
      if (!url) throw new HttpError(400, "None of the addresses BossMox's certificate covers is one BossMox answers to. Update BossMox, then set up email.");
      const status = await deps.pve.get<{ type?: string; name?: string; ip?: string; online?: number }[]>("/cluster/status", session.ticket);
      const nodes = status.filter((s) => s.type === "node");
      const off = nodes.filter((n) => n.online !== 1).map((n) => n.name);
      if (off.length) throw new HttpError(400, `Bring these online first, so they can be given BossMox's certificate: ${off.join(", ")}.`);
      const list = await Promise.all(
        nodes
          .filter((n) => n.name)
          .map(async (n) => {
            const ifaces = await deps.pve.get<{ address?: string; address6?: string }[]>(`/nodes/${encodeURIComponent(n.name as string)}/network`, session.ticket).catch(() => []);
            const ips = [n.ip, ...ifaces.flatMap((i) => [i.address, i.address6])].filter((x): x is string => !!x);
            return { name: n.name as string, ips: [...new Set(ips)] };
          }),
      );
      if (!list.length || list.some((n) => !n.ips.length)) throw new HttpError(502, "Proxmox didn't list its nodes' addresses.");
      for (const n of list) {
        const r = await deps.console(n.name, session, trustLine(ca.pem));
        if (r.exitCode !== 0) throw new HttpError(502, `${n.name} didn't take BossMox's certificate (exit code ${r.exitCode}). Nothing was changed on the nodes after it.`);
      }
      const key = randomBytes(32).toString("hex");
      const keep = () => {
        writeJsonAtomic(deps.file, { keyHash: sha(key).toString("hex"), nodes: list, ca: ca.fingerprint } satisfies Saved);
        deps.audit("alert-link", session.username, { nodes: list.length });
      };
      return { url, key, keep };
    },

    /** An alert from Proxmox. Answers with the status to send back. */
    async receive(authorization: string | undefined, from: string | undefined, body: Record<string, unknown>): Promise<{ status: number; error?: string }> {
      const saved = load();
      if (!saved) return { status: 404, error: "Email alerts aren't set up." };
      const given = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
      if (!given || !timingSafeEqual(sha(given), Buffer.from(saved.keyHash, "hex"))) return { status: 401, error: "Wrong key." };
      if (!saved.nodes.some((n) => n.ips.includes(plainAddress(from)))) return { status: 403, error: "Not from a node of this cluster." };
      const t = now();
      recent = recent.filter((x) => t - x < 3600_000);
      if (recent.length >= PER_HOUR) return { status: 429, error: "Too many alerts this hour." };
      recent.push(t);
      const title = typeof body.title === "string" ? body.title.slice(0, 200) : "Proxmox alert";
      const message = typeof body.message === "string" ? body.message.slice(0, 20_000) : "";
      const severity = typeof body.severity === "string" ? body.severity.slice(0, 20) : "";
      await deps.email.send(`BossMox: ${title}`, `${message}${severity ? `\n\nSeverity: ${severity}` : ""}\n\nSent by BossMox from Proxmox's alerts.`);
      return { status: 200 };
    },

    /** Turning email off: the key stops working. The CA stays on the nodes; it can only vouch for BossMox. */
    forget() {
      if (existsSync(deps.file)) unlinkSync(deps.file);
    },
  };
}
export type AlertLink = ReturnType<typeof createAlertLink>;
