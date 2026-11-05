import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, Sessions, type LoginOutcome, type Session } from "./auth.js";
import { loadConfig } from "./config.js";
import { buildOverview, type Guest, type Overview, type RawConfig, type RawResource, type RawSnapshot } from "./model.js";
import { PveClient, PveError } from "./pve.js";
import {
  buildServerDetail,
  type RawRepositories,
  type RawService,
  type RawStatus,
  type RawSubscription,
  type RawTask,
  type RawUpdate,
  type Section,
  type ServerDetail,
} from "./server-detail.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const CACHE_MS = 4000;
const COOKIE = "bossmox_session";
const MAX_BODY = 8 * 1024;

const config = loadConfig();
const pve = new PveClient(config);
const sessions = new Sessions(pve);
const secureCookie = Boolean(config.tls) || config.behindProxy;
const cache = new WeakMap<Session, { at: number; value: Promise<Overview> }>();

async function fetchGuest(r: RawResource, ticket: string): Promise<[number, Guest]> {
  const base = `/nodes/${encodeURIComponent(r.node ?? "")}/${r.type}/${r.vmid}`;
  const [cfg, snaps] = await Promise.allSettled([
    pve.get<RawConfig>(`${base}/config`, ticket),
    pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket),
  ]);
  const guest: Guest = {};
  if (cfg.status === "fulfilled") guest.config = cfg.value;
  if (snaps.status === "fulfilled") guest.snapshots = snaps.value;
  return [r.vmid ?? 0, guest];
}

async function loadOverview(ticket: string): Promise<Overview> {
  const resources = await pve.get<RawResource[]>("/cluster/resources", ticket);
  const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && r.status !== "unknown");
  const [details, notBackedUp] = await Promise.all([
    Promise.all(guests.map((g) => fetchGuest(g, ticket))),
    // Limited accounts can't read this report, and that shouldn't blank the whole screen.
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up", ticket).catch(() => []),
  ]);
  return buildOverview(resources, new Map(details), notBackedUp);
}

function overview(session: Session): Promise<Overview> {
  const hit = cache.get(session);
  if (hit && Date.now() - hit.at <= CACHE_MS) return hit.value;
  const value = loadOverview(session.ticket);
  cache.set(session, { at: Date.now(), value });
  value.catch(() => cache.delete(session));
  return value;
}

async function section<T>(load: Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, value: await load };
  } catch (err) {
    if (err instanceof PveError && err.status === 401) throw err;
    return { available: false };
  }
}

async function loadServerDetail(name: string, ticket: string): Promise<ServerDetail> {
  const base = `/nodes/${encodeURIComponent(name)}`;
  const [status, updates, repos, subscription, services, tasks, clusterStatus] = await Promise.all([
    section(pve.get<RawStatus>(`${base}/status`, ticket)),
    section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
    section(pve.get<RawRepositories>(`${base}/apt/repositories`, ticket)),
    section(pve.get<RawSubscription>(`${base}/subscription`, ticket)),
    section(pve.get<RawService[]>(`${base}/services`, ticket)),
    section(pve.get<RawTask[]>(`${base}/tasks?limit=25`, ticket)),
    section(pve.get<{ type?: string }[]>("/cluster/status", ticket)),
  ]);
  return buildServerDetail(name, status, updates, repos, subscription, services, tasks, clusterStatus);
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown, extra?: Record<string, string>) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

const stripPort = (host: string) => host.replace(/:\d+$/, "").toLowerCase();
const hostAllowed = (header = "") => config.allowedHosts.has(stripPort(header));

/** Only this app's own pages can post here: browsers won't add this header across sites without permission. */
function sameSite(req: http.IncomingMessage): boolean {
  if (req.headers["x-bossmox"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return hostAllowed(new URL(origin).host);
  } catch {
    return false;
  }
}

function cookieId(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v;
  }
  return undefined;
}
function setCookie(id: string, maxAge: number): Record<string, string> {
  return { "Set-Cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}` };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AuthError(413, "That request was too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new AuthError(400, "That request couldn't be read."));
      }
    });
  });
}
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : "");

