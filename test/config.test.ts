import assert from "node:assert/strict";
import { test } from "node:test";
import { requestPath } from "../src/config.js";

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
