import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAddress, PinError, PveReply, type Pinned } from "../src/pinned.js";
import { applySettings, saveSettings, type Saved } from "../src/settings.js";
import { setupHostAllowed, Wizard, WizardError, type Outside } from "../src/wizard.js";
import type { RawRepositories } from "../src/server-detail.js";

/** Proxmox's real answer from a lab node with a fresh install's sources. */
const FRESH: RawRepositories = JSON.parse(readFileSync(new URL("../../test/apt-fresh-install.json", import.meta.url), "utf8"));
const URIS: Record<string, [string, string, string]> = {
  "no-subscription": ["proxmox.sources", "http://download.proxmox.com/debian/pve", "pve-no-subscription"],
  enterprise: ["pve-enterprise.sources", "https://enterprise.proxmox.com/debian/pve", "pve-enterprise"],
  "ceph-squid-no-subscription": ["ceph.sources", "http://download.proxmox.com/debian/ceph-squid", "no-subscription"],
  "ceph-squid-enterprise": ["ceph.sources", "https://enterprise.proxmox.com/debian/ceph-squid", "enterprise"],
};
/** A node's update sources that change the way Proxmox's do when asked to add or turn off. */
function aptNode() {
  const r: RawRepositories = structuredClone(FRESH);
  return {
    repos: r,
    get: () => structuredClone(r),
    add(handle: string) {
      const [file, uri, comp] = URIS[handle]!;
      const std = r["standard-repos"]!.find((x) => x.handle === handle)!;
      const path = `/etc/apt/sources.list.d/${file}`;
      let f = r.files!.find((x) => x.path === path);
      if (!f) {
        f = { path, repositories: [] };
        r.files!.push(f);
      }
      const there = f.repositories!.find((x) => x.URIs?.[0] === uri);
      if (there) there.Enabled = true;
      else f.repositories!.push({ Enabled: true, URIs: [uri], Components: [comp] });
      std.status = 1;
    },
    off(path: string, index: number) {
      const e = r.files!.find((x) => x.path === path)!.repositories![index]!;
      e.Enabled = false;
      const std = Object.entries(URIS).find(([, [, uri]]) => uri === e.URIs?.[0]);
      if (std) r["standard-repos"]!.find((x) => x.handle === std[0])!.status = 0;
    },
    on: () =>
      r
        .files!.flatMap((f) => (f.repositories ?? []).filter((x) => x.Enabled).map((x) => x.URIs![0]!))
        .filter((u) => /(^|\.)proxmox\.com$/.test(new URL(u).hostname))
        .sort(),
  };
}

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
  const apt: Record<string, ReturnType<typeof aptNode>> = { n1: aptNode(), n2: aptNode(), n3: aptNode() };
  const subscriptions: Record<string, string> = {};
  const offline = new Set<string>();
  // Each node on 10.0.0.x (where it was reached, and its heartbeat) and on a second network, 10.0.100.x.
  const options: { migration?: string } = {};
  const name = (to: Pinned) => ({ "10.0.0.1": "n1", "pve1.lan": "n1", "10.0.0.2": "n2", "10.0.0.3": "n3" })[to.host] ?? "?";
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
        return reply([...(clusterName ? [{ type: "cluster", name: clusterName }] : []), ...members.map((m) => ({ type: "node", name: m.name, ip: m.ip, online: offline.has(m.name) ? 0 : 1 }))]);
      }
      if (p === "/cluster/config" && method === "POST") {
        clusterName = opts.form?.clustername ?? "";
        return reply("UPID:1");
      }
      if (p.includes("/tasks/")) return reply({ status: "stopped", exitstatus: "OK" });
      const nodeApt = /^\/nodes\/([^/]+)\/(apt\/repositories|apt\/update|subscription)$/.exec(p);
      if (nodeApt) {
        const node = nodeApt[1]!;
        const what = nodeApt[2]!;
        const a = apt[node]!;
        if (what === "subscription") return reply({ status: subscriptions[node] ?? "notfound" });
        if (what === "apt/update") return reply(`UPID:apt:${node}`);
        if (method === "GET") return reply(a.get());
        if (opts.form?.digest !== a.repos.digest) throw new PveReply(500, "detected modified configuration");
        if (method === "PUT") a.add(opts.form!.handle!);
        else a.off(opts.form!.path!, Number(opts.form!.index));
        a.repos.digest = `${a.repos.digest}+`;
        return reply(null);
      }
      if (p.endsWith("/qemu")) return reply(Array(guests[name(to)] ?? 0).fill({}));
      if (p.endsWith("/lxc")) return reply([]);
      if (p === "/cluster/config/join") {
        members.push({ name: name(to), ip: to.host });
        return reply("UPID:2");
      }
      if (p === "/cluster/config/nodes") return reply(members.map((m) => ({ node: m.name, ring0_addr: m.ip })));
      if (p === "/cluster/options") {
        if (method === "PUT") options.migration = opts.form?.migration;
        return reply({ ...options });
      }
      const net = /^\/nodes\/([^/]+)\/network$/.exec(p);
      if (net) {
        const ip = members.find((m) => m.name === net[1])?.ip ?? "";
        return reply([{ iface: "vmbr0", cidr: `${ip}/24` }, { iface: "eno1", cidr: `${ip.replace("10.0.0.", "10.0.100.")}/24` }, { iface: "lo" }]);
      }
      if (p.endsWith("/certificates/info")) return reply([{ filename: "pve-root-ca.pem", pem: "CA" }]);
      throw new Error(`unexpected ${p}`);
    },
    verifies: async () => true,
    saveCa: () => "/x/ca.pem",
    saveSettings: (v) => saved.push(v),
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return {
    options,
    wizard: new Wizard(hash, out),
    apt,
    subscriptions,
    offline,
    calls,
    saved,
    guests,
    hash,
    tick: (ms: number) => {
      clock += ms;
    },
    setCluster: (n: string) => {
      clusterName = n;
    },
    setMembers: (m: typeof members) => {
      members.splice(0, members.length, ...m);
    },
  };
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
  const blocked = new Wizard(l.hash, {
    probe: async () => ({ fingerprint: FP(1), subject: "" }),
    call: async () => {
      throw new PinError("That server's certificate has changed since you confirmed it.");
    },
    verifies: async () => true,
    saveCa: () => "",
    saveSettings: () => {},
    wait: async () => {},
    now: () => 1,
  });
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
  assert.deepEqual(
    three.nodes.map((n) => n.name),
    ["n1", "n2", "n3"],
  );
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
  assert.equal(
    l.calls.some((c) => c.includes("/cluster/config/join")),
    false,
  );
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

