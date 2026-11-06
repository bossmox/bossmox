import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAddress, PinError, PveReply, type Pinned } from "../src/pinned.js";
import { applySettings, saveSettings, type Saved } from "../src/settings.js";
import { Wizard, WizardError, type Outside } from "../src/wizard.js";

const FP = (n: number) => Array(32).fill(n.toString(16).padStart(2, "0").toUpperCase()).join(":");
const CODE = "ABCD-1234-EF56";

/** A pretend set of Proxmox nodes. */
function lab(over: Partial<Outside> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bmx-"));
  const hash = path.join(dir, "setup.hash");
  writeFileSync(hash, createHash("sha256").update("ABCD1234EF56").digest("hex"));
  let clock = 1000;
  let clusterName = "";
  const members: { name: string; ip: string }[] = [{ name: "n1", ip: "10.0.0.1" }];
  const guests: Record<string, number> = { n2: 0, n3: 0 };
  const calls: string[] = [];
  const saved: Saved[] = [];
  const name = (to: Pinned) => ({ "10.0.0.1": "n1", "10.0.0.2": "n2", "10.0.0.3": "n3" })[to.host] ?? "?";
  const out: Outside = {
    probe: async (host) => ({ fingerprint: FP(Number(host.split(".").pop())), subject: "x" }),
    async call<T>(to: Pinned, method: string, p: string, opts: { form?: Record<string, string> } = {}): Promise<T> {
      calls.push(`${name(to)} ${method} ${p}`);
      const reply = (v: unknown) => v as T;
      if (p === "/access/ticket") {
        if (opts.form?.password !== "right") throw new PveReply(401, "no");
        return reply({ username: opts.form.username, ticket: `t-${name(to)}`, CSRFPreventionToken: "c" });
      }
      if (p === "/nodes") return reply([{ node: name(to) }]);
      if (p === "/cluster/status") {
        if (name(to) !== "n1") return reply([{ type: "node", name: name(to), ip: to.host, online: 1 }]);
        return reply([...(clusterName ? [{ type: "cluster", name: clusterName }] : []), ...members.map((m) => ({ type: "node", name: m.name, ip: m.ip, online: 1 }))]);
      }
      if (p === "/cluster/config" && method === "POST") {
        clusterName = opts.form?.clustername ?? "";
        return reply("UPID:1");
      }
      if (p.includes("/tasks/")) return reply({ status: "stopped", exitstatus: "OK" });
      if (p.endsWith("/qemu")) return reply(Array(guests[name(to)] ?? 0).fill({}));
      if (p.endsWith("/lxc")) return reply([]);
      if (p === "/cluster/config/join") {
        members.push({ name: name(to), ip: to.host });
        return reply("UPID:2");
      }
      if (p.endsWith("/certificates/info")) return reply([{ filename: "pve-root-ca.pem", pem: "CA" }]);
      throw new Error(`unexpected ${p}`);
    },
    verifies: async () => true,
    saveCa: () => "/x/ca.pem",
    saveSettings: (v) => saved.push(v),
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  };
  return { wizard: new Wizard(hash, out), calls, saved, guests, hash, tick: (ms: number) => { clock += ms; }, setCluster: (n: string) => { clusterName = n; } };
}
const signedIn = async (l: ReturnType<typeof lab>) => {
  l.wizard.enterCode(CODE);
  return l.wizard.signIn("10.0.0.1:8006", FP(1), "root", "pam", "right");
};
const status = (code: number) => (e: WizardError) => e instanceof WizardError && e.status === code;

test("the code matches however it's typed, and only the right code", () => {
  const { wizard } = lab();
  assert.throws(() => wizard.enterCode("WRONG-CODE"), status(401));
  assert.ok(wizard.enterCode("abcd 1234 ef56"));
});

test("wrong codes get limited, even if the right one follows", () => {
  const { wizard, tick } = lab();
  for (let i = 0; i < 10; i++) assert.throws(() => wizard.enterCode("NOPE"), status(401));
  assert.throws(() => wizard.enterCode(CODE), status(429));
  tick(5 * 60 * 1000 + 1);
  assert.ok(wizard.enterCode(CODE));
});

test("nothing works without the token, and it expires", () => {
  const { wizard, tick } = lab();
  assert.equal(wizard.allowed(undefined), false);
  assert.equal(wizard.allowed("guess"), false);
  const token = wizard.enterCode(CODE);
  assert.equal(wizard.allowed(token), true);
  tick(61 * 60 * 1000);
  assert.equal(wizard.allowed(token), false);
});

test("a wrong password is plain, and a standalone node reads as standalone", async () => {
  const l = lab();
  l.wizard.enterCode(CODE);
  await assert.rejects(l.wizard.signIn("10.0.0.1", FP(1), "root", "pam", "bad"), /Wrong username/);
  const s = await l.wizard.signIn("10.0.0.1", FP(1), "root", "pam", "right");
  assert.equal(s.clusterName, "");
  assert.equal(s.nodes.length, 1);
  assert.equal(s.canBuild, true);
});

