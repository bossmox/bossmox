import http from "node:http";
import tls from "node:tls";

const TIMEOUT_MS = 10000;

export interface Peer {
  fingerprint: string;
  subject: string;
}
export class PinError extends Error {}
export class PveReply extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

/** "10.0.0.5", "pve1.lan:8006" or "https://10.0.0.5:8006/" all come down to a host and port, or null. */
export function parseAddress(input: string): { host: string; port: number } | null {
  const s = input.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "");
  const m = s.match(/^(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]{0,252})(?::(\d{1,5}))?$/i);
  if (!m) return null;
  const port = Number(m[2] ?? 8006);
  if (port < 1 || port > 65535) return null;
  return { host: (m[1] as string).toLowerCase(), port };
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "");

function connect(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // Nothing is trusted yet, which is the point. The certificate gets compared by fingerprint before anything is sent.
    const socket = tls.connect({ host: bare(host), port, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => socket.destroy(new Error("That address didn't answer.")));
  });
}

/** Reads a server's certificate without sending it anything. */
export async function probe(host: string, port: number): Promise<Peer> {
  const socket = await connect(host, port);
  const cert = socket.getPeerCertificate();
  socket.destroy();
  if (!cert?.fingerprint256) throw new Error("That address didn't show a certificate.");
  return { fingerprint: cert.fingerprint256, subject: cert.subject?.CN ?? "" };
}

export interface Pinned {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * One call to a server, only after its certificate matches the fingerprint a person confirmed. The check happens on
 * the open connection before the request exists, so a password can't reach the wrong machine.
 */
export async function call<T>(to: Pinned, method: "GET" | "POST" | "PUT", path: string, opts: { ticket?: string; csrf?: string; form?: Record<string, string> } = {}): Promise<T> {
  const socket = await connect(to.host, to.port);
  if (socket.getPeerCertificate()?.fingerprint256 !== to.fingerprint) {
    socket.destroy();
    throw new PinError("That server's certificate has changed since you confirmed it.");
  }
  const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  const headers: Record<string, string> = { Host: to.host };
  if (opts.ticket) headers.Cookie = `PVEAuthCookie=${encodeURIComponent(opts.ticket)}`;
  if (opts.csrf) headers.CSRFPreventionToken = opts.csrf;
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  return new Promise<T>((resolve, reject) => {
    // Plain http over the checked socket: an https request or an agent would open a connection of its own.
    const req = http.request({ method, path: `/api2/json${path}`, headers, timeout: TIMEOUT_MS, createConnection: () => socket }, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) return reject(new PveReply(status, res.statusMessage ?? `Proxmox answered ${status}`));
        try {
          resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: T }).data);
        } catch {
          reject(new PveReply(status, "Proxmox sent an unreadable reply."));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Proxmox took too long to answer.")));
    req.on("error", reject);
    req.end(body);
  });
}