// Exactly what the first real home node did: moved networks, so /etc/hosts and its certificate still name the old address.
const moved = (over: Partial<Outside> = {}) => {
  const asked: string[] = [];
  const l = lab({
    verifies: async (h, _p, _c, name) => {
      asked.push(`${h} ${name ?? "address"}`);
      return h === "10.0.0.1" && name === "n1";
    },
    ...over,
  });
  l.setMembers([{ name: "n1", ip: "192.168.99.9" }]);
  return { l, asked };
};

test("a node that moved is kept at the address it was reached on, and checked by its name", async () => {
  const { l, asked } = moved();
  const s = await signedIn(l);
  assert.equal(s.nodes[0]?.address, "10.0.0.1", "the wizard shows the address that works");
  await l.wizard.finish("10.0.0.9");
  assert.equal(
    asked.some((a) => a.startsWith("192.168.99.9")),
    false,
    "the stale address is never tried",
  );
  assert.deepEqual(l.saved[0], { PVE_URL: "https://10.0.0.1:8006", PVE_CA_FILE: "/x/ca.pem", PVE_TLS_NAME: "n1", BOSSMOX_ALLOWED_HOSTS: "10.0.0.9" });
});

test("the wizard points out an address it can't use, before a cluster gets built on it", async () => {
  const { l } = moved();
  assert.equal((await signedIn(l)).otherAddress, "192.168.99.9");
  const plain = lab();
  assert.equal((await signedIn(plain)).otherAddress, "");
});

