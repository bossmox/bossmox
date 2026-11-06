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

test("reads still fail over after a reset", async () => {
  const [first, second] = await Promise.all([fake(reset), fake(good)]);
  assert.equal(await client(first.url, second.url).get("/cluster/status"), "UPID:ok");
  first.close();
  second.close();
});
