import assert from "node:assert/strict";
import { test } from "node:test";
import { clonesOf } from "../src/model.js";
import { plainError } from "../src/plain-errors.js";

test("Proxmox's messages seen in the lab come out in plain words, with the original kept", () => {
  // Both measured on bmx-node2, 2026-11-09.
  assert.match(plainError("base volume 'local:960/base-960-disk-0.qcow2' is still in use by linked cloned"), /^A clone made from this template still needs it\..*\(Proxmox said: base volume/);
  assert.match(plainError("VM is locked (backup)"), /^It's being backed up right now/);
  assert.match(plainError("CT is locked (migrate)"), /^It's being moved/);
  assert.match(plainError("VM is locked (strangething)"), /^It's busy/);
  assert.match(plainError("unable to activate storage 'nas' - directory is expected to be a mount point"), /^The storage nas isn't reachable/);
  assert.match(plainError("closing file '/var/lib/vz/x' failed - No space left on device"), /^The storage is full/);
});

test("a message BossMox doesn't know passes through untouched", () => {
  assert.equal(plainError("  something new  "), "something new");
});

test("a template's linked clones are found by their base disk, and only for that template", () => {
  const vms = [
    { id: 960, name: "tmpl", refs: ["local:960/base-960-disk-0.qcow2"] },
    { id: 961, name: "linked", refs: ["local:960/base-960-disk-0.qcow2/961/vm-961-disk-0.qcow2"] },
    { id: 9600, name: "other", refs: ["local:9600/base-9600-disk-0.qcow2"] },
  ];
  assert.deepEqual(clonesOf(960, vms), ["linked"]);
  assert.deepEqual(clonesOf(961, vms), []);
});
