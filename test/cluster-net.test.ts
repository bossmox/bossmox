import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNetworks, FULL_BATCH, freeNets, inNetwork, networkOf, type NodeNets } from "../src/cluster-net.js";

// Maverick as read 2026-11-11: heartbeat and management on 10.0.0.x (1 Gb), a 10 Gb network on 10.0.100.x, no Migration setting.
const maverick: NodeNets[] = [56, 57, 58].map((n) => ({ name: `pve-node${n - 55}`, links: [`10.0.0.${n}`], addresses: [`10.0.0.${n}/24`, `10.0.100.${n}/24`] }));

test("networks from addresses", () => {
  assert.equal(networkOf("10.0.0.57/24"), "10.0.0.0/24");
  assert.equal(networkOf("172.16.32.244/20"), "172.16.32.0/20");
  assert.equal(networkOf("fe80::1/64"), null);
  assert.equal(networkOf("10.0.0.300/24"), null);
  assert.ok(inNetwork("10.0.100.31", "10.0.100.0/24"));
  assert.ok(!inNetwork("10.0.0.31", "10.0.100.0/24"));
});

test("Maverick: moves share the heartbeat's only network, and 10.0.100.0/24 is free on every node", () => {
  const c = checkNetworks(maverick, null);
  assert.deepEqual(c, { known: true, shared: true, moveNet: "10.0.0.0/24", others: ["10.0.100.0/24"], batch: 1, heartbeat: ["10.0.0.0/24"] });
});

test("with Migration set to the other network, moves have their own and go three at a time", () => {
  const c = checkNetworks(maverick, "10.0.100.0/24");
  assert.equal(c.shared, false);
  assert.equal(c.moveNet, "10.0.100.0/24");
  assert.deepEqual(c.others, ["10.0.0.0/24"]);
  assert.equal(c.batch, 3);
});

test("a second heartbeat link on another network makes sharing safe", () => {
  const two = maverick.map((n, i) => ({ ...n, links: [`10.0.0.${56 + i}`, `10.0.100.${56 + i}`] }));
  assert.equal(checkNetworks(two, null).shared, false);
});

test("Migration set to the heartbeat's own network is still shared", () => {
  assert.equal(checkNetworks(maverick, "10.0.0.0/24").shared, true);
});

test("one network only: shared, with nothing to suggest", () => {
  const lab = [244, 245, 246].map((n) => ({ name: `n${n}`, links: [`10.0.30.${n}`], addresses: [`10.0.30.${n}/24`] }));
  assert.deepEqual(checkNetworks(lab, null), { known: true, shared: true, moveNet: "10.0.30.0/24", others: [], batch: 1, heartbeat: ["10.0.30.0/24"] });
});

test("a network only some nodes have isn't offered", () => {
  const mixed = maverick.map((n, i) => (i === 2 ? { ...n, addresses: [n.addresses[0] as string] } : n));
  assert.deepEqual(checkNetworks(mixed, null).others, []);
});

test("can't judge: one node, a heartbeat given as a name, an address the node doesn't list", () => {
  assert.equal(checkNetworks(maverick.slice(0, 1), null).known, false);
  assert.equal(
    checkNetworks(
      maverick.map((n) => ({ ...n, links: [n.name] })),
      null,
    ).known,
    false,
  );
  assert.equal(
    checkNetworks(
      maverick.map((n) => ({ ...n, links: ["192.168.9.9"] })),
      null,
    ).known,
    false,
  );
  assert.equal(checkNetworks(maverick, "not-a-net").known, false);
  assert.equal(checkNetworks(maverick.slice(0, 1), null).batch, 1, "unknown means the careful batch");
});

test("free networks leave out any network the heartbeat uses, so setup never offers one for moves", () => {
  assert.deepEqual(freeNets({ known: true, shared: true, moveNet: "10.0.0.0/24", others: ["10.0.1.0/24", "10.0.100.0/24"], batch: 1, heartbeat: ["10.0.0.0/24", "10.0.1.0/24"] }), ["10.0.100.0/24"]);
});

test("a backup heartbeat link on the move network: moves no longer share the heartbeat's only network (ADR 0035)", () => {
  const nodes = [1, 2, 3].map((n) => ({ name: `n${n}`, links: [`10.0.30.${n}`, `10.0.31.${n}`], addresses: [`10.0.30.${n}/24`, `10.0.31.${n}/24`] }));
  const c = checkNetworks(nodes, "10.0.31.0/24");
  assert.equal(c.known, true);
  assert.equal(c.shared, false, "link 0 carries no moves, so the heartbeat keeps a network of its own");
  assert.equal(c.batch, FULL_BATCH);
});
