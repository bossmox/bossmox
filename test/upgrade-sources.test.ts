import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawRepositories } from "../src/server-detail.js";
import { gunzipSync } from "node:zlib";
import type { Session } from "../src/auth.js";
import type { ShellResult } from "../src/node-shell.js";
import { createUpgradeSources, followSwitchCommand, planSwitch, readSwitch, switchCommand, switchScript, switched, undoCommand } from "../src/upgrade-sources.js";

/** Proxmox's reading of a lab node on 8.4: Debian through mirror lists, the free channel on, the paid one off. */
const LAB: RawRepositories = {
  files: [
    { path: "/etc/apt/sources.list.d/pve.list", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-no-subscription"] }] },
    {
      path: "/etc/apt/sources.list.d/debian.sources",
      repositories: [
        { Enabled: 1, URIs: ["mirror+file:///etc/apt/mirrors/debian.list"], Suites: ["bookworm", "bookworm-updates", "bookworm-backports"], Components: ["main"] },
        { Enabled: 1, URIs: ["mirror+file:///etc/apt/mirrors/debian-security.list"], Suites: ["bookworm-security"], Components: ["main"] },
      ],
    },
    { path: "/etc/apt/sources.list.d/pve-enterprise.list", repositories: [{ Enabled: 0, URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-enterprise"] }] },
    { path: "/etc/apt/sources.list.d/docker.list", repositories: [{ Enabled: 1, URIs: ["https://download.docker.com/linux/debian"], Suites: ["bookworm"], Components: ["stable"] }] },
    { path: "/etc/apt/sources.list.d/ceph.list", repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com/debian/ceph-quincy"], Suites: ["bookworm"], Components: ["enterprise"] }] },
  ],
  infos: [
    { path: "/etc/apt/sources.list.d/debian.sources", index: 0, kind: "origin", message: "Debian" },
    { path: "/etc/apt/sources.list.d/debian.sources", index: 1, kind: "origin", message: "Debian" },
    { path: "/etc/apt/sources.list.d/docker.list", index: 0, kind: "origin", message: "Docker" },
  ],
};

test("the plan keeps the node's channels, switches Debian's sources, and names what it leaves alone", () => {
  const p = planSwitch(LAB, "bookworm", "trixie");
  assert.deepEqual(p.problems, []);
  assert.equal(p.pveComponent, "pve-no-subscription", "the turned-off paid source doesn't count");
  assert.equal(p.cephComponent, "enterprise");
  assert.deepEqual(p.debianUris, ["mirror+file:///etc/apt/mirrors/debian.list", "mirror+file:///etc/apt/mirrors/debian-security.list"]);
  assert.deepEqual(p.others, [{ path: "/etc/apt/sources.list.d/docker.list", uri: "https://download.docker.com/linux/debian" }]);
});

test("with no Proxmox source on, BossMox won't guess the channel", () => {
  const r: RawRepositories = { ...LAB, files: LAB.files?.filter((f) => !f.path?.endsWith("pve.list")) };
  assert.match(planSwitch(r, "bookworm", "trixie").problems.join(" "), /No Proxmox source/);
});

test("the script keeps the backslashes and line breaks the node's shell needs", () => {
  const s = switchScript(planSwitch(LAB, "bookworm", "trixie"));
  assert.ok(s.includes(String.raw`/proxmox\.com\/debian\/(pve|ceph-)/ {next}`), "awk's pattern");
  assert.ok(s.includes(String.raw`ORS="\n\n"`), "deb822 stanzas stay apart");
  assert.ok(s.includes('while((getline u < urifile)>0) if(u!="") uris[u]=1; RS=""'), "the URI list is read before paragraph mode");
  assert.ok(s.includes("URIs: https://enterprise.proxmox.com/debian/ceph-squid\nSuites: trixie\nComponents: enterprise"));
  assert.ok(s.includes("trap 'trap - ERR; restore;"), "a failure part way puts the backup back");
  assert.ok(s.includes("trap 'trap - ERR; restore; exit 1' HUP INT TERM"), "so does being stopped part way");
  assert.ok(s.includes(String.raw`/(^|\n)URIs:[^\n]*proxmox\.com\/debian\/(pve|ceph-)/ {next}`), "a .sources file loses only Proxmox's stanzas");
  const b64 = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(switchCommand(planSwitch(LAB, "bookworm", "trixie")))?.[1] ?? "";
  assert.equal(gunzipSync(Buffer.from(b64, "base64")).toString("utf8"), s);
});

test("the result is read from the script's own markers", () => {
  assert.deepEqual(readSwitch("BMXBACKUP /root/bossmox-apt-before-trixie-20261113-231605.tar\nBMXRESULT ok\n"), {
    ok: true,
    restored: false,
    backup: "/root/bossmox-apt-before-trixie-20261113-231605.tar",
    said: "",
  });
  const bad = readSwitch("BMXBACKUP /root/bossmox-apt-before-trixie-20261113-231605.tar\nBMXRESULT restored\nErr:3 http://download.proxmox.com/debian/pve trixie InRelease\nBMXSRC ended\n");
  assert.equal(bad.ok, false);
  assert.equal(bad.restored, true);
  assert.match(bad.said, /^Err:3/);
  const unknown = readSwitch("BMXBACKUP /root/bossmox-apt-before-trixie-20261113-231605.tar\nBMXSRC ended\n");
  assert.equal(unknown.restored, false, "no marker, no claim that the old sources are back (review 2026-11-16)");
  assert.equal(unknown.backup, "/root/bossmox-apt-before-trixie-20261113-231605.tar");
  assert.equal(readSwitch("BMXBACKUP /root/bossmox-apt-before-x';reboot;'.tar\n").backup, null, "a backup path a shell would read isn't kept");
  assert.equal(readSwitch(`${switchCommand(planSwitch(LAB, "bookworm", "trixie"))}\n`).ok, false, "the typed line itself never reads as a result");
});

test("after the switch, anything of Debian's or Proxmox's still on the old release is named", () => {
  assert.deepEqual(switched(LAB, "bookworm"), [
    "/etc/apt/sources.list.d/pve.list: bookworm",
    "/etc/apt/sources.list.d/debian.sources: bookworm bookworm-updates bookworm-backports",
    "/etc/apt/sources.list.d/debian.sources: bookworm-security",
    "/etc/apt/sources.list.d/ceph.list: bookworm",
  ]);
});

test("putting back only accepts a backup the switch made", () => {
  const c = undoCommand("/root/bossmox-apt-before-trixie-20261113-231605.tar");
  assert.ok(c.startsWith("[ -f '/root/bossmox-apt-before-trixie-20261113-231605.tar' ] && tar -tf "), "the backup is read through before anything is deleted");
  assert.throws(() => undoCommand("/root/bossmox-apt-before-x';reboot;'.tar"), /isn't a backup BossMox made/);
  assert.throws(() => undoCommand("/etc/passwd"), /isn't a backup BossMox made/);
});

const root = { username: "root@pam", ticket: "t" } as Session;
const shell = (output: string, exitCode = 0): ShellResult => ({ exitCode, output, tail: output, keptConfig: [] });
const sourcesWith = (consoleFn: (line: string) => Promise<ShellResult>, upgrading: string | null = null) =>
  createUpgradeSources({
    pve: {
      async get<T>(): Promise<T> {
        return LAB as T;
      },
    },
    console: async (_n, _s, line) => consoleFn(line),
    audit: () => {},
    upgrading: () => upgrading,
    wait: async () => {},
  });

test("the switch runs as its own job: a console that closes part way is followed to the end, not taken for a result (review 2026-11-16)", async () => {
  const typed: string[] = [];
  let follows = 0;
  const s = sourcesWith(async (line) => {
    typed.push(line === followSwitchCommand() ? "follow" : line.includes("systemd-run") ? "switch" : line);
    if (line.includes("systemd-run")) throw new Error("The console closed.");
    return shell(follows++ < 2 ? "BMXSRC running\n" : "BMXBACKUP /root/bossmox-apt-before-trixie-20261116-120000.tar\nBMXRESULT restored\nE: no route\nBMXSRC ended\n");
  });
  const r = await s.switchNode(root, "node1", "node1", "bookworm", "trixie");
  assert.deepEqual(typed, ["switch", "follow", "follow", "follow"]);
  assert.match(r.error ?? "", /old ones were put back.*E: no route/);
  assert.equal(r.backup, null, "the node said they're back, so nothing to put back");
});

test("a switch that ends without saying how keeps its backup on offer and says it can't tell (review 2026-11-16)", async () => {
  const s = sourcesWith(async () => shell("BMXBACKUP /root/bossmox-apt-before-trixie-20261116-120000.tar\nBMXSRC ended\n"));
  const r = await s.switchNode(root, "node1", "node1", "bookworm", "trixie");
  assert.match(r.error ?? "", /couldn't tell how the switch on node1 ended/);
  assert.equal(r.backup, "/root/bossmox-apt-before-trixie-20261116-120000.tar");
  assert.equal(r.switchedAt, null);
});

test("sources can't change while a node is upgrading (review 2026-11-16)", async () => {
  const s = sourcesWith(async () => assert.fail("nothing is typed"), "node2");
  await assert.rejects(s.switchNode(root, "node1", "node1", "bookworm", "trixie"), /upgrading node2/);
  await assert.rejects(s.undo(root, "node1", "node1"), /upgrading node2/);
});
