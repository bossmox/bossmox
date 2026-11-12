import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsTarget } from "../src/pinned.js";

test("setup's certificate check connects to an IPv6 address without brackets, and sends no name for an address (#71)", () => {
  assert.deepEqual(tlsTarget("[2001:db8::1]"), { host: "2001:db8::1", servername: undefined });
  assert.deepEqual(tlsTarget("2001:db8::1"), { host: "2001:db8::1", servername: undefined });
  assert.deepEqual(tlsTarget("10.0.0.5"), { host: "10.0.0.5", servername: undefined });
  assert.deepEqual(tlsTarget("pve1.lan"), { host: "pve1.lan", servername: "pve1.lan" });
});