test("a typed name isn't compared with an address", async () => {
  const named = lab();
  named.wizard.enterCode(CODE);
  const s = await named.wizard.signIn("pve1.lan", FP(1), "root", "pam", "right");
  assert.equal(s.nodes[0]?.address, "pve1.lan");
  assert.equal(s.otherAddress, "");
});

test("a certificate that matches neither the address nor the node's name is still refused", async () => {
  const { l } = moved({ verifies: async () => false });
  await signedIn(l);
  await assert.rejects(l.wizard.finish("10.0.0.9"), /couldn't verify 10\.0\.0\.1/);
  assert.equal(l.saved.length, 0);
});

test("a node whose address matches needs no name saved", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.finish("10.0.0.9");
  assert.equal(l.saved[0]?.PVE_TLS_NAME, undefined);
});

test("a cluster doesn't fall back to a name, because one name can't fit every node", async () => {
  const asked: (string | undefined)[] = [];
  const l = lab({
    verifies: async (_h, _p, _c, name) => {
      asked.push(name);
      return false;
    },
  });
  l.setMembers([
    { name: "n1", ip: "10.0.0.1" },
    { name: "n2", ip: "10.0.0.2" },
  ]);
  await signedIn(l);
  await assert.rejects(l.wizard.finish("10.0.0.9"), /couldn't verify 10\.0\.0\.1, 10\.0\.0\.2/);
  assert.equal(asked.some(Boolean), false);
});

test("setup waits for a node that only just joined", async () => {
  let tries = 0;
  const l = lab({
    verifies: async () => {
      tries += 1;
      return tries > 4;
    },
  });
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

const PAID_PVE = "https://enterprise.proxmox.com/debian/pve";
const PAID_CEPH = "https://enterprise.proxmox.com/debian/ceph-squid";
const FREE_PVE = "http://download.proxmox.com/debian/pve";
const FREE_CEPH = "http://download.proxmox.com/debian/ceph-squid";

test("the free channel goes on every node, Proxmox's and Ceph's, and the paid sources go off", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab-1");
  await l.wizard.addNode("10.0.0.2", FP(2), "right");
  const out = await l.wizard.setChannel("free");
  assert.deepEqual(out.channelProblems, []);
  for (const n of ["n1", "n2"]) assert.deepEqual(l.apt[n]!.on(), [FREE_CEPH, FREE_PVE], n);
  // Free went on before paid went off: the first change on each node is an add.
  const n2 = l.calls.filter((c) => c.includes("/nodes/n2/apt/repositories") && !c.includes(" GET "));
  assert.match(n2[0]!, / PUT /);
  assert.deepEqual(l.apt.n3!.on(), [PAID_CEPH, PAID_PVE], "a node outside the cluster isn't touched");
});

test("enterprise without a subscription changes nothing and names the node", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab-1");
  await l.wizard.addNode("10.0.0.2", FP(2), "right");
  l.subscriptions.n1 = "Active";
  await assert.rejects(l.wizard.setChannel("enterprise"), /n2 doesn't have an active subscription/);
  assert.equal(l.calls.filter((c) => / (PUT|POST) \/nodes\/n\d\/apt\/repositories/.test(c)).length, 0);
  l.subscriptions.n2 = "Active";
  assert.deepEqual((await l.wizard.setChannel("enterprise")).channelProblems, []);
  assert.deepEqual(l.apt.n2!.on(), [PAID_CEPH, PAID_PVE]);
});

test("an offline node is reported and the rest still switch", async () => {
  const l = lab();
  await signedIn(l);
  await l.wizard.createCluster("lab-1");
  await l.wizard.addNode("10.0.0.2", FP(2), "right");
  l.offline.add("n2");
  const out = await l.wizard.setChannel("free");
  assert.deepEqual(out.channelProblems, ["n2 is offline, so it wasn't changed."]);
  assert.deepEqual(l.apt.n1!.on(), [FREE_CEPH, FREE_PVE]);
});

test("only the offered channels are accepted", async () => {
  const l = lab();
  await signedIn(l);
  await assert.rejects(l.wizard.setChannel("test"), status(400));
});

test("junk codes from one machine don't lock out another (security review L1)", () => {
  const { wizard } = lab();
  for (let i = 0; i < 10; i++) assert.throws(() => wizard.enterCode("NOPE", "10.0.0.66"), status(401));
  assert.throws(() => wizard.enterCode(CODE, "10.0.0.66"), status(429));
  assert.ok(wizard.enterCode(CODE, "10.0.0.5"));
});

test("an abandoned setup forgets the root password after its hour (security review L5)", async () => {
  const l = lab();
  await signedIn(l);
  l.tick(61 * 60 * 1000);
  l.wizard.forgetIfExpired();
  assert.equal((l.wizard as unknown as { password: string }).password, "");
  assert.equal((l.wizard as unknown as { ticket: string }).ticket, "");
});

test("setup only answers to an address or a bare machine name, not another site's name (security review L1)", () => {
  assert.equal(setupHostAllowed("10.0.30.240"), true);
  assert.equal(setupHostAllowed("10.0.30.240:443"), true);
  assert.equal(setupHostAllowed("[fd00::5]:443"), true);
  assert.equal(setupHostAllowed("bossmox"), true);
  assert.equal(setupHostAllowed("evil.example.com"), false);
  assert.equal(setupHostAllowed(""), false);
});

test("a cluster whose nodes share a second network is offered it for moves, and choosing it sets Migration", async () => {
  const l = lab();
  await signedIn(l);
  assert.equal((await l.wizard.networks()).known, false, "one node, nothing to ask");
  l.setCluster("lab");
  l.setMembers([
    { name: "n1", ip: "10.0.0.1" },
    { name: "n2", ip: "10.0.0.2" },
    { name: "n3", ip: "10.0.0.3" },
  ]);
  const before = await l.wizard.networks();
  assert.deepEqual(
    { shared: before.shared, moveNet: before.moveNet, others: before.others, current: before.current },
    { shared: true, moveNet: "10.0.0.0/24", others: ["10.0.100.0/24"], current: null },
  );
  await assert.rejects(l.wizard.setMoveNetwork("192.168.1.0/24"), status(400));
  const after = await l.wizard.setMoveNetwork("10.0.100.0/24");
  assert.equal(l.options.migration, "type=secure,network=10.0.100.0/24");
  assert.deepEqual({ shared: after.shared, batch: after.batch, current: after.current }, { shared: false, batch: 3, current: "10.0.100.0/24" });
});

test("an insecure move type someone chose stays insecure when the network is set", async () => {
  const l = lab();
  await signedIn(l);
  l.setCluster("lab");
  l.setMembers([
    { name: "n1", ip: "10.0.0.1" },
    { name: "n2", ip: "10.0.0.2" },
  ]);
  l.options.migration = "type=insecure";
  await l.wizard.setMoveNetwork("10.0.100.0/24");
  assert.equal(l.options.migration, "type=insecure,network=10.0.100.0/24");
});

test("entering the code again signs the last person out and drops their root password (review S5)", async () => {
  for (const after of ["code again", "an hour later"]) {
    const l = lab();
    await signedIn(l);
    await l.wizard.createCluster("lab");
    if (after === "an hour later") l.tick(61 * 60 * 1000);
    l.wizard.enterCode(CODE);
    // Whoever has the code now can't use the root sign-in that was there before, so nothing carries the password.
    await assert.rejects(l.wizard.addNode("10.0.0.66", FP(6), "anything"), status(403), after);
    assert.equal(
      l.calls.some((c) => c.includes("/cluster/config/join")),
      false,
      `no join was sent (${after})`,
    );
    await assert.rejects(l.wizard.finish("10.0.0.9"), /Sign in first/, after);
  }
});

test("a code entered while a sign-in waits on Proxmox stops that sign-in landing (review 2, S5)", async () => {
  const l = lab();
  l.wizard.enterCode(CODE);
  const first = l.wizard.signIn("10.0.0.1:8006", FP(1), "root", "pam", "right");
  l.wizard.enterCode(CODE);
  await assert.rejects(first, status(409));
  assert.equal(JSON.stringify(l.wizard).includes("right"), false, "the first person's password isn't kept");
});