test("a changed certificate stops sign-in", async () => {
  const l = lab();
  const real = l.wizard;
  const blocked = new Wizard(l.hash, { probe: async () => ({ fingerprint: FP(1), subject: "" }), call: async () => { throw new PinError("That server's certificate has changed since you confirmed it."); }, verifies: async () => true, saveCa: () => "", saveSettings: () => {}, wait: async () => {}, now: () => 1 });
  assert.ok(real);
  await assert.rejects(blocked.signIn("10.0.0.1", FP(1), "root", "pam", "right"), /has changed/);
});

test("three standalone nodes become one cluster, and settings come out right", async () => {
  const l = lab();
  await signedIn(l);
  const made = await l.wizard.createCluster("lab-1");
  assert.equal(made.clusterName, "lab-1");
  await l.wizard.addNode("10.0.0.2", FP(2), "right");
  const three = await l.wizard.addNode("10.0.0.3", FP(3), "right");
  assert.deepEqual(three.nodes.map((n) => n.name), ["n1", "n2", "n3"]);
  await l.wizard.finish("10.0.0.9");
  assert.deepEqual(l.saved[0], { PVE_URL: "https://10.0.0.1:8006,https://10.0.0.2:8006,https://10.0.0.3:8006", PVE_CA_FILE: "/x/ca.pem", BOSSMOX_ALLOWED_HOSTS: "10.0.0.9" });
  assert.equal(existsSync(l.hash), false, "the code can't be used again");
  assert.equal(JSON.stringify(l.saved).includes("right"), false, "no password in the settings");
});

test("an existing cluster goes straight through, and nothing tries to rebuild it", async () => {
  const l = lab();
  l.setCluster("already");
  const s = await signedIn(l);
  assert.equal(s.clusterName, "already");
  await assert.rejects(l.wizard.createCluster("other"), /already in the cluster/);
});

test("a node with guests can't join, and nothing is sent to it", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab");
  l.guests.n2 = 2;
  await assert.rejects(l.wizard.addNode("10.0.0.2", FP(2), "right"), /has 2 guests/);
  assert.equal(l.calls.some((c) => c.includes("/cluster/config/join")), false);
});

test("a wrong root password for a joining node is plain", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab");
  await assert.rejects(l.wizard.addNode("10.0.0.2", FP(2), "bad"), /Wrong username/);
});

test("only root can build a cluster, and bad names are refused", async () => {
  const l = lab();
  l.wizard.enterCode(CODE);
  await l.wizard.signIn("10.0.0.1", FP(1), "admin", "pve", "right");
  await assert.rejects(l.wizard.createCluster("lab"), status(403));
  const r = lab();
  await signedIn(r);
  await assert.rejects(r.wizard.createCluster("bad name"), status(400));
  await assert.rejects(r.wizard.createCluster("much-too-long-a-name"), status(400));
});

test("a node can't be added to itself", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab");
  await assert.rejects(l.wizard.addNode("10.0.0.1", FP(1), "right"), /already connected/);
});

test("setup won't finish if a node's certificate doesn't verify", async () => {
  const l = lab({ verifies: async () => false });
  await signedIn(l);
  await assert.rejects(l.wizard.finish("10.0.0.9"), /couldn't verify/);
  assert.equal(l.saved.length, 0);
  assert.equal(existsSync(l.hash), true, "and the code still works to try again");
});

test("setup waits for a node that only just joined", async () => {
  let tries = 0;
  const l = lab({ verifies: async () => { tries += 1; return tries > 4; } });
  await signedIn(l);
  await l.wizard.finish("10.0.0.9");
  assert.equal(l.saved.length, 1);
});

test("addresses are read forgivingly and strictly", () => {
  assert.deepEqual(parseAddress("10.0.0.5"), { host: "10.0.0.5", port: 8006 });
  assert.deepEqual(parseAddress(" https://PVE1.lan:8007/ "), { host: "pve1.lan", port: 8007 });
  assert.equal(parseAddress("10.0.0.5/etc"), null);
  assert.equal(parseAddress("a b"), null);
  assert.equal(parseAddress("x:99999"), null);
});

test("saved settings fill gaps, the environment wins, and unknown keys are ignored", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bmx-"));
  const file = path.join(dir, "settings.json");
  assert.equal(applySettings({ BOSSMOX_SETTINGS: file }), true, "nothing saved means setup");
  assert.equal(applySettings({ BOSSMOX_SETTINGS: file, PVE_URL: "https://a" }), false);
  saveSettings({ BOSSMOX_SETTINGS: file }, { PVE_URL: "https://saved", BOSSMOX_ALLOWED_HOSTS: "x" });
  assert.match(readFileSync(file, "utf8"), /saved/);
  const env: NodeJS.ProcessEnv = { BOSSMOX_SETTINGS: file, BOSSMOX_ALLOWED_HOSTS: "from-env" };
  assert.equal(applySettings(env), false);
  assert.equal(env.PVE_URL, "https://saved");
  assert.equal(env.BOSSMOX_ALLOWED_HOSTS, "from-env");
  writeFileSync(file, JSON.stringify({ PVE_URL: "https://a", NODE_OPTIONS: "--evil" }));
  const other: NodeJS.ProcessEnv = { BOSSMOX_SETTINGS: file };
  applySettings(other);
  assert.equal(other.NODE_OPTIONS, undefined);
});
