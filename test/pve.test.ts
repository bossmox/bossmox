import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { PveClient } from "../src/pve.js";

/** A stand-in Proxmox that counts what it receives. */
function fake(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      answer(req, res);
    });
  });
  return new Promise<{ url: URL; seen: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: new URL(`http://127.0.0.1:${port}`), seen, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}
const reset = (req: http.IncomingMessage) => req.socket.destroy();
const good = (_: http.IncomingMessage, res: http.ServerResponse) => res.end(JSON.stringify({ data: "UPID:ok" }));
const who = { ticket: "t", csrf: "c" };
const client = (...urls: URL[]) => new PveClient({ pveUrl: urls[0] as URL, pveUrls: urls, pveCa: undefined, pveTlsName: undefined } as never);

test("a reset after a change reached Proxmox doesn't run it again elsewhere", async () => {
  const [first, second] = await Promise.all([fake(reset), fake(good)]);
  await assert.rejects(client(first.url, second.url).post("/nodes/a/status", who, { command: "reboot" }));
  assert.equal(first.seen.length, 1);
  assert.equal(second.seen.length, 0, "the reboot must not be sent twice");
  first.close();
  second.close();
});

test("a change still fails over when the connection never opened", async () => {
  const [dead, second] = await Promise.all([fake(good), fake(good)]);
  dead.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await client(dead.url, second.url).post("/nodes/a/status", who, { command: "reboot" }), "UPID:ok");
  assert.equal(second.seen.length, 1);
  second.close();
});

test("a change that never connected is marked as never reaching Proxmox", async () => {
  const dead = await fake(good);
  dead.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(client(dead.url).post("/x", who), (e: { unreached?: boolean }) => e.unreached === true);
});

test("a reset after connecting isn't marked that way", async () => {
  const first = await fake(reset);
  await assert.rejects(client(first.url).post("/x", who), (e: { unreached?: boolean }) => e.unreached === false);
  first.close();
});

test("a change never rides on a reused connection", async () => {
  const ports = new Set<number>();
  const first = await fake((req, res) => {
    ports.add(req.socket.remotePort as number);
    good(req, res);
  });
  const c = client(first.url);
  await c.post("/x", who);
  await c.post("/x", who);
  await c.post("/x", who);
  assert.equal(ports.size, 3);
  first.close();
});

test("reads still fail over after a reset", async () => {
  const [first, second] = await Promise.all([fake(reset), fake(good)]);
  assert.equal(await client(first.url, second.url).get("/cluster/status"), "UPID:ok");
  first.close();
  second.close();
});

test("an error from Proxmox never carries the query string, where an SMB scan's password travels", async () => {
  // Pre-public review 2026-11-09: a refused SMB scan's error reached the log with the password in it.
  const refuse = (_: http.IncomingMessage, res: http.ServerResponse) => { res.statusCode = 401; res.end(); };
  const p = await fake(refuse);
  try {
    await assert.rejects(client(p.url).get("/nodes/a/scan/cifs?server=nas&username=bob&password=hunter2", "t"), (err: Error) => {
      assert.doesNotMatch(err.message, /hunter2|username|\?/);
      assert.match(err.message, /\/nodes\/a\/scan\/cifs/);
      return true;
    });
  } finally {
    p.close();
  }
});

test("a slow change is waited for, while a slow read still gives up and says so (#59)", async () => {
  // Proxmox answers after 300 ms. Reads wait 100 ms, changes 2 s: the same gap as 8 s against a minute.
  const slow = await fake((_req, res) => setTimeout(() => res.end(JSON.stringify({ data: "done" })), 300));
  const pve = new PveClient({ pveUrl: slow.url, pveUrls: [slow.url], pveCa: undefined, pveTlsName: undefined } as never, { read: 100, write: 2000 });
  try {
    assert.equal(await pve.put("/nodes/a/qemu/100/config", who, { delete: "unused0" }), "done", "the change is waited for");
    await assert.rejects(pve.get("/cluster/resources", "t"), /took too long/);
  } finally {
    slow.close();
  }
});
