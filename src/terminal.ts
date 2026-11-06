import { randomBytes } from "node:crypto";
import type http from "node:http";
import tls from "node:tls";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "./config.js";
import type { Session } from "./auth.js";

const TTL_MS = 30 * 1000;
const IDLE_MS = 30 * 60 * 1000;

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
}

/** Connects the browser's terminal to Proxmox. The browser never sees either Proxmox ticket. */
export class Terminals {
  private readonly pending = new Map<string, Pending>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(private readonly config: Pick<Config, "pveCa" | "pveTlsName"> & { readonly pveUrl: URL }) {}

  /** One-time ID: valid once, only for the session that asked, and only for 30 seconds. */
  prepare(server: string, session: Session, proxy: TermProxy): string {
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    const id = randomBytes(32).toString("base64url");
    this.pending.set(id, { ...proxy, server, session, expiresAt: now + TTL_MS });
    return id;
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
    const url = new URL(`/api2/json/nodes/${encodeURIComponent(term.server)}/vncwebsocket`, this.config.pveUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("port", String(term.port));
    url.searchParams.set("vncticket", term.ticket);
    const tlsName = this.config.pveTlsName;
    const upstream = new WebSocket(url, "binary", {
      headers: { Cookie: `PVEAuthCookie=${encodeURIComponent(term.session.ticket)}` },
      ...(this.config.pveCa ? { ca: this.config.pveCa } : {}),
      ...(tlsName ? { checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(tlsName, cert) } : {}),
    });

    let ready = false;
    const queue: RawData[] = [];
    let idle: NodeJS.Timeout;
    const closeBoth = () => {
      clearTimeout(idle);
      browser.close();
      upstream.close();
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(closeBoth, IDLE_MS);
    };
    touch();

    upstream.on("open", () => upstream.send(`${term.user}:${term.ticket}\n`));
    upstream.on("message", (data: RawData) => {
      touch();
      if (!ready) {
        if (!data.toString().startsWith("OK")) return closeBoth();
        ready = true;
        for (const m of queue) upstream.send(m.toString());
        queue.length = 0;
        return;
      }
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: true });
    });
    browser.on("message", (data: RawData) => {
      touch();
      if (!ready) queue.push(data);
      else if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
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
