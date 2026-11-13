import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import { createEmail, parseAddresses, RENEW_EVERY_MS } from "../src/email.js";
import { createOutlook, OutlookError, type Fetcher, type Outlook } from "../src/outlook.js";
import { readKey, seal, unseal } from "../src/sealed.js";

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const who = { username: "root@pam", ticket: "t" } as Session;
const dir = () => mkdtempSync(path.join(process.env.BOSSMOX_TEST_TMP ?? tmpdir(), "bmx-email-"));

test("a sealed secret opens only with its own key, and a changed byte fails", () => {
  const s = seal("refresh-token-value", KEY);
  assert.ok(!s.includes("refresh-token-value"));
  assert.equal(unseal(s, KEY), "refresh-token-value");
  assert.equal(unseal(s, OTHER), null);
  const parts = s.split(".");
  const data = Buffer.from(parts[3] as string, "base64url");
  data[0] = (data[0] as number) ^ 1;
  assert.equal(unseal([parts[0], parts[1], parts[2], data.toString("base64url")].join("."), KEY), null);
  assert.equal(unseal("plain text", KEY), null);
});

test("the key file has to be 32 bytes in hex; anything else means no key", () => {
  const d = dir();
  assert.equal(readKey(path.join(d, "missing")), null);
  writeFileSync(path.join(d, "short"), "abcd");
  assert.equal(readKey(path.join(d, "short")), null);
  writeFileSync(path.join(d, "good"), `${"ab".repeat(32)}\n`);
  assert.equal(readKey(path.join(d, "good"))?.length, 32);
});

