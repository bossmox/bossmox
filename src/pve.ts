import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Config } from "./config.js";

export interface LoginResult {
  username: string;
  ticket: string;
  csrf: string;
  needsCode: boolean;
}
export interface Identity {
  ticket: string;
  csrf: string;
}

/**
 * Proxmox client. Everything runs with the signed-in person's own ticket, so Proxmox applies their
 * permissions. Writes go through named actions in server.ts, never a general pass-through.
 */
/** How long a read or a change may go quiet before BossMox gives up on that request. */
const READ_WAIT_MS = 8000;
const WRITE_WAIT_MS = 60_000;

/** A request body. A list is sent as the same name repeated, which is how Proxmox takes its array settings. */
export type Form = Record<string, string | string[]>;
export function encodeForm(form: Form): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  return out.toString();
}

export class PveClient {
  private current = 0;

  constructor(
    private readonly config: Pick<Config, "pveUrl" | "pveUrls" | "pveCa" | "pveTlsName">,
    private readonly waits = { read: READ_WAIT_MS, write: WRITE_WAIT_MS },
  ) {}

  /** The address that last answered. Terminals use it too. */
  get activeUrl(): URL {
    return this.config.pveUrls[this.current] ?? this.config.pveUrl;
  }

  /**
   * Tries each Proxmox address until one answers. Changes only move on when no connection ever
   * opened, however that showed up: a node that's off may just never answer. Once connected, a reset
   * can arrive after Proxmox got the request, and a reboot mustn't run twice. Reads, and signing in,
   * are safe to repeat.
   */
  private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, ticket?: string, body?: string, csrf?: string): Promise<T> {
    const urls = this.config.pveUrls;
    for (let i = 0; ; i++) {
      const index = (this.current + i) % urls.length;
      try {
        const out = await this.attempt<T>(urls[index] as URL, method, path, ticket, body, csrf);
        this.current = index;
        return out;
      } catch (err) {
        const repeatable = method === "GET" || path === "/access/ticket";
        const neverOpened = (err as { unreached?: boolean }).unreached === true;
        const unreachable = neverOpened || (repeatable && err instanceof Error && !(err instanceof PveError));
        if (!unreachable || i >= urls.length - 1) throw err;
      }
    }
  }

  private attempt<T>(base: URL, method: "GET" | "POST" | "PUT" | "DELETE", path: string, ticket?: string, body?: string, csrf?: string): Promise<T> {
    const url = new URL(`/api2/json${path}`, base);
    const secure = url.protocol === "https:";
    const headers: Record<string, string> = {};
    if (ticket) headers.Cookie = `PVEAuthCookie=${encodeURIComponent(ticket)}`;
    if (csrf) headers.CSRFPreventionToken = csrf;
    if (body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    // A change gets a connection of its own. On a reused one that has gone dead, nobody can tell whether Proxmox
    // got the request, so it couldn't safely move to another node.
    // A read that hangs moves on to another node after 8 seconds. A change gets a minute: some (deleting a disk,
    // making storage) take longer, and giving up early reported changes Proxmox went on to finish as failed (#59).
    const options: https.RequestOptions = { method, headers, timeout: method === "GET" ? this.waits.read : this.waits.write, ...(method === "GET" ? {} : { agent: false }) };
    if (secure && this.config.pveCa) options.ca = this.config.pveCa;
    const tlsName = this.config.pveTlsName;
    if (secure && tlsName) {
      options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(tlsName, cert);
    }

    return new Promise<T>((resolve, reject) => {
      // Errors name the path but never its query string, which can hold an SMB scan's password, so it can't reach a log.
      const where = path.split("?")[0];
      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new PveError(status, `Proxmox answered ${status} for ${where}`, res.statusMessage));
            return;
          }
          try {
            resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: T }).data);
          } catch {
            reject(new PveError(status, `Proxmox sent an unreadable reply for ${where}`));
          }
        });
      };
      const req = secure ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
      let connected = false;
      req.on("socket", (socket) => {
        if (socket.connecting)
          socket.once("connect", () => {
            connected = true;
          });
        else connected = true;
      });
      req.on("timeout", () =>
        req.destroy(new Error(method === "GET" ? "Proxmox took too long to answer" : "Proxmox took too long to answer, and it may still have made the change. Check before trying again.")),
      );
      req.on("error", (err) => reject(Object.assign(err, { unreached: !connected })));
      req.end(body);
    });
  }

  /**
   * Streams a file straight through to Proxmox, so a big ISO never sits in BossMox's memory or on its small disk.
   * Uploads can run for hours, so the timeout only catches a connection that has stopped moving.
   */
  upload(path: string, who: Identity, fields: Record<string, string>, file: { name: string; size: number; stream: NodeJS.ReadableStream }): Promise<string> {
    const boundary = `----BossMox${randomBytes(16).toString("hex")}`;
    const head =
      Object.entries(fields)
        .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
        .join("") + `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const url = new URL(`/api2/json${path}`, this.activeUrl);
    const headers = {
      Cookie: `PVEAuthCookie=${encodeURIComponent(who.ticket)}`,
      CSRFPreventionToken: who.csrf,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(Buffer.byteLength(head) + file.size + Buffer.byteLength(tail)),
    };
    const secure = url.protocol === "https:";
    const options: https.RequestOptions = { method: "POST", headers, timeout: 300000, agent: false };
    if (secure && this.config.pveCa) options.ca = this.config.pveCa;
    const tlsName = this.config.pveTlsName;
    if (secure && tlsName) options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(tlsName, cert);
    return new Promise<string>((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new PveError(status, `Proxmox answered ${status} for an upload`, res.statusMessage));
          try {
            resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: string }).data);
          } catch {
            reject(new PveError(status, "Proxmox sent an unreadable reply to an upload"));
          }
        });
      };
      const req = secure ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
      req.on("timeout", () => req.destroy(new Error("The upload stopped moving.")));
      req.on("error", reject);
      file.stream.on("error", (err) => req.destroy(err as Error));
      req.write(head);
      file.stream.pipe(req, { end: false });
      file.stream.on("end", () => req.end(tail));
    });
  }

  get<T>(path: string, ticket?: string): Promise<T> {
    return this.request<T>("GET", path, ticket);
  }

  async login(username: string, password: string, tfaChallenge?: string): Promise<LoginResult> {
    const form = new URLSearchParams({ username, password });
    if (tfaChallenge) form.set("tfa-challenge", tfaChallenge);
    const data = await this.request<{ username: string; ticket: string; CSRFPreventionToken?: string; NeedTFA?: number }>("POST", "/access/ticket", undefined, form.toString());
    return { username: data.username, ticket: data.ticket, csrf: data.CSRFPreventionToken ?? "", needsCode: data.NeedTFA === 1 };
  }

  post<T>(path: string, who: Identity, form: Form = {}): Promise<T> {
    return this.request<T>("POST", path, who.ticket, encodeForm(form), who.csrf);
  }

  put<T>(path: string, who: Identity, form: Form = {}): Promise<T> {
    return this.request<T>("PUT", path, who.ticket, encodeForm(form), who.csrf);
  }

  delete<T>(path: string, who: Identity): Promise<T> {
    return this.request<T>("DELETE", path, who.ticket, undefined, who.csrf);
  }
}

export class PveError extends Error {
  /** `reason` is Proxmox's own explanation, which is worth showing when it refuses an action. */
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
