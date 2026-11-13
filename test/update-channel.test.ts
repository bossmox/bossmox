import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { updateChannel, type RawRepositories } from "../src/server-detail.js";
import { channelAdds, channelDisables, channelOn } from "../src/update-channel.js";

/** Proxmox's real answer from a lab node set to a fresh install's sources (paid Proxmox and paid Ceph on). */
const FRESH: RawRepositories = JSON.parse(readFileSync(new URL("../../test/apt-fresh-install.json", import.meta.url), "utf8"));
const NONE = { status: "notfound" };
const ACTIVE = { status: "Active" };

const PVE_FREE = "http://download.proxmox.com/debian/pve";
const PVE_PAID = "https://enterprise.proxmox.com/debian/pve";
const CEPH_PAID = "https://enterprise.proxmox.com/debian/ceph-squid";
const CEPH_FREE = "http://download.proxmox.com/debian/ceph-squid";

/** What Proxmox would answer after the adds: the free sources on beside the paid ones. */
function afterFreeAdds(): RawRepositories {
  const r: RawRepositories = structuredClone(FRESH);
  r.files!.push({ path: "/etc/apt/sources.list.d/proxmox.sources", repositories: [{ Enabled: true, URIs: [PVE_FREE], Components: ["pve-no-subscription"] }] });
  r.files!.find((f) => f.path?.endsWith("ceph.sources"))!.repositories!.push({ Enabled: true, URIs: [CEPH_FREE], Components: ["no-subscription"] });
  for (const s of r["standard-repos"]!) if (s.handle === "no-subscription" || s.handle === "ceph-squid-no-subscription") s.status = 1;
  return r;
}

test("a fresh install reads as the paid channel that can't download, offering the free one", () => {
  const c = updateChannel(FRESH, NONE);
  assert.equal(c.name, "Enterprise");
  assert.equal(c.ok, false);
  assert.equal(c.headline, "Updates can't download");
  assert.equal(c.offer, "free");
});

test("switching a fresh install to free adds Proxmox's and Ceph's free sources", () => {
  assert.deepEqual(channelAdds(FRESH, "free"), ["no-subscription", "ceph-squid-no-subscription"]);
  assert.equal(channelOn(FRESH, "free"), false, "nothing gets turned off until the free channel is on");
});

test("then turns off both paid sources and nothing else", () => {
  const after = afterFreeAdds();
  assert.equal(channelOn(after, "free"), true);
  assert.deepEqual(channelDisables(after, "free"), [
    { path: "/etc/apt/sources.list.d/ceph.sources", index: 0 },
    { path: "/etc/apt/sources.list.d/pve-enterprise.sources", index: 0 },
  ]);
  assert.deepEqual(channelAdds(after, "free"), [], "running it again adds nothing");
});

test("free with Ceph's paid source still on says checks fail, not that updates can't download", () => {
  const after = afterFreeAdds();
  const pveOff = structuredClone(after);
  pveOff.files!.find((f) => f.path?.endsWith("pve-enterprise.sources"))!.repositories![0]!.Enabled = false;
  pveOff.files!.find((f) => f.path?.endsWith("ceph.sources"))!.repositories!.splice(1, 1);
  const c = updateChannel(pveOff, NONE);
  assert.equal(c.name, "Free (no subscription)");
  assert.equal(c.ok, false);
  assert.equal(c.headline, "Every check for updates ends in an error");
  assert.match(c.note, /Ceph's/);
  assert.equal(c.offer, "free");
});

test("a clean free channel is fine and offers nothing, unless there's a subscription", () => {
  const clean: RawRepositories = { files: [{ path: "/p", repositories: [{ Enabled: true, URIs: [PVE_FREE], Components: ["pve-no-subscription"] }] }] };
  assert.deepEqual([updateChannel(clean, NONE).ok, updateChannel(clean, NONE).offer], [true, null]);
  assert.equal(updateChannel(clean, ACTIVE).offer, "enterprise");
});

test("switching to enterprise adds the paid sources and turns the free ones off", () => {
  const free: RawRepositories = {
    files: [
      { path: "/etc/apt/sources.list.d/proxmox.sources", repositories: [{ Enabled: true, URIs: [PVE_FREE], Components: ["pve-no-subscription"] }] },
      { path: "/etc/apt/sources.list.d/ceph.sources", repositories: [{ Enabled: true, URIs: [CEPH_FREE], Components: ["no-subscription"] }] },
      { path: "/etc/apt/sources.list.d/debian.sources", repositories: [{ Enabled: true, URIs: ["http://deb.debian.org/debian/"], Components: ["main"] }] },
    ],
    "standard-repos": [{ handle: "enterprise" }, { handle: "no-subscription", status: 1 }, { handle: "ceph-squid-no-subscription", status: 1 }, { handle: "ceph-squid-enterprise" }],
  };
  assert.deepEqual(channelAdds(free, "enterprise"), ["enterprise", "ceph-squid-enterprise"]);
  const both = structuredClone(free);
  both.files!.push({ path: "/etc/apt/sources.list.d/pve-enterprise.sources", repositories: [{ Enabled: true, URIs: [PVE_PAID], Components: ["pve-enterprise"] }] });
  both.files![1]!.repositories!.push({ Enabled: true, URIs: [CEPH_PAID], Components: ["enterprise"] });
  assert.deepEqual(channelDisables(both, "enterprise"), [
    { path: "/etc/apt/sources.list.d/proxmox.sources", index: 0 },
    { path: "/etc/apt/sources.list.d/ceph.sources", index: 0 },
  ]);
});

test("a node without Ceph gets no Ceph source", () => {
  const noCeph: RawRepositories = { files: [], "standard-repos": [{ handle: "enterprise", status: 1 }, { handle: "ceph-squid-enterprise" }] };
  assert.deepEqual(channelAdds(noCeph, "free"), ["no-subscription"]);
});

test("without the subscription answer, an enterprise node isn't flagged or offered a switch", () => {
  const c = updateChannel(FRESH);
  assert.equal(c.ok, true);
  assert.equal(c.offer, null);
});

test("only Proxmox's own host counts as a Proxmox source, not an address that merely contains the name", () => {
  const repos: RawRepositories = {
    files: [
      {
        path: "/etc/apt/sources.list.d/odd.list",
        repositories: [
          { Enabled: true, URIs: ["https://evil.example/enterprise.proxmox.com/debian/pve"], Components: ["pve-enterprise"] },
          { Enabled: true, URIs: ["http://notproxmox.com/debian/pve"], Components: ["pve-no-subscription"] },
        ],
      },
    ],
  };
  const c = updateChannel(repos, ACTIVE);
  assert.notEqual(c.name, "Enterprise");
  assert.notEqual(c.name, "No-Subscription");
});
