import assert from "node:assert/strict";
import { test } from "node:test";
import { auditLine } from "../src/audit.js";

test("an audit value from the request can't add a field, start a line or colour a terminal (#59)", () => {
  const at = new Date("2026-11-12T12:00:00Z");
  const line = auditLine(at, "snapshot-take", "root@pam", "10.0.0.5", { node: "n1", guest: "1 node=evil\nfake", note: "\x1b[31mred" });
  assert.equal(line, "audit 2026-11-12T12:00:00.000Z snapshot-take user=root@pam from=10.0.0.5 node=n1 guest=1?node=evil?fake note=?[31mred");
  assert.equal(line.split(" ").filter((p) => p.startsWith("node=")).length, 1, "only the real node field");
});
