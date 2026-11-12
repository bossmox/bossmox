import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import { readConf } from "../src/corosync.js";
import { createHeartbeat, type HeartbeatDeps } from "../src/heartbeat.js";
import type { PveClient } from "../src/pve.js";

const lab = readFileSync(new URL("../../test/corosync-pve8-one-link.conf", import.meta.url), "utf8");
const root = { username: "root@pam", ticket: "T" } as Session;
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** The bmx8 lab: three nodes, heartbeat on vmbr0 over eth0, 10.0.31.0/24 on ens19. The console works on `file`. */
function fake(opts: { linkWorks?: boolean; unreachable?: string; changeBeforeWrite?: boolean } = {}) {
  const st = { file: lab, writes: 0, audits: [] as string[] };
  let clock = 0;
  const nodes = [1, 2, 3].map((n) => ({ name: `bmx8-node${n}`, nodeid: n, hb: `10.0.30.${243 + n}`, b: `10.0.31.${243 + n}` }));
  const pve = {
    get: async (path: string) => {
      if (path === "/cluster/status") return [{ type: "cluster", name: "bmx8lab", quorate: 1 }, ...nodes.map((n) => ({ type: "node", name: n.name, online: 1 }))];
      if (path === "/cluster/config/nodes") return nodes.map((n) => ({ node: n.name, nodeid: n.nodeid, ring0_addr: n.hb }));
      if (path === "/cluster/options") return {};
      const m = /^\/nodes\/(bmx8-node\d)\/network$/.exec(path);
      if (m) {
        const n = nodes.find((x) => x.name === m[1])!;
        return [{ iface: "eth0", type: "eth" }, { iface: "ens19", type: "eth", cidr: `${n.b}/24` }, { iface: "vmbr0", type: "bridge", bridge_ports: "eth0", cidr: `${n.hb}/24` }];
      }
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as PveClient;
  const cons: HeartbeatDeps["console"] = async (node, _s, line) => {
    if (line.includes("__BMX_B64__")) return { exitCode: 0, output: `${line}\n\n__BMX_B64__\n${Buffer.from(st.file).toString("base64")}\n__BMX_END__\n` };
    if (line.includes("__BMX_PING__")) return { exitCode: 0, output: `\n__BMX_PING__\n${opts.unreachable && !node.endsWith(opts.unreachable.slice(-1)) ? ` ${opts.unreachable}` : ""}\n__BMX_END__\n` };
    if (line.includes("sha256sum")) {
      if (opts.changeBeforeWrite && st.writes === 0) st.file = st.file.replace("debug: off", "debug: on");
      const want = /= "([0-9a-f]{64})" \] \|\| exit 3/.exec(line)![1];
      if (sha(st.file) !== want) return { exitCode: 3, output: "" };
      st.file = Buffer.from(/echo (\S+) \| base64 -d/.exec(line)![1]!, "base64").toString("utf8");
      st.writes++;
      return { exitCode: 0, output: "" };
    }
    if (line.includes("__BMX_CFG__")) {
      const me = Number(node.slice(-1));
      const links = Object.keys(readConf(st.file).nodes[0]!.rings).map(Number);
      const block = (l: number) => `LINK ID ${l} udp\n\tstatus:\n${[1, 2, 3].map((id) => `\t\tnodeid: ${id}:\t${id === me ? "localhost" : l === 0 || opts.linkWorks !== false ? "connected" : "disconnected"}`).join("\n")}`;
      return { exitCode: 0, output: `\n__BMX_CFG__\nLocal node ID ${me}, transport knet\n${links.map(block).join("\n")}\n__BMX_END__\n` };
    }
    throw new Error(`unexpected console line ${line}`);
  };
  const hb = createHeartbeat({ pve, console: cons, audit: (e) => st.audits.push(e), wait: async (ms) => { clock += ms; }, now: () => clock });
  const done = async () => {
    for (let i = 0; i < 200 && hb.job()?.running; i++) await new Promise((r) => setImmediate(r));
    return hb.job()!;
  };
  return { st, hb, done };
}

test("the lab gets link 1 on 10.0.31.0/24, written once, up on every node (ADR 0035)", async () => {
  const { st, hb, done } = fake();
  const v = await hb.view(root);
  assert.equal(v.state, "offer");
  await hb.start(root, "10.0.31.0/24", "bmx8lab");
  const j = await done();
  assert.equal(j.result, "added", j.error ?? "");
  assert.equal(st.writes, 1);
  assert.deepEqual(readConf(st.file).nodes.map((n) => n.rings[1]), ["10.0.31.244", "10.0.31.245", "10.0.31.246"]);
  assert.ok(j.steps.every((s) => s.state === "ok"));
  assert.deepEqual(st.audits, ["heartbeat-link-start", "heartbeat-link-written", "heartbeat-link-end"]);
});

test("a link that never connects is taken out: the old file goes back with a higher version", async () => {
  const { st, hb, done } = fake({ linkWorks: false });
  await hb.start(root, "10.0.31.0/24", "bmx8lab");
  const j = await done();
  assert.equal(j.result, "restored", j.error ?? "");
  assert.equal(st.writes, 2);
  const c = readConf(st.file);
  assert.equal(c.version, 5, "past the new file's 4, so corosync loads it");
  assert.equal(st.file.replace("config_version: 5", "config_version: 3"), lab, "otherwise exactly the old file");
  assert.ok(st.audits.includes("heartbeat-link-restored"));
});

test("a node that can't reach another on the new network stops it before anything changes", async () => {
  const { st, hb, done } = fake({ unreachable: "10.0.31.246" });
  await hb.start(root, "10.0.31.0/24", "bmx8lab");
  const j = await done();
  assert.equal(j.result, "failed");
  assert.match(j.error ?? "", /can't reach 10\.0\.31\.246/);
  assert.equal(st.writes, 0);
  assert.equal(st.file, lab);
});

test("a file changed between reading and writing isn't overwritten", async () => {
  const { st, hb, done } = fake({ changeBeforeWrite: true });
  await hb.start(root, "10.0.31.0/24", "bmx8lab");
  const j = await done();
  assert.equal(j.result, "failed");
  assert.match(j.error ?? "", /changed while BossMox was working/);
  assert.equal(st.writes, 0);
});

test("refused: not root@pam, the wrong name, another network, or one already running", async () => {
  const { hb, done } = fake();
  await assert.rejects(hb.start({ ...root, username: "admin@pve" } as Session, "10.0.31.0/24", "bmx8lab"), (e: { status: number }) => e.status === 403);
  await assert.rejects(hb.start(root, "10.0.31.0/24", "bmx8"), (e: { status: number }) => e.status === 400);
  await assert.rejects(hb.start(root, "10.0.99.0/24", "bmx8lab"), (e: { status: number }) => e.status === 400);
  await hb.start(root, "10.0.31.0/24", "bmx8lab");
  await assert.rejects(hb.start(root, "10.0.31.0/24", "bmx8lab"), (e: { status: number }) => e.status === 409);
  await done();
});
