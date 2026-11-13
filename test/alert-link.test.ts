import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAlertLink, inboundUrl, plainAddress, trustLine } from "../src/alert-link.js";
import type { Session } from "../src/auth.js";
import { targetForm } from "../src/alerts.js";
import type { PveClient } from "../src/pve.js";

const root = { username: "root@pam", ticket: "t" } as Session;
const dir = () => mkdtempSync(path.join(process.env.BOSSMOX_TEST_TMP ?? tmpdir(), "bmx-link-"));

/** Certificate-shaped text: only its trip through the typed line matters here. The tests below make a real CA. */
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBfDCCASOgAwIBAgIUYk3cD4pV0q6eYRXu1n2uS0pE9lcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJQm9zc01veCBDQTAeFw0yNjExMTMwMDAwMDBaFw00NjExMTMw
MDAwMDBaMBQxEjAQBgNVBAMMCUJvc3NNb3ggQ0EwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQ3Kc6Zg7mJ8b4wQe7N2Q2kq4H8m0g7nWcTt4Vn1oM9tT6w8iH6yT3P
P0u0b6W3pVqk8sVdQ4m5qkzJ8f6S5U8Ko1MwUTAdBgNVHQ4EFgQUAAAAAAAAAAAA
AAAAAAAAAAAAAAAwHwYDVR0jBBgwFoAUAAAAAAAAAAAAAAAAAAAAAAAAAAAwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAy5P3xP2fWvUqk2u0wB6tK
p9Wmz9H0n5i0q6kGxZ0h0QIgN0d7xR2kq4cG2P5gYx1L0sY4lK1y7f9m0kJw6vZ4
mQ8=
-----END CERTIFICATE-----
`;

test("Proxmox posts to BossMox's first certified name, with the port only when it isn't 443", () => {
  assert.equal(inboundUrl(["10.0.30.247", "bossmox.lan"], 443), "https://10.0.30.247/api/alerts/inbound");
  assert.equal(inboundUrl(["bossmox.lan"], 8443), "https://bossmox.lan:8443/api/alerts/inbound");
  assert.equal(inboundUrl(["fd00::5"], 443), "https://[fd00::5]/api/alerts/inbound");
  assert.equal(inboundUrl([], 443), null);
});

test("the line typed on a node writes only BossMox's CA file and rebuilds the list", () => {
  const line = trustLine(CA_PEM);
  assert.ok(line.includes("/usr/local/share/ca-certificates/bossmox-ca.crt"));
  assert.ok(line.endsWith("update-ca-certificates --fresh >/dev/null"));
  assert.ok(!line.includes("BEGIN CERTIFICATE"), "the certificate travels as base64, so nothing in it is read by the shell");
  const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(line)?.[1] ?? "";
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), CA_PEM);
});

test("an IPv4 address seen through IPv6 is compared plainly", () => {
  assert.equal(plainAddress("::ffff:10.0.30.244"), "10.0.30.244");
  assert.equal(plainAddress("10.0.30.244"), "10.0.30.244");
});

/** A working CA file is needed for the fingerprint; this makes one with OpenSSL when it's there, else skips. */
function realCa(d: string): string | null {
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=BossMox CA",
        "-keyout",
        path.join(d, "ca.key"),
        "-out",
        path.join(d, "ca.crt"),
      ],
      { stdio: "ignore" },
    );
    return path.join(d, "ca.crt");
  } catch {
    return null;
  }
}

function setup(opts: { status?: { type?: string; name?: string; ip?: string; online?: number }[]; exit?: number } = {}) {
  const d = dir();
  const caFile = realCa(d);
  writeFileSync(path.join(d, "cert-names"), "10.0.30.247,bossmox.lan");
  const typed: { node: string; line: string }[] = [];
  const sent: { subject: string; text: string }[] = [];
  const pve = {
    get: async () =>
      opts.status ?? [
        { type: "cluster", name: "lab" },
        { type: "node", name: "n1", ip: "10.0.30.244", online: 1 },
        { type: "node", name: "n2", ip: "10.0.30.245", online: 1 },
      ],
  } as unknown as PveClient;
  const link = createAlertLink({
    file: path.join(d, "alert-link.json"),
    caFile: caFile ?? path.join(d, "none"),
    namesFile: path.join(d, "cert-names"),
    port: 443,
    pve,
    console: async (node, _s, line) => {
      typed.push({ node, line });
      return { exitCode: opts.exit ?? 0, tail: "", output: "", keptConfig: [] };
    },
    email: { send: async (subject, text) => void sent.push({ subject, text }) },
    audit: () => {},
  });
  return { link, typed, sent, file: path.join(d, "alert-link.json"), hasCa: !!caFile };
}

test("connecting gives every node the CA, then keeps only the key's hash", async (t) => {
  const s = setup();
  if (!s.hasCa) return t.skip("no openssl here");
  const { url, key } = await s.link.connect(root);
  assert.equal(url, "https://10.0.30.247/api/alerts/inbound");
  assert.deepEqual(
    s.typed.map((x) => x.node),
    ["n1", "n2"],
  );
  const saved = readFileSync(s.file, "utf8");
  assert.ok(!saved.includes(key), "the key itself isn't kept");
  assert.deepEqual(s.link.missing(["n1", "n2", "n3"]), ["n3"], "a node added later is named");
});

test("only root@pam can connect, every node must be online, and a node that refuses stops it", async (t) => {
  const s = setup();
  if (!s.hasCa) return t.skip("no openssl here");
  await assert.rejects(s.link.connect({ username: "admin@pve", ticket: "t" } as Session), /root@pam/);
  await assert.rejects(setup({ status: [{ type: "node", name: "n1", ip: "10.0.30.244", online: 0 }] }).link.connect(root), /online first.*n1/);
  const refusing = setup({ exit: 1 });
  await assert.rejects(refusing.link.connect(root), /n1 didn't take/);
  assert.equal(refusing.typed.length, 1, "nothing is typed on the nodes after the one that refused");
});

test("an alert needs the key and has to come from a node; then it goes out by email", async (t) => {
  const s = setup();
  if (!s.hasCa) return t.skip("no openssl here");
  const { key } = await s.link.connect(root);
  const body = { title: "Backup failed", message: "vzdump 101 failed", severity: "error" };
  assert.equal((await s.link.receive(undefined, "10.0.30.244", body)).status, 401);
  assert.equal((await s.link.receive(`Bearer ${"0".repeat(64)}`, "10.0.30.244", body)).status, 401);
  assert.equal((await s.link.receive(`Bearer ${key}`, "10.0.30.99", body)).status, 403, "the right key from elsewhere");
  assert.equal(s.sent.length, 0);
  assert.equal((await s.link.receive(`Bearer ${key}`, "::ffff:10.0.30.245", body)).status, 200);
  assert.equal(s.sent[0]?.subject, "BossMox: Backup failed");
  assert.match(s.sent[0]?.text ?? "", /vzdump 101 failed[\s\S]*Severity: error/);
});

test("a flood of alerts is cut off after 60 in an hour", async (t) => {
  const s = setup();
  if (!s.hasCa) return t.skip("no openssl here");
  const { key } = await s.link.connect(root);
  for (let i = 0; i < 60; i++) assert.equal((await s.link.receive(`Bearer ${key}`, "10.0.30.244", {})).status, 200);
  assert.equal((await s.link.receive(`Bearer ${key}`, "10.0.30.244", {})).status, 429);
  assert.equal(s.sent.length, 60);
});

test("after turning off, the old key no longer works", async (t) => {
  const s = setup();
  if (!s.hasCa) return t.skip("no openssl here");
  const { key } = await s.link.connect(root);
  s.link.forget();
  assert.equal((await s.link.receive(`Bearer ${key}`, "10.0.30.244", {})).status, 404);
});

test("Proxmox's target for email carries the key only as a secret, and posts title, message and severity", () => {
  const key = "a".repeat(64);
  const { type, form } = targetForm({ kind: "email", server: "https://10.0.30.247/api/alerts/inbound", token: key, updates: false, allBackups: false });
  assert.equal(type, "webhook");
  assert.equal(form.url, "https://10.0.30.247/api/alerts/inbound");
  const flat = JSON.stringify(form);
  assert.ok(!flat.includes(key), "the key isn't in the readable config");
  assert.ok(flat.includes(Buffer.from(key).toString("base64")), "it's in the secret");
  assert.match(Buffer.from(String(form.body), "base64").toString(), /"title": \{\{ json title \}\}.*"severity"/);
  assert.throws(() => targetForm({ kind: "email", server: "http://example.com/x", token: key, updates: false, allBackups: false }), /https/);
});
