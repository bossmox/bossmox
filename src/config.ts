import { readFileSync } from "node:fs";

export interface Config {
  pveUrl: URL;
  pveCa?: Buffer;
  pveTlsName?: string;
  host: string;
  port: number;
  allowedHosts: Set<string>;
  tls?: { cert: Buffer; key: Buffer };
  behindProxy: boolean;
  allowHttp: boolean;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.PVE_URL;
  if (!url) throw new Error("PVE_URL is not set. Copy .env.example to .env and fill it in.");
  const pveUrl = new URL(url);
  if (pveUrl.protocol !== "https:" && !isLoopback(pveUrl.hostname)) {
    throw new Error("PVE_URL must use https, so passwords are never sent in the clear.");
  }
  const extra = (env.BOSSMOX_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const config: Config = {
    pveUrl,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    allowedHosts: new Set(["localhost", "127.0.0.1", ...extra]),
    behindProxy: env.BOSSMOX_BEHIND_HTTPS_PROXY === "1",
    allowHttp: env.BOSSMOX_ALLOW_HTTP === "1",
  };
  if (env.PVE_CA_FILE) config.pveCa = readFileSync(env.PVE_CA_FILE);
  if (env.PVE_TLS_NAME) config.pveTlsName = env.PVE_TLS_NAME;
  if (env.TLS_CERT_FILE && env.TLS_KEY_FILE) {
    config.tls = { cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) };
  }
  if (!isLoopback(config.host) && !config.tls && !config.behindProxy && !config.allowHttp) {
    throw new Error(
      "BossMox won't serve passwords over plain HTTP on a network. Set TLS_CERT_FILE and TLS_KEY_FILE, or put it behind an HTTPS proxy and set BOSSMOX_BEHIND_HTTPS_PROXY=1.",
    );
  }
  return config;
}