function finishLogin(res: http.ServerResponse, out: LoginOutcome) {
  if (out.kind === "code") return json(res, 200, { needsCode: true, challenge: out.id });
  return json(res, 200, { username: out.username }, setCookie(out.id, 12 * 60 * 60));
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
  if (!sameSite(req)) return json(res, 403, { error: "This request didn't come from BossMox." });
  const address = req.socket.remoteAddress ?? "unknown";
  if (route === "/api/login") {
    const body = await readJson(req);
    const user = text(body.username, 128);
    const realm = text(body.realm, 64);
    const password = text(body.password, 512);
    if (!user || !realm || !password) return json(res, 400, { error: "Enter your username and password." });
    if (!/^[\w.@+-]+$/.test(user) || !/^[\w.-]+$/.test(realm)) return json(res, 401, { error: "Wrong username or password." });
    return finishLogin(res, await sessions.login(`${user}@${realm}`, password, address));
  }
  if (route === "/api/login/code") {
    const body = await readJson(req);
    const code = text(body.code, 32).replace(/\s/g, "");
    const challenge = text(body.challenge, 128);
    if (!/^\d{6,8}$/.test(code) || !challenge) return json(res, 400, { error: "Enter the code from your authenticator app." });
    return finishLogin(res, await sessions.submitCode(challenge, code, address));
  }
  if (route === "/api/logout") {
    sessions.end(cookieId(req));
    return json(res, 200, { ok: true }, setCookie("", 0));
  }
  return json(res, 405, { error: "BossMox is read-only for now." });
}

const handler: http.RequestListener = async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) {
      return json(res, 403, { error: "This host name isn't allowed. Add it to BOSSMOX_ALLOWED_HOSTS." });
    }
    const route = new URL(req.url ?? "/", "http://local").pathname;
    if (req.method === "POST") return await handlePost(req, res, route);
    if (req.method !== "GET") return json(res, 405, { error: "BossMox is read-only for now." });
    if (route === "/healthz") return json(res, 200, { ok: true });
    if (route === "/api/login-info") {
      return json(res, 200, { realms: await pve.get<{ realm: string; comment?: string; default?: number }[]>("/access/domains") });
    }
    if (route === "/api/overview" || route === "/api/server") {
      const id = cookieId(req);
      const session = await sessions.get(id);
      if (!session) return json(res, 401, { error: "Sign in to continue." });
      try {
        if (route === "/api/server") {
          const name = new URL(req.url ?? "/", "http://local").searchParams.get("name") ?? "";
          if (!/^[\w.-]{1,64}$/.test(name)) return json(res, 400, { error: "That server name isn't valid." });
          const detail = await loadServerDetail(name, session.ticket);
          const known = detail.summary || detail.updates || detail.services || detail.tasks;
          return known ? json(res, 200, detail) : json(res, 404, { error: "BossMox can't find that server, or your account can't see it." });
        }
        return json(res, 200, { ...(await overview(session)), username: session.username });
      } catch (err) {
        if (err instanceof PveError && err.status === 401) {
          sessions.end(id);
          return json(res, 401, { error: "Sign in to continue." });
        }
        throw err;
      }
    }
    const file = STATIC[route];
    if (!file) return json(res, 404, { error: "Not found." });
    return send(res, 200, file[1], await readFile(path.join(PUBLIC, file[0])));
  } catch (err) {
    if (err instanceof AuthError) return json(res, err.status, { error: err.message });
    const message = err instanceof Error ? err.message : "BossMox hit an internal error.";
    console.error("Request failed:", message);
    return json(res, 502, { error: message });
  }
};

const server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler);
server.listen(config.port, config.host, () => {
  console.log(`BossMox is running at ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
});
