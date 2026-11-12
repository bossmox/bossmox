import assert from "node:assert/strict";
import { test } from "node:test";
import { hostName, loadConfig, requestPath, urlHost } from "../src/config.js";
import { setupHostAllowed } from "../src/wizard.js";

test("host names: ports and IPv6 brackets come off, and a bare IPv6 address keeps its last group (#54)", () => {
  assert.equal(hostName("bossmox.lan:8443"), "bossmox.lan");
  assert.equal(hostName("10.0.30.247:443"), "10.0.30.247");
  assert.equal(hostName("[2001:DB8::10]:443"), "2001:db8::10");
  assert.equal(hostName("[2001:db8::10]"), "2001:db8::10");
  // Before: the trailing ":10" was taken for a port, leaving "2001:db8:".
  assert.equal(hostName("2001:db8::10"), "2001:db8::10");
  assert.equal(hostName(" BossMox "), "bossmox");
});

test("an IPv6 node address is bracketed in a URL, so PVE_URL parses after setup (#54)", () => {
  assert.equal(urlHost("2001:db8::1"), "[2001:db8::1]");
  assert.equal(urlHost("10.0.30.244"), "10.0.30.244");
  assert.equal(urlHost("pve1.lan"), "pve1.lan");
  const url = `https://${urlHost("2001:db8::1")}:8006`;
  assert.equal(new URL(url).hostname, "[2001:db8::1]");
  // What setup writes has to load: before, "https://2001:db8::1:8006" made loadConfig throw at start-up.
  const config = loadConfig({ PVE_URL: `${url},https://10.0.30.244:8006`, BOSSMOX_ALLOWED_HOSTS: "2001:db8::10,[2001:db8::11]:443" });
  assert.equal(config.pveUrls.length, 2);
  assert.ok(config.allowedHosts.has("2001:db8::10"));
  assert.ok(config.allowedHosts.has("2001:db8::11"));
});

test("the setup wizard accepts IPv6 Host headers with or without a port (#54)", () => {
  assert.ok(setupHostAllowed("[2001:db8::10]:443"));
  assert.ok(setupHostAllowed("[2001:db8::10]"));
  assert.ok(setupHostAllowed("10.0.30.247:443"));
  assert.ok(!setupHostAllowed("evil.example.com"));
});

test("a request target that can't be read as a path gives null instead of throwing (#52)", () => {
  // "//" alone made `new URL` throw outside the setup server's try, which stopped the server.
  assert.equal(requestPath("//"), null);
  assert.equal(requestPath("//:"), null);
});

test("ordinary targets give their path", () => {
  assert.equal(requestPath("/setup/finish"), "/setup/finish");
  assert.equal(requestPath("/healthz?x=1"), "/healthz");
  assert.equal(requestPath("/a//b"), "/a//b");
  assert.equal(requestPath(undefined), "/");
});
