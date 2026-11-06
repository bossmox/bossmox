import { randomBytes } from "node:crypto";
import type http from "node:http";
import tls from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "./config.js";
import type { Session } from "./auth.js";

const TTL_MS = 30 * 1000;
const CONNECT_MS = 10 * 1000;
const MAX_QUEUED = 256;

export interface TermProxy {
  port: number;
  ticket: string;
  user: string;
  upid: string;
}
interface Pending extends TermProxy {
  server: string;
  session: Session;
  expiresAt: number;
  /** The Proxmox path this session belongs to: a server, or one VM or container on it. */
  path: string;
  /** A VM's screen is plain binary VNC, with none of the terminal's login line or text framing. */
  raw: boolean;
  /** An update can run a long time with nobody typing, and cutting it off would interrupt the install. */
  outputCounts: boolean;
}

/**
 * Whether a message from the browser came from a person. A console shouldn't stay open forever because the page
 * pings it, or because noVNC keeps asking for screen updates. Terminal messages are "0:" for input, "1:" for a
 * resize and "2" for a ping. VNC is a stream of typed messages: 3 asks for the screen, 4 is a key, 5 is the mouse.
 */
export function fromPerson(data: Buffer, raw: boolean): boolean {
  if (!raw) return data.subarray(0, 2).toString() === "0:";
  for (let at = 0; at < data.length; ) {
    if (data[at] !== 3) return true; // Input, or something unknown, which isn't worth cutting a person off over.
    at += 10;
  }
  return false;
}

/** Connects the browser's terminal to Proxmox. The browser never sees either Proxmox ticket. */
export class Terminals {
  private readonly pending = new Map<string, Pending>();
  private readonly live = new Map<Session, Set<() => void>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(private readonly config: Pick<Config, "pveCa" | "pveTlsName" | "consoleIdleMs"> & { readonly pveUrl: URL }) {}

  /** One-time ID: valid once, only for the session that asked, and only for 30 seconds. */
  prepare(server: string, session: Session, proxy: TermProxy, target: { path?: string; raw?: boolean; outputCounts?: boolean } = {}): string {
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    const id = randomBytes(32).toString("base64url");
    const path = target.path ?? `/nodes/${encodeURIComponent(server)}`;
    this.pending.set(id, { ...proxy, server, session, expiresAt: now + TTL_MS, path, raw: target.raw === true, outputCounts: target.outputCounts === true });
    return id;
  }

  /** Registers an open console under its session, and returns the call that removes it. */
  track(session: Session, close: () => void): () => void {
    const open = this.live.get(session) ?? new Set();
    open.add(close);
    this.live.set(session, open);
    return () => {
      open.delete(close);
      if (open.size === 0 && this.live.get(session) === open) this.live.delete(session);
    };
  }

  /** Signing out has to cut every console at once: they're root shells, and otherwise they'd outlive the session. */
  closeSession(session: Session) {
    for (const [k, p] of this.pending) if (p.session === session) this.pending.delete(k);
    for (const close of [...(this.live.get(session) ?? [])]) close();
    this.live.delete(session);
  }

  hasOpen(session: Session): boolean {
    return (this.live.get(session)?.size ?? 0) > 0;
  }

  claim(id: string, session: Session): Pending | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || p.session !== session || p.expiresAt <= Date.now()) return undefined;
    return p;
  }

  connect(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, term: Pending) {
    this.wss.handleUpgrade(req, socket, head, (browser) => this.bridge(browser, term));
  }

  private bridge(browser: WebSocket, term: Pending) {
    const url = new URL(`/api2/json${term.path}/vncwebsocket`, this.config.pveUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("port", String(term.port));
    url.searchParams.set("vncticket", term.ticket);
    const tlsName = this.config.pveTlsName;
    const upstream = new WebSocket(url, "binary", {
      handshakeTimeout: CONNECT_MS,
      headers: { Cookie: `PVEAuthCookie=${encodeURIComponent(term.session.ticket)}` },
      ...(this.config.pveCa ? { ca: this.config.pveCa } : {}),
      ...(tlsName ? { checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(tlsName, cert) } : {}),
    });

    let ready = false;
    const queue: RawData[] = [];
    const forward = (m: RawData) => (term.raw ? upstream.send(m, { binary: true }) : upstream.send(m.toString()));
    const flush = () => {
      ready = true;
      for (const m of queue) forward(m);
      queue.length = 0;
    };
    let idle: NodeJS.Timeout;
    const closeBoth = () => {
      clearTimeout(idle);
      untrack();
      browser.close();
      upstream.close();
    };
    const untrack = this.track(term.session, closeBoth);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(closeBoth, this.config.consoleIdleMs);
    };
    touch();

    upstream.on("open", () => (term.raw ? flush() : upstream.send(`${term.user}:${term.ticket}\n`)));
    upstream.on("message", (data: RawData) => {
      if (term.outputCounts) touch();
      if (!ready) {
        if (!data.toString().startsWith("OK")) return closeBoth();
        return flush();
      }
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: true });
    });
    browser.on("message", (data: RawData) => {
      if (fromPerson(data as Buffer, term.raw)) touch();
      if (!ready) {
        if (queue.length >= MAX_QUEUED) closeBoth();
        else queue.push(data);
      } else if (upstream.readyState === WebSocket.OPEN) forward(data);
    });
    upstream.on("close", closeBoth);
    upstream.on("error", (err) => {
      console.error("Terminal connection failed:", err.message);
      closeBoth();
    });
    browser.on("close", closeBoth);
    browser.on("error", closeBoth);
  }
}
