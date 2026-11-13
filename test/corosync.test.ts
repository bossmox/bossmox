import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addLink, CorosyncError, linkStatus, linksIn, linkUp, readConf, setVersion } from "../src/corosync.js";

const lab = readFileSync(new URL("../../test/corosync-pve8-one-link.conf", import.meta.url), "utf8");
const addrs = { "bmx8-node1": "10.0.31.244", "bmx8-node2": "10.0.31.245", "bmx8-node3": "10.0.31.246" };

test("reads the lab's real heartbeat file (Proxmox 8.4)", () => {
  const c = readConf(lab);
  assert.equal(c.clusterName, "bmx8lab");
  assert.equal(c.version, 3);
  assert.deepEqual(
    c.nodes.map((n) => [n.name, n.nodeid, n.rings[0]]),
    [
      ["bmx8-node1", 1, "10.0.30.244"],
      ["bmx8-node2", 2, "10.0.30.245"],
      ["bmx8-node3", 3, "10.0.30.246"],
    ],
  );
  assert.deepEqual(linksIn(c), [0]);
});

test("adding link 1 adds an address per node and a totem interface, raises the version, and leaves the rest alone (ADR 0035)", () => {
  const out = addLink(lab, 1, addrs);
  const c = readConf(out);
  assert.equal(c.version, 4);
  assert.deepEqual(
    c.nodes.map((n) => n.rings[1]),
    ["10.0.31.244", "10.0.31.245", "10.0.31.246"],
  );
  assert.deepEqual(c.interfaces, [0, 1]);
  assert.deepEqual(linksIn(c), [0, 1]);
  // Only added lines and the version line differ.
  const before = lab.split("\n");
  const after = out.split("\n").filter((l) => !/ring1_addr|linknumber: 1/.test(l));
  const kept = after.filter((l, i, a) => !(l.trim() === "interface {" && a[i + 1]?.trim() === "}" && a[i - 1]?.trim() === "}"));
  assert.equal(after.length, before.length + 2, "the new interface's braces are the only other new lines");
  assert.ok(kept.length >= before.length);
  assert.match(out, /\n {4}ring0_addr: 10\.0\.30\.244\n {4}ring1_addr: 10\.0\.31\.244\n/, "same indent as ring0");
  assert.match(out, /\n {2}interface \{\n {4}linknumber: 0\n {2}\}\n {2}interface \{\n {4}linknumber: 1\n {2}\}\n/);
  assert.match(out, /config_version: 4\n/);
});

test("adding a link refuses a missing, extra or non-IPv4 address, and a link that exists", () => {
  assert.throws(() => addLink(lab, 1, { "bmx8-node1": "10.0.31.244", "bmx8-node2": "10.0.31.245" }), CorosyncError);
  assert.throws(() => addLink(lab, 1, { ...addrs, "bmx8-node3": "pve3.lan" }), CorosyncError);
  assert.throws(() => addLink(lab, 1, { ...addrs, other: "10.0.31.9" }), CorosyncError);
  assert.throws(() => addLink(lab, 0, addrs), CorosyncError);
  assert.throws(() => addLink(addLink(lab, 1, addrs), 1, addrs), CorosyncError);
});

test("putting the old file back keeps its content and raises the version past the new one", () => {
  const added = addLink(lab, 1, addrs);
  const back = setVersion(lab, readConf(added).version + 1);
  assert.equal(readConf(back).version, 5);
  assert.equal(back.replace("config_version: 5", "config_version: 3"), lab);
});

test("unbalanced braces are refused rather than guessed at", () => {
  assert.throws(() => readConf(lab.replace(/\}\s*$/, "")), CorosyncError);
  assert.throws(() => readConf(`${lab}\n}`), CorosyncError);
});

test("reads each link's state from corosync-cfgtool -s", () => {
  const out = `Local node ID 1, transport knet
LINK ID 0 udp
\taddr\t= 10.0.30.244
\tstatus:
\t\tnodeid:          1:\tlocalhost
\t\tnodeid:          2:\tconnected
\t\tnodeid:          3:\tconnected
LINK ID 1 udp
\taddr\t= 10.0.31.244
\tstatus:
\t\tnodeid:          1:\tlocalhost
\t\tnodeid:          2:\tconnected
\t\tnodeid:          3:\tdisconnected`;
  const s = linkStatus(out);
  assert.equal(linkUp(s, 0, [1, 2, 3]), true);
  assert.equal(linkUp(s, 1, [1, 2, 3]), false, "node 3 not connected on link 1");
  assert.equal(linkUp(s, 2, [1, 2, 3]), false, "a link that isn't there");
});
