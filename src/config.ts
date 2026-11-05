import { readFileSync } from "node:fs";

export interface Config {
  pveUrl: URL;
  pveToken: string;
  pveCa?: Buffer;
  pveTlsName?: string;
  host: string;
  port: number;
  allowedHosts: Set<string>;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.PVE_URL;
  const token = env.PVE_TOKEN;
  if (!url) throw new Error("PVE_URL is not set. Copy .env.example to .env and fill it in.");
  if (!token) throw new Error("PVE_TOKEN is not set. Copy .env.example to .env and fill it in.");
  const pveUrl = new URL(url);
  if (pveUrl.protocol !== "https:" && !isLoopback(pveUrl.hostname)) {
    throw new Error("PVE_URL must use https, so the token is never sent in the clear.");
  }
  const extra = (env.BOSSMOX_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const config: Config = {
    pveUrl,
    pveToken: token,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    allowedHosts: new Set(["localhost", "127.0.0.1", ...extra]),
  };
  if (env.PVE_CA_FILE) config.pveCa = readFileSync(env.PVE_CA_FILE);
  if (env.PVE_TLS_NAME) config.pveTlsName = env.PVE_TLS_NAME;
  return config;
}