test("addresses can be separated by commas, semicolons or spaces, and must look like addresses", () => {
  assert.deepEqual(parseAddresses("a@x.com, b@y.org; a@x.com c@z.net"), ["a@x.com", "b@y.org", "c@z.net"]);
  assert.throws(() => parseAddresses(""), /at least one/);
  assert.throws(() => parseAddresses("a@x.com, nope"), /"nope" isn't/);
  assert.throws(() => parseAddresses("a@x.com\nBcc: evil@x.com"), /isn't/);
});

/** A fake Microsoft: each refresh token works once and is replaced, the way Microsoft rotates them. */
function fakeOutlook(opts: { pendingPolls?: number; renewRefuses?: boolean } = {}) {
  const sent: { token: string; to: string[]; subject: string }[] = [];
  let polls = 0;
  let n = 0;
  const live = new Set(["r0"]);
  const outlook: Outlook = {
    startSignIn: async () => ({ deviceCode: "dev", userCode: "ABC123", verificationUri: "https://microsoft.com/devicelogin", expiresAt: Date.now() + 900_000, intervalMs: 1 }),
    poll: async () => (polls++ < (opts.pendingPolls ?? 0) ? { state: "waiting" } : { state: "done", tokens: { access: "a0", refresh: "r0", accessExpiresAt: Date.now() + 3_600_000 } }),
    renew: async (refresh) => {
      if (opts.renewRefuses || !live.has(refresh)) throw new OutlookError("invalid_grant", "AADSTS70000: The grant expired.");
      live.delete(refresh);
      n++;
      live.add(`r${n}`);
      return { access: `a${n}`, refresh: `r${n}`, accessExpiresAt: Date.now() + 3_600_000 };
    },
    account: async () => "rocky@outlook.com",
    send: async (token, to, subject) => {
      sent.push({ token, to, subject });
    },
  };
  return { outlook, sent, live };
}

const settle = async (email: { view(): { signIn: unknown } }) => {
  for (let i = 0; i < 50 && email.view().signIn && !("error" in (email.view().signIn as object)); i++) await new Promise((r) => setTimeout(r, 2));
};

function setup(opts: Parameters<typeof fakeOutlook>[0] = {}, extra: { key?: Buffer | null; canChange?: boolean } = {}) {
  const fake = fakeOutlook(opts);
  const file = path.join(dir(), "email.json");
  const audits: string[] = [];
  const email = createEmail({
    file,
    key: extra.key === undefined ? KEY : extra.key,
    outlook: fake.outlook,
    canChange: async () => extra.canChange ?? true,
    audit: (e) => audits.push(e),
    wait: () => new Promise((r) => setTimeout(r, 1)),
  });
  return { ...fake, file, email, audits };
}

test("signing in by code keeps the account and its token sealed, never in plain text", async () => {
  const s = setup({ pendingPolls: 2 });
  const started = await s.email.start(who);
  assert.equal(started.code, "ABC123");
  await settle(s.email);
  const v = s.email.view();
  assert.equal(v.account, "rocky@outlook.com");
  assert.deepEqual(v.to, ["rocky@outlook.com"], "the signed-in account is the first recipient");
  assert.equal(v.signIn, null);
  const raw = readFileSync(s.file, "utf8");
  assert.ok(!raw.includes("r0"), "the refresh token isn't in the file as typed");
  assert.equal(unseal(JSON.parse(raw).token, KEY), "r0");
  assert.deepEqual(s.audits, ["email-connect"]);
});

test("sending renews when needed and keeps Microsoft's new refresh token", async () => {
  const s = setup();
  await s.email.start(who);
  await s.email.keepAlive(); // not due yet: nothing renews
  assert.ok(s.live.has("r0"));
  await settle(s.email);
  await s.email.send("Backup failed", "vzdump of 101 failed");
  assert.equal(s.sent[0]?.token, "a0", "the token from sign-in is used while it lasts");
  const saved = JSON.parse(readFileSync(s.file, "utf8"));
  saved.renewedAt -= RENEW_EVERY_MS + 1;
  writeFileSync(s.file, JSON.stringify(saved));
  await s.email.keepAlive();
  assert.equal(unseal(JSON.parse(readFileSync(s.file, "utf8")).token, KEY), "r1", "the rotated token replaced the old one");
  await s.email.send("Again", "x");
  assert.equal(s.sent[1]?.token, "a1");
});

test("a refused renewal is written down for Health check, and sending says why", async () => {
  const s = setup({ renewRefuses: true });
  await s.email.start(who);
  await settle(s.email);
  const saved = JSON.parse(readFileSync(s.file, "utf8"));
  saved.renewedAt = 0;
  writeFileSync(s.file, JSON.stringify(saved));
  await s.email.keepAlive();
  assert.match(s.email.view().failed ?? "", /Connect the account again/);
  await assert.rejects(s.email.send("x", "y"), /grant expired/);
  assert.equal(s.sent.length, 0);
});

test("a sign-in sealed with another key isn't used", async () => {
  const s = setup();
  await s.email.start(who);
  await settle(s.email);
  const saved = JSON.parse(readFileSync(s.file, "utf8"));
  saved.token = seal("r0", OTHER);
  saved.renewedAt = 0;
  writeFileSync(s.file, JSON.stringify(saved));
  await s.email.keepAlive();
  assert.match(s.email.view().failed ?? "", /can't open/);
});

test("without a key, or without permission, nothing starts", async () => {
  await assert.rejects(setup({}, { key: null }).email.start(who), /Update BossMox/);
  await assert.rejects(setup({}, { canChange: false }).email.start(who), /can't change where alerts go/);
});

test("turning email off deletes the sealed token", async () => {
  const s = setup();
  await s.email.start(who);
  await settle(s.email);
  assert.ok(existsSync(s.file));
  await s.email.remove(who);
  assert.ok(!existsSync(s.file));
  assert.equal(s.email.view().account, null);
});

test("recipients replace the list and are checked first", async () => {
  const s = setup();
  await s.email.start(who);
  await settle(s.email);
  await s.email.recipients(who, "ops@example.com, rocky@outlook.com");
  assert.deepEqual(s.email.view().to, ["ops@example.com", "rocky@outlook.com"]);
  await assert.rejects(s.email.recipients(who, "bad"), /isn't an email/);
  assert.deepEqual(s.email.view().to, ["ops@example.com", "rocky@outlook.com"]);
});

/** Microsoft's answers, recorded as the requests BossMox makes. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown }[]>) {
  const calls: { url: string; body?: string; auth?: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, ...(init.body ? { body: init.body } : {}), ...(init.headers.Authorization ? { auth: init.headers.Authorization } : {}) });
    const key = Object.keys(answers).find((k) => url.includes(k)) as string;
    const a = answers[key]?.shift() ?? { status: 500 };
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? "" : JSON.stringify(a.body)) };
  };
  return { fetcher, calls };
}

test("the Outlook client asks for exactly send, profile and staying signed in", async () => {
  const f = fakeFetch({ devicecode: [{ status: 200, body: { device_code: "d", user_code: "U", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 } }] });
  const o = createOutlook("client-1", f.fetcher);
  const c = await o.startSignIn();
  assert.equal(c.userCode, "U");
  const sent = new URLSearchParams(f.calls[0]?.body);
  assert.equal(sent.get("client_id"), "client-1");
  assert.equal(sent.get("scope"), "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read");
  assert.ok(f.calls[0]?.url.includes("/common/"), "any account, personal or work");
});

test("polling waits, slows down, and hands back the tokens", async () => {
  const f = fakeFetch({
    token: [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "A", refresh_token: "R", expires_in: 3600 } },
      { status: 400, body: { error: "expired_token", error_description: "AADSTS70020: The provided value for the input parameter 'device_code' is not valid.\r\nTrace ID: x" } },
    ],
  });
  const o = createOutlook("c", f.fetcher);
  assert.deepEqual(await o.poll("d"), { state: "waiting" });
  assert.deepEqual(await o.poll("d"), { state: "slower" });
  const done = await o.poll("d");
  assert.equal(done.state === "done" && done.tokens.refresh, "R");
  await assert.rejects(o.poll("d"), (e: OutlookError) => e.code === "expired_token" && !e.message.includes("Trace ID"));
});

test("sending posts one message to every recipient and doesn't keep a copy in Sent", async () => {
  const f = fakeFetch({ sendMail: [{ status: 202 }, { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } }] });
  const o = createOutlook("c", f.fetcher);
  await o.send("A", ["x@y.com", "z@y.com"], "Subject", "Body");
  const body = JSON.parse(f.calls[0]?.body ?? "{}");
  assert.equal(f.calls[0]?.auth, "Bearer A");
  assert.deepEqual(
    body.message.toRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address),
    ["x@y.com", "z@y.com"],
  );
  assert.equal(body.saveToSentItems, false);
  await assert.rejects(o.send("A", ["x@y.com"], "S", "B"), /Access is denied/);
});
