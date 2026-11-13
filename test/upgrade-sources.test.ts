import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawRepositories } from "../src/server-detail.js";
import { planSwitch, readSwitch, switchCommand, switchScript, switched, undoCommand } from "../src/upgrade-sources.js";

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
  assert.ok(s.includes("trap 'restore;"), "a failure part way puts the backup back");
  const b64 = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(switchCommand(planSwitch(LAB, "bookworm", "trixie")))?.[1] ?? "";
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), s);
});

test("the result is read from the script's own markers", () => {
  assert.deepEqual(readSwitch("BMXBACKUP /root/bossmox-apt-before-trixie-20261113-231605.tar\nBMXRESULT ok\n"), { ok: true, backup: "/root/bossmox-apt-before-trixie-20261113-231605.tar", said: "" });
  const bad = readSwitch("BMXBACKUP /root/bossmox-apt-before-trixie-1.tar\nBMXRESULT restored\nErr:3 http://download.proxmox.com/debian/pve trixie InRelease\n");
  assert.equal(bad.ok, false);
  assert.match(bad.said, /^Err:3/);
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
  assert.ok(
    undoCommand("/root/bossmox-apt-before-trixie-20261113-231605.tar").startsWith(
      "case '/root/bossmox-apt-before-trixie-20261113-231605.tar' in /root/bossmox-apt-before-*.tar) ;; *) exit 64 ;; esac;",
    ),
  );
});
