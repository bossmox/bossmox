import assert from "node:assert/strict";
import { test } from "node:test";
import { newerRelease, RELEASES_API, UpdateChecker, versionNumbers } from "../src/update-check.js";

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `https://github.com/bossmox/bossmox/releases/tag/${tag}`, ...extra });
const running = "0.1.0-preview.20261109.b55906c";

test("a version's numbers come from a release tag or a running build alike", () => {
  assert.deepEqual(versionNumbers("v0.1.1-preview"), [0, 1, 1]);
  assert.deepEqual(versionNumbers(running), [0, 1, 0]);
  assert.equal(versionNumbers(""), null, "a copy run from the repo has no version");
});

test("only a higher version number counts as an update", () => {
  assert.deepEqual(newerRelease(running, rel("v0.1.1-preview")), { version: "0.1.1-preview", url: "https://github.com/bossmox/bossmox/releases/tag/v0.1.1-preview" });
  assert.deepEqual(newerRelease(running, rel("v0.2.0"))?.version, "0.2.0");
  assert.equal(newerRelease(running, rel("v0.1.0-preview")), null, "the release it's running");
  assert.equal(newerRelease("0.2.0", rel("v0.1.9")), null, "an older release");
  assert.equal(newerRelease("0.1.9", rel("v0.1.10"))?.version, "0.1.10", "numbers, not text: 10 is more than 9");
  assert.equal(newerRelease("", rel("v9.0.0")), null);
});

test("drafts, pre-releases and links outside the project are ignored", () => {
  assert.equal(newerRelease(running, rel("v0.2.0", { draft: true })), null);
  assert.equal(newerRelease(running, rel("v0.2.0", { prerelease: true })), null);
  assert.equal(newerRelease(running, { tag_name: "v0.2.0", html_url: "https://evil.example/bossmox" }), null);
  assert.equal(newerRelease(running, { tag_name: 2, html_url: "x" }), null);
});

const answer = (status: number, body: unknown) => async () => ({ ok: status === 200, status, json: async () => body });

test("a check asks GitHub's latest release, names itself, and keeps what it found", async () => {
  const asked: { url: string; ua: string }[] = [];
  const checker = new UpdateChecker(running, true, async (url, init) => {
    asked.push({ url, ua: init.headers["User-Agent"]! });
    return answer(200, rel("v0.1.1-preview"))();
  });
  const s = await checker.check();
  assert.deepEqual(asked, [{ url: RELEASES_API, ua: `BossMox/${running}` }]);
  assert.equal(s.available?.version, "0.1.1-preview");
  assert.equal(s.failed, null);
  assert.ok(s.checkedAt);
});

test("a failed check says why in plain words and never throws", async () => {
  const limited = await new UpdateChecker(running, true, answer(403, {})).check();
  assert.equal(limited.failed, "GitHub asked BossMox to slow down");
  const offline = await new UpdateChecker(running, true, async () => { throw new TypeError("fetch failed"); }).check();
  assert.equal(offline.failed, "BossMox couldn't reach GitHub");
});

test("turned off, or with no version, it never contacts GitHub; turning it off forgets the notice", async () => {
  let calls = 0;
  const count = async () => { calls++; return answer(200, rel("v0.1.1-preview"))(); };
  await new UpdateChecker(running, false, count).check();
  await new UpdateChecker("", true, count).check();
  assert.equal(calls, 0);
  const checker = new UpdateChecker(running, true, count);
  await checker.check();
  assert.ok(checker.state.available);
  await checker.setOn(false);
  assert.deepEqual(checker.state, { on: false, checkedAt: null, available: null, failed: null });
  const back = await checker.setOn(true);
  checker.stop();
  assert.equal(back.available?.version, "0.1.1-preview", "turning it back on checks straight away");
});
