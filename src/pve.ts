import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Config } from "./config.js";

/** Read-only Proxmox client. It has no way to send anything except GET. */
export class PveClient {
  constructor(private readonly config: Pick<Config, "pveUrl" | "pveToken" | "pveCa" | "pveTlsName">) {}

  get<T>(path: string): Promise<T> {
    const url = new URL("/api2/json" + path, this.config.pveUrl);
    const secure = url.protocol === "https:";
    const options: https.RequestOptions = {
      method: "GET",
      headers: { Authorization: `PVEAPIToken=${this.config.pveToken}` },
      timeout: 8000,
    };
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
            reject(new PveError(status, `Proxmox answered ${status} for ${path}`));
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
      req.end();
    });
  }
}

export class PveError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
