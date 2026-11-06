import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNetwork } from "../src/network.js";
import { buildOverview } from "../src/model.js";

const raw = [
  { iface: "nic1", type: "eth" },
  { iface: "nic0", type: "eth", active: 1 },
  { iface: "vmbr0", type: "bridge", active: 1, cidr: "10.0.0.2/24", gateway: "10.0.0.1", bridge_ports: "nic0" },
];

test("virtual switches come first, then ports in use, then spare ones", () => {
  const view = buildNetwork("a", raw, null, []);
  assert.deepEqual(view.interfaces.map((i) => i.name), ["vmbr0", "nic0", "nic1"]);
  assert.equal(view.interfaces[0]?.kind, "Virtual switch");
  assert.equal(view.interfaces[1]?.partOf, "vmbr0");
  assert.equal(view.interfaces[2]?.active, false);
});

test("a switch lists only the guests on this server", () => {
  const guests = [{ name: "here", node: "a", bridges: ["vmbr0"] }, { name: "elsewhere", node: "b", bridges: ["vmbr0"] }, { name: "other", node: "a", bridges: ["vmbr1"] }];
  assert.deepEqual(buildNetwork("a", raw, null, guests).interfaces[0]?.guests, ["here"]);
});

test("DNS servers skip the empty slots", () => {
  const view = buildNetwork("a", [], { dns1: "1.1.1.1", dns3: "9.9.9.9", search: "lab" }, []);
  assert.deepEqual(view.dnsServers, ["1.1.1.1", "9.9.9.9"]);
  assert.equal(view.searchDomain, "lab");
});

test("the overview says which switches a guest is plugged into", () => {
  const view = buildOverview(
    [{ type: "qemu", vmid: 300, name: "vm", node: "a", status: "running" }],
    new Map([[300, { config: { net0: "virtio=BC:24:11:00:00:01,bridge=vmbr0", net1: "virtio=BC:24:11:00:00:02,bridge=vmbr1,tag=5", net2: "virtio=BC:24:11:00:00:03,bridge=vmbr0" } }]]),
    [],
  );
  assert.deepEqual(view.vms[0]?.bridges, ["vmbr0", "vmbr1"]);
});
