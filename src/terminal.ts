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

// What xterm.js sends by itself when a program asks about the terminal: cursor position, device reports, focus.
const TERMINAL_REPLY = /^\x1b(\[\??[\d;]*[Rnc]|\[[IO]|\].*)$/s;

/**
 * Whether a message from the browser came from a person. A console shouldn't stay open forever because the page
 * pings it, or because noVNC keeps asking for screen updates. Terminal messages are "0:len:" for input, "1:" for a
 * resize and "2" for a ping. VNC is a stream of typed messages, and only 4 (key), 5 (mouse), 6 (paste) and QEMU's
 * extended key are a person. The rest get stepped over by length.
 */
export function fromPerson(data: Buffer, raw: boolean): boolean {
  if (!raw) {
    const text = data.toString();
    if (!text.startsWith("0:")) return false;
    return !TERMINAL_REPLY.test(text.slice(text.indexOf(":", 2) + 1));
  }
  const u16 = (at: number) => (data[at] ?? 0) * 256 + (data[at + 1] ?? 0);
  for (let at = 0; at < data.length; ) {
    const type = data[at];
    if (type === 4 || type === 5 || type === 6) return true;
    if (type === 255) return data[at + 1] === 0;
    if (type === 0) at += 20;
    else if (type === 2) at += 4 + 4 * u16(at + 2);
    else if (type === 3 || type === 150) at += 10;
    else if (type === 248) at += 9 + (data[at + 8] ?? 0);
    else if (type === 251) at += 8 + 16 * (data[at + 6] ?? 0);
    else return false;
  }
  return false;
}

/** Proxmox's updater prints this on a line of its own, then starts a root shell nobody asked for. */
export const UPDATER_DONE = /(^|\n)starting shell\r?\n/;
/** More output than a shell prompt after that line means it was something else printing those words. */
const AFTER_DONE_BYTES = 400;
const FINISH_MS = 2000;

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
    let tail = "";
    let afterDone = -1;
    let finishing: NodeJS.Timeout | undefined;
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
      clearTimeout(finishing);
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
      if (term.outputCounts) {
        touch();
        const chunk = data.toString();
        if (afterDone >= 0) {
          afterDone += chunk.length;
          if (afterDone > AFTER_DONE_BYTES) {
            clearTimeout(finishing);
            afterDone = -1;
          }
        } else {
          tail = (tail + chunk).slice(-200);
          if (UPDATER_DONE.test(tail)) {
            // Closing here ends the shell, and the page keeps the output on screen for reading.
            afterDone = 0;
            tail = "";
            finishing = setTimeout(closeBoth, FINISH_MS);
          }
        }
      }
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
      console.error("Terminal connection failed:", err.message.replace(/\?\S*/g, ""));
      closeBoth();
    });
    browser.on("close", closeBoth);
    browser.on("error", closeBoth);
  }
}
