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
export class PveClient {
  private current = 0;

  constructor(private readonly config: Pick<Config, "pveUrl" | "pveUrls" | "pveCa" | "pveTlsName">) {}

  /** The address that last answered. Terminals use it too. */
  get activeUrl(): URL {
    return this.config.pveUrls[this.current] ?? this.config.pveUrl;
  }

  /**
   * Tries each Proxmox address until one answers. Only a failed connection moves to the next
   * address, because then the request never reached Proxmox and can't have run twice.
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
        const code = (err as NodeJS.ErrnoException).code ?? "";
        const unreachable = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(code) || (method === "GET" && err instanceof Error && !(err instanceof PveError));
        if (!unreachable || i >= urls.length - 1) throw err;
      }
    }
  }

  private attempt<T>(base: URL, method: "GET" | "POST" | "PUT" | "DELETE", path: string, ticket?: string, body?: string, csrf?: string): Promise<T> {
    const url = new URL("/api2/json" + path, base);
    const secure = url.protocol === "https:";
    const headers: Record<string, string> = {};
    if (ticket) headers.Cookie = `PVEAuthCookie=${encodeURIComponent(ticket)}`;
    if (csrf) headers.CSRFPreventionToken = csrf;
    if (body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const options: https.RequestOptions = { method, headers, timeout: 8000 };
    if (secure && this.config.pveCa) options.ca = this.config.pveCa;
    const tlsName = this.config.pveTlsName;
    if (secure && tlsName) {
      options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(tlsName, cert);
    }

    return new Promise<T>((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new PveError(status, `Proxmox answered ${status} for ${path}`, res.statusMessage));
            return;
          }
          try {
            resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: T }).data);
          } catch {
            reject(new PveError(status, `Proxmox sent an unreadable reply for ${path}`));
          }
        });
      };
      const req = secure ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
      req.on("timeout", () => req.destroy(new Error("Proxmox took too long to answer")));
      req.on("error", reject);
      req.end(body);
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

  post<T>(path: string, who: Identity, form: Record<string, string> = {}): Promise<T> {
    return this.request<T>("POST", path, who.ticket, new URLSearchParams(form).toString(), who.csrf);
  }

  put<T>(path: string, who: Identity, form: Record<string, string> = {}): Promise<T> {
    return this.request<T>("PUT", path, who.ticket, new URLSearchParams(form).toString(), who.csrf);
  }

  delete<T>(path: string, who: Identity): Promise<T> {
    return this.request<T>("DELETE", path, who.ticket, undefined, who.csrf);
  }
}

export class PveError extends Error {
  /** `reason` is Proxmox's own explanation, which is worth showing when it refuses an action. */
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
  }
}
