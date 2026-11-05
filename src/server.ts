import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildOverview, type Guest, type Overview, type RawConfig, type RawResource, type RawSnapshot } from "./model.js";
import { PveClient } from "./pve.js";

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

const config = loadConfig();
const pve = new PveClient(config);
let cached: { at: number; value: Promise<Overview> } | undefined;

async function fetchGuest(r: RawResource): Promise<[number, Guest]> {
  const base = `/nodes/${encodeURIComponent(r.node ?? "")}/${r.type}/${r.vmid}`;
  const [cfg, snaps] = await Promise.allSettled([
    pve.get<RawConfig>(`${base}/config`),
    pve.get<RawSnapshot[]>(`${base}/snapshot`),
  ]);
  const guest: Guest = {};
  if (cfg.status === "fulfilled") guest.config = cfg.value;
  if (snaps.status === "fulfilled") guest.snapshots = snaps.value;
  return [r.vmid ?? 0, guest];
}

async function loadOverview(): Promise<Overview> {
  const resources = await pve.get<RawResource[]>("/cluster/resources");
  const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && r.status !== "unknown");
  const [details, notBackedUp] = await Promise.all([
    Promise.all(guests.map(fetchGuest)),
    pve.get<{ vmid: number }[]>("/cluster/backup-info/not-backed-up"),
  ]);
  return buildOverview(resources, new Map(details), notBackedUp);
}

function overview(): Promise<Overview> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const value = loadOverview();
    cached = { at: Date.now(), value };
    value.catch(() => {
      cached = undefined;
    });
  }
  return cached.value;
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

function hostAllowed(header = ""): boolean {
  return config.allowedHosts.has(header.replace(/:\d+$/, "").toLowerCase());
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) {
      return json(res, 403, { error: "This host name isn't allowed. Add it to BOSSMOX_ALLOWED_HOSTS." });
    }
    if (req.method !== "GET") return json(res, 405, { error: "BossMox is read-only for now." });
    const route = new URL(req.url ?? "/", "http://local").pathname;
    if (route === "/healthz") return json(res, 200, { ok: true });
    if (route === "/api/overview") {
      try {
        return json(res, 200, await overview());
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't reach Proxmox.";
        console.error("Proxmox request failed:", message);
        return json(res, 502, { error: message });
      }
    }
    const file = STATIC[route];
    if (!file) return json(res, 404, { error: "Not found." });
    return send(res, 200, file[1], await readFile(path.join(PUBLIC, file[0])));
  } catch {
    return json(res, 500, { error: "BossMox hit an internal error." });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`BossMox is running at http://${config.host}:${config.port}`);
});
