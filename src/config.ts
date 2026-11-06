import { readFileSync } from "node:fs";

export interface Config {
  pveUrl: URL;
  pveUrls: URL[];
  pveCa?: Buffer;
  pveTlsName?: string;
  host: string;
  port: number;
  allowedHosts: Set<string>;
  tls?: { cert: Buffer; key: Buffer };
  behindProxy: boolean;
  allowHttp: boolean;
  /** Proxies whose X-Forwarded-For can be believed. Nobody else's is. */
  trustedProxies: Set<string>;
  consoleIdleMs: number;
}

const plainAddress = (a: string) => a.trim().toLowerCase().replace(/^::ffff:/, "");

/**
 * Whether a request's Origin is this exact site. Only a page served from the same scheme, name and port counts,
 * so another app on the same machine, or a page on someone's localhost, doesn't pass as BossMox.
 */
export function sameOrigin(origin: string, host: string | undefined, https: boolean): boolean {
  try {
    const o = new URL(origin);
    return o.protocol === (https ? "https:" : "http:") && o.host.toLowerCase() === (host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Who's really connecting. Behind a trusted proxy that's the nearest address in X-Forwarded-For that isn't
 * another trusted proxy. Reading from the right matters: a client can write anything into the left of that header.
 */
export function clientAddress(socketAddress: string | undefined, forwarded: string | undefined, trusted: Set<string>): string {
  const direct = plainAddress(socketAddress ?? "unknown");
  if (!trusted.has(direct) || !forwarded) return direct;
  const hops = forwarded.split(",").map(plainAddress).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!trusted.has(hop)) return hop;
  }
  return direct;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.PVE_URL;
  if (!url) throw new Error("PVE_URL is not set. Copy .env.example to .env and fill it in.");
  const pveUrls = url.split(",").map((u) => new URL(u.trim()));
  const pveUrl = pveUrls[0] as URL;
  if (pveUrls.some((u) => u.protocol !== "https:" && !isLoopback(u.hostname))) {
    throw new Error("PVE_URL must use https, so passwords are never sent in the clear.");
  }
  const extra = (env.BOSSMOX_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const config: Config = {
    pveUrl,
    pveUrls,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    allowedHosts: new Set(["localhost", "127.0.0.1", ...extra]),
    behindProxy: env.BOSSMOX_BEHIND_HTTPS_PROXY === "1",
    allowHttp: env.BOSSMOX_ALLOW_HTTP === "1",
    consoleIdleMs: Math.max(1, Number(env.BOSSMOX_CONSOLE_IDLE_MINUTES) || 30) * 60 * 1000,
    trustedProxies: new Set((env.BOSSMOX_TRUSTED_PROXY ?? "").split(",").map(plainAddress).filter(Boolean)),
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
