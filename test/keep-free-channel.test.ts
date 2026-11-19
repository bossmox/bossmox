import assert from "node:assert/strict";
import { test } from "node:test";
import { paidAdded, paidOn, planFreeChannel } from "../src/keep-free-channel.js";
import type { RawRepositories } from "../src/server-detail.js";

/** A free-channel 8.4 node as found on a real cluster: the old paid list there, turned off by hand. */
const BEFORE: RawRepositories = {
  digest: "a1",
  files: [
    { path: "/etc/apt/sources.list", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-no-subscription"] }] },
    { path: "/etc/apt/sources.list.d/pve-enterprise.list", repositories: [{ Enabled: 0, URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-enterprise"] }] },
  ],
};
/** After the 9 packages: BossMox's free source, and Proxmox's new paid file, switched on. */
const AFTER: RawRepositories = {
  digest: "b2",
  files: [
    { path: "/etc/apt/sources.list.d/proxmox.sources", repositories: [{ Enabled: 1, URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-no-subscription"] }] },
    { path: "/etc/apt/sources.list.d/pve-enterprise.list", repositories: [{ Enabled: 0, URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["bookworm"], Components: ["pve-enterprise"] }] },
    { path: "/etc/apt/sources.list.d/pve-enterprise.sources", repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-enterprise"] }] },
  ],
};

test("a free-channel node without a subscription keeps the free channel: only the paid entry the upgrade added is turned off", () => {
  const plan = planFreeChannel(BEFORE, { status: "notfound" });
  assert.equal(plan.keep, true);
  assert.deepEqual(paidAdded(plan, AFTER), [{ path: "/etc/apt/sources.list.d/pve-enterprise.sources", index: 0 }]);
});

test("a paid entry someone had on before the upgrade is never touched (rule R8)", () => {
  const ceph = { path: "/etc/apt/sources.list.d/ceph.list", repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com/debian/ceph-squid"], Components: ["enterprise"] }] };
  const plan = planFreeChannel({ files: [...(BEFORE.files ?? []), ceph] }, { status: "notfound" });
  assert.deepEqual(
    paidAdded(plan, { files: [...(AFTER.files ?? []), ceph] }).map((e) => e.path),
    ["/etc/apt/sources.list.d/pve-enterprise.sources"],
  );
});

test("a subscription, another channel, or not knowing leaves the sources as Proxmox sets them, and says why", () => {
  assert.match(planFreeChannel(BEFORE, { status: "Active" }).why, /has a subscription/);
  const paid: RawRepositories = {
    files: [{ path: "/etc/apt/sources.list.d/pve-enterprise.list", repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com/debian/pve"], Components: ["pve-enterprise"] }] }],
  };
  assert.match(planFreeChannel(paid, { status: "notfound" }).why, /isn't on the free channel/);
  assert.match(planFreeChannel(null, { status: "notfound" }).why, /couldn't read/);
  assert.match(planFreeChannel(BEFORE, null).why, /couldn't read/);
  for (const p of [planFreeChannel(BEFORE, { status: "Active" }), planFreeChannel(null, null)]) assert.deepEqual(paidAdded(p, AFTER), [], "nothing turned off");
});

test("only Proxmox's paid server counts as paid, by host, not by look-alike text", () => {
  const odd: RawRepositories = {
    files: [
      { path: "/a", repositories: [{ Enabled: 1, URIs: ["https://enterprise.proxmox.com.example.org/debian/pve"] }] },
      { path: "/b", repositories: [{ Enabled: 1, URIs: ["https://mirror.example/enterprise.proxmox.com"] }] },
      { path: "/c", repositories: [{ Enabled: true, URIs: ["https://enterprise.proxmox.com/debian/ceph-squid"] }] },
    ],
  };
  assert.deepEqual(
    paidOn(odd).map((e) => e.path),
    ["/c"],
  );
});

test("a subscription answer without a status is not knowing, not 'no subscription' (review 0.3.2)", () => {
  assert.equal(planFreeChannel(BEFORE, {}).keep, false);
  assert.match(planFreeChannel(BEFORE, {}).why, /couldn't read/);
});
