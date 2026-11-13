import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseMismatch } from "../src/release-guard.js";
import { buildRollingPlan, type RawRepositories, type RollingInput } from "../src/server-detail.js";

/** Proxmox's real answer from a lab node whose sources all match its release: no Suites findings. */
const FRESH: RawRepositories = JSON.parse(readFileSync(new URL("../../test/apt-fresh-install.json", import.meta.url), "utf8"));
const PVE = "/etc/apt/sources.list.d/pve-enterprise.sources";
const DEBIAN = "/etc/apt/sources.list.d/debian.sources";

/** FRESH with one finding added, worded and shaped the way proxmox-apt's check_suites reports it. */
function flagged(path: string, index: number, kind: string, message: string): RawRepositories {
  const r: RawRepositories = structuredClone(FRESH);
  r.infos!.push({ path, index, kind, property: "Suites", message });
  return r;
}
/** A source added after the last download: Proxmox has no origin for it yet. */
function newSource(uri: string, kind = "ignore-pre-upgrade-warning"): RawRepositories {
  const r: RawRepositories = structuredClone(FRESH);
  const path = "/etc/apt/sources.list.d/new.sources";
  r.files!.push({ path, repositories: [{ Enabled: 1, URIs: [uri], Suites: ["trixie"], Components: ["main"] }] });
  r.infos!.push({ path, index: 0, kind, property: "Suites", message: "suite 'trixie' should not be used in production!" });
  return r;
}

test("sources that match the installed release let the update run", () => {
  assert.equal(releaseMismatch("pve1", FRESH), null);
});

test("Proxmox's source on the next release refuses, with Proxmox's own words", () => {
  const why = releaseMismatch("pve1", flagged(PVE, 0, "ignore-pre-upgrade-warning", "suite 'trixie' should not be used in production!"));
  assert.ok(why?.includes("pve1"));
  assert.ok(why?.includes("major version"));
  assert.ok(why?.includes(`${PVE}: suite 'trixie' should not be used in production!`));
});

test("a Debian source on an older release refuses too, so it holds in either direction", () => {
  assert.ok(releaseMismatch("pve1", flagged(DEBIAN, 1, "warning", "old suite 'bookworm' configured!")));
});

test("a third-party source on another release is ignored", () => {
  const r = flagged("/etc/apt/sources.list.d/docker.list", 0, "warning", "old suite 'bookworm' configured!");
  r.files!.push({ path: "/etc/apt/sources.list.d/docker.list", repositories: [{ Enabled: 1, URIs: ["https://download.docker.com/linux/debian"], Suites: ["bookworm"] }] });
  r.infos!.push({ path: "/etc/apt/sources.list.d/docker.list", index: 0, kind: "origin", message: "Docker" });
  assert.equal(releaseMismatch("pve1", r), null);
});

test("a source switched but not downloaded yet counts, whatever mirror it's on", () => {
  assert.ok(releaseMismatch("pve1", newSource("http://deb.debian.org/debian")), "Debian's address");
  assert.ok(releaseMismatch("pve1", newSource("http://download.proxmox.com/debian/pve")), "Proxmox's address");
  assert.ok(releaseMismatch("pve1", newSource("mirror+file:///etc/apt/mirrors/debian.list")), "Debian's mirror list");
  assert.ok(releaseMismatch("pve1", newSource("http://apt.lan/debian")), "a private mirror Proxmox can't name yet");
});

test("a source that's turned off doesn't count", () => {
  const r = flagged(PVE, 0, "ignore-pre-upgrade-warning", "suite 'trixie' should not be used in production!");
  r.files!.find((f) => f.path === PVE)!.repositories![0]!.Enabled = 0;
  assert.equal(releaseMismatch("pve1", r), null);
});

test("sources that can't be read refuse instead of passing", () => {
  assert.ok(releaseMismatch("pve1", null)?.includes("can't read"));
  const noInfos: RawRepositories = structuredClone(FRESH);
  delete noInfos.infos;
  assert.ok(releaseMismatch("pve1", noInfos), "no findings at all is not the same as no problems");
  const broken: RawRepositories = { ...structuredClone(FRESH), errors: [{ path: "/etc/apt/sources.list.d/bad.list", error: "malformed entry" }] };
  assert.ok(releaseMismatch("pve1", broken)?.includes("malformed entry"));
});

const server = (over: Partial<RollingInput>): RollingInput => ({ name: "pve1", online: true, version: "8.4.1", updates: 3, rebootNeeded: false, busy: [], cantMove: [], ...over });

test("one node on the wrong release stops the whole run, even with nothing to install there", () => {
  const plan = buildRollingPlan([server({ name: "pve1" }), server({ name: "pve2", updates: 0, releaseMismatch: "pve2 points at trixie" })], { available: true, value: true }, { available: false });
  assert.deepEqual(plan.blocked, ["pve2 points at trixie"]);
});
