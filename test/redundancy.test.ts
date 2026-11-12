import assert from "node:assert/strict";
import { test } from "node:test";
import { heartbeatState, portsOf, type NodeIfaces, type RawIface } from "../src/redundancy.js";

// The bmx8 lab as Proxmox lists it: heartbeat on vmbr0 over eth0, a second port ens19 on 10.0.31.0/24.
const lab = (n: number, extra: RawIface[] = []): NodeIfaces => ({
  name: `bmx8-node${n}`,
  rings: { 0: `10.0.30.${243 + n}` },
  ifaces: [{ iface: "eth0", type: "eth" }, { iface: "ens19", type: "eth", cidr: `10.0.31.${243 + n}/24` }, { iface: "vmbr0", type: "bridge", bridge_ports: "eth0", cidr: `10.0.30.${243 + n}/24` }, ...extra],
});

test("ports: a bridge over a bond over two cards, a VLAN on a bridge, a VLAN named after its parent", () => {
  const ifaces: RawIface[] = [
    { iface: "eno1", type: "eth" }, { iface: "eno2", type: "eth" },
    { iface: "bond0", type: "bond", slaves: "eno1 eno2" },
    { iface: "vmbr0", type: "bridge", bridge_ports: "bond0" },
    { iface: "vmbr0.20", type: "vlan", "vlan-raw-device": "vmbr0" },
    { iface: "eno1.30", type: "vlan" },
    { iface: "vmbr9", type: "bridge", bridge_ports: "" },
    { iface: "ovs0", type: "OVSBridge" },
  ];
  assert.deepEqual([...(portsOf(ifaces, "vmbr0") ?? [])].sort(), ["eno1", "eno2"]);
  assert.deepEqual([...(portsOf(ifaces, "vmbr0.20") ?? [])].sort(), ["eno1", "eno2"]);
  assert.deepEqual([...(portsOf(ifaces, "eno1.30") ?? [])], ["eno1"]);
  assert.equal(portsOf(ifaces, "vmbr9")?.size, 0, "a bridge with no port");
  assert.equal(portsOf(ifaces, "ovs0"), null, "Open vSwitch isn't followed");
  assert.equal(portsOf(ifaces, "nope"), null);
});

test("the lab gets the offer: 10.0.31.0/24 on its own port, an address per node (ADR 0035)", () => {
  const s = heartbeatState([lab(1), lab(2), lab(3)], null);
  assert.deepEqual(s, { state: "offer", network: "10.0.31.0/24", addresses: { "bmx8-node1": "10.0.31.244", "bmx8-node2": "10.0.31.245", "bmx8-node3": "10.0.31.246" }, sharesMoves: false, link: 1 });
  const moves = heartbeatState([lab(1), lab(2), lab(3)], "10.0.31.0/24");
  assert.equal(moves.state === "offer" && moves.sharesMoves, true, "still offered, saying it shares with moves");
});

test("a VLAN on the heartbeat's own port isn't a backup (Rocky: no second link, no)", () => {
  const vlanOnly = (n: number): NodeIfaces => ({
    name: `n${n}`, rings: { 0: `10.0.30.${n}` },
    ifaces: [{ iface: "eth0", type: "eth" }, { iface: "vmbr0", type: "bridge", bridge_ports: "eth0", cidr: `10.0.30.${n}/24` }, { iface: "vmbr0.31", type: "vlan", cidr: `10.0.31.${n}/24` }],
  });
  assert.deepEqual(heartbeatState([vlanOnly(1), vlanOnly(2)], null), { state: "no-port", nodes: ["n1", "n2"] });
  // One node without a second port names that node.
  assert.deepEqual(heartbeatState([lab(1), lab(2), vlanOnly(3)], null), { state: "no-port", nodes: ["n3"] });
});

test("two links, one node, and heartbeats it can't judge", () => {
  const two = (n: number) => ({ ...lab(n), rings: { 0: `10.0.30.${243 + n}`, 1: `10.0.31.${243 + n}` } });
  assert.deepEqual(heartbeatState([two(1), two(2), two(3)], null), { state: "backed-up", links: 2 });
  assert.deepEqual(heartbeatState([lab(1)], null), { state: "single" });
  assert.equal(heartbeatState([lab(1), { ...lab(2), rings: { 0: "pve2.lan" } }], null).state, "unknown");
});
