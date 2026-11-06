import { readFile } from "node:fs/promises";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { sameOrigin } from "./config.js";
import { call, probe } from "./pinned.js";
import { saveSettings, settingsPath } from "./settings.js";
import { Wizard, WizardError } from "./wizard.js";

/**
 * What runs before BossMox knows its cluster. It serves the wizard and nothing else, so nothing that needs a
 * Proxmox login can be reached, and it stops once setup is done so the normal server starts in its place.
 */
const env = process.env;
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const COOKIE = "__Host-bossmox_setup";
const MAX_BODY = 8 * 1024;
const CA_FILE = path.join(path.dirname(settingsPath(env)), "pve-root-ca.pem");
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000",
};
const STATIC: Record<string, [string, string]> = {
  "/": ["setup.html", "text/html; charset=utf-8"],
  "/setup.js": ["setup.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/vendor/figtree.woff2": ["vendor/figtree.woff2", "font/woff2"],
};

const wizard = new Wizard(env.BOSSMOX_SETUP_HASH ?? path.join(path.dirname(settingsPath(env)), "setup.hash"), {
  probe,
  call,
  verifies: (host, port, ca) => new Promise((resolve) => {
    const socket = tls.connect({ host, port, ca, servername: /^[\d.]+$/.test(host) ? undefined : host, timeout: 8000 }, () => {
      socket.destroy();
      resolve(socket.authorized);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => resolve(false));
  }),
  saveCa(pem) {
    writeFileSync(CA_FILE, pem, { mode: 0o644 });
    chmodSync(CA_FILE, 0o644);
    return CA_FILE;
  },
  saveSettings: (values) => saveSettings(env, values),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});

const log = (line: string) => console.log(`setup ${new Date().toISOString()} ${line.replace(/[^\x20-\x7e]/g, "?")}`);

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, value: unknown, extra?: Record<string, string>) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new WizardError(413, "That request was too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new WizardError(400, "That request couldn't be read."));
      }
    });
  });
}
const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
function cookie(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v;
  }
  return undefined;
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
  const origin = req.headers.origin;
  if (req.headers["x-bossmox"] !== "1" || (origin && !sameOrigin(origin, req.headers.host, true))) {
    return json(res, 403, { error: "This request didn't come from BossMox." });
  }
  const body = await readJson(req);
  if (route === "/setup/code") {
    const token = wizard.enterCode(text(body.code, 32));
    log(`code accepted from ${req.socket.remoteAddress}`);
    return json(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=3600` });
  }
  if (!wizard.allowed(cookie(req))) return json(res, 401, { error: "Enter the setup code first." });
  if (route === "/setup/look") return json(res, 200, await wizard.look(text(body.address, 280)));
  if (route === "/setup/signin") {
    const out = await wizard.signIn(text(body.address, 280), text(body.fingerprint, 95), text(body.user, 64), text(body.realm, 32), text(body.password, 512));
    log(`signed in as ${out.user}`);
    return json(res, 200, out);
  }
  if (route === "/setup/create") {
    const out = await wizard.createCluster(text(body.name, 15));
    log(`cluster ${out.clusterName} created`);
    return json(res, 200, out);
  }
  if (route === "/setup/add") {
    const out = await wizard.addNode(text(body.address, 280), text(body.fingerprint, 95), text(body.password, 512));
    log(`cluster now has ${out.nodes.length} nodes`);
    return json(res, 200, out);
  }
  if (route === "/setup/finish") {
    await wizard.finish((req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase());
    log("finished, restarting as normal BossMox");
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 400);
    return;
  }
  return json(res, 404, { error: "Not found." });
}

const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const route = new URL(req.url ?? "/", "http://local").pathname;
  try {
    if (route === "/healthz") return json(res, 200, { ok: true, setup: true });
    if (req.method === "POST" && !wizard.finished) return await handlePost(req, res, route);
    if (req.method !== "GET") return json(res, 405, { error: "Not allowed." });
    const file = STATIC[route];
    if (!file) return json(res, 404, { error: "Finish setup first." });
    return send(res, 200, file[1], await readFile(path.join(PUBLIC, file[0])));
  } catch (err) {
    if (err instanceof WizardError) return json(res, err.status, { error: err.message });
    console.error("Setup step failed:", err instanceof Error ? err.message : err);
    return json(res, 502, { error: "That step failed. Check the address and try again." });
  }
};

const cert = env.TLS_CERT_FILE;
const key = env.TLS_KEY_FILE;
if (!cert || !key) throw new Error("Setup needs TLS_CERT_FILE and TLS_KEY_FILE, because a password passes through it.");
const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, handler);
const port = Number(env.PORT ?? 443);
server.listen(port, env.HOST ?? "0.0.0.0", () => console.log(`BossMox is waiting for setup on port ${port}. The setup code is on this machine's console.`));
