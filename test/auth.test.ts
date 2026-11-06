import assert from "node:assert/strict";
import { test } from "node:test";
import { Terminals } from "../src/terminal.js";
import { clientAddress } from "../src/config.js";
import { AuthError, Sessions, type LoginClient } from "../src/auth.js";
import { PveError, type LoginResult } from "../src/pve.js";

const HOUR = 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const ok = (ticket = "T1"): LoginResult => ({ username: "a@pve", ticket, csrf: `C-${ticket}`, needsCode: false });
const client = (fn: LoginClient["login"]): LoginClient => ({ login: fn });
const wrong = async (): Promise<LoginResult> => {
  throw new PveError(401, "no");
};

test("a good login returns a random ID and never the ticket", async () => {
  const s = new Sessions(client(async () => ok("SECRET")));
  const out = await s.login("a@pve", "pw", "1.1.1.1");
  assert.equal(out.kind, "ok");
  assert.ok(out.id.length >= 40);
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  assert.equal((await s.get(out.id))?.ticket, "SECRET");
});

test("a wrong password is refused with a plain message", async () => {
  const s = new Sessions(client(wrong));
  await assert.rejects(s.login("a@pve", "bad", "1.1.1.1"), (e: AuthError) => e.status === 401 && /Wrong username/.test(e.message));
});

test("ten failures from one address lock it out, others stay open", async () => {
  const s = new Sessions(client(wrong));
  for (let i = 0; i < 10; i++) await assert.rejects(s.login("a@pve", "bad", "1.1.1.1"), AuthError);
  await assert.rejects(s.login("a@pve", "bad", "1.1.1.1"), (e: AuthError) => e.status === 429);
  await assert.rejects(s.login("a@pve", "bad", "2.2.2.2"), (e: AuthError) => e.status === 401);
});

test("2FA needs the code, sends the challenge, and works once", async () => {
  const calls: [string, string | undefined][] = [];
  const s = new Sessions(client(async (_u, pw, ch) => {
    calls.push([pw, ch]);
    return ch ? ok("FULL") : { username: "a@pve", ticket: "CHALLENGE", csrf: "", needsCode: true };
  }));
  const first = await s.login("a@pve", "pw", "1.1.1.1");
  assert.equal(first.kind, "code");
  assert.equal(await s.get(first.id), undefined, "a challenge is not a session");
  const done = await s.submitCode(first.id, "123456", "1.1.1.1");
  assert.deepEqual(calls[1], ["totp:123456", "CHALLENGE"]);
  assert.equal((await s.get(done.id))?.ticket, "FULL");
  await assert.rejects(s.submitCode(first.id, "123456", "1.1.1.1"), AuthError);
});

test("tickets renew after an hour and sessions end after 12", async () => {
  let t = 0;
  const seen: string[] = [];
  const s = new Sessions(client(async (_u, pw) => {
    seen.push(pw);
    return ok(`T${seen.length}`);
  }), () => t);
  const out = await s.login("a@pve", "pw", "1.1.1.1");
  t = HOUR + 1;
  const renewed = await s.get(out.id);
  assert.equal(renewed?.ticket, "T2");
  assert.equal(renewed?.csrf, "C-T2", "the CSRF token renews with the ticket");
  assert.equal(seen[1], "T1", "the old ticket renews it, the password is not kept");
  t = 12 * HOUR + 1;
  assert.equal(await s.get(out.id), undefined);
});

test("a refused renewal ends the session, an outage does not", async () => {
  let t = 0;
  let mode: "ok" | "refuse" | "down" = "ok";
  const s = new Sessions(client(async () => {
    if (mode === "refuse") throw new PveError(401, "no");
    if (mode === "down") throw new Error("connect failed");
    return ok();
  }), () => t);
  const out = await s.login("a@pve", "pw", "1.1.1.1");
  t = HOUR + 1;
  mode = "down";
  assert.ok(await s.get(out.id));
  mode = "refuse";
  assert.equal(await s.get(out.id), undefined);
});

test("signing out ends the session", async () => {
  const s = new Sessions(client(async () => ok()));
  const out = await s.login("a@pve", "pw", "1.1.1.1");
  s.end(out.id);
  assert.equal(await s.get(out.id), undefined);
});

test("consoles close when a session ends, whichever way it ended", async () => {
  const ended: string[] = [];
  const signIn = async (sessions: Sessions) => {
    const out = await sessions.login("root@pam", "pw", "1.1.1.1");
    assert.notEqual(out.kind, "code");
    return (out as { id: string }).id;
  };
  let clock = 1000;
  const client = { login: async () => ({ username: "root@pam", ticket: "t", csrf: "c", needsCode: false }) };
  const sessions = new Sessions(client, () => clock);
  sessions.onEnd = (s) => ended.push(s.username);
  sessions.end(await signIn(sessions));
  assert.equal(ended.length, 1, "signing out");
  const second = await signIn(sessions);
  clock += 13 * 60 * 60 * 1000;
  assert.equal(await sessions.get(second), undefined);
  assert.equal(ended.length, 2, "running out of time");
  sessions.end("no such session");
  assert.equal(ended.length, 2, "nothing to end");
});

test("a session's open consoles and unclaimed links all go when it ends", () => {
  const terminals = new Terminals({ pveUrl: new URL("https://x"), pveCa: undefined, pveTlsName: undefined } as never);
  const mine = { username: "a" } as never;
  const theirs = { username: "b" } as never;
  const closed: string[] = [];
  terminals.track(mine, () => closed.push("mine 1"));
  const gone = terminals.track(mine, () => closed.push("already closed"));
  terminals.track(mine, () => closed.push("mine 2"));
  terminals.track(theirs, () => closed.push("theirs"));
  gone();
  const link = terminals.prepare("node", mine, { port: 1, ticket: "t", user: "u", upid: "x" });
  terminals.closeSession(mine);
  assert.deepEqual(closed, ["mine 1", "mine 2"]);
  assert.equal(terminals.claim(link, mine), undefined, "a link made before sign-out stops working");
});

test("signing out during a ticket renewal still ends the session", async () => {
  let clock = 1000;
  let release = (_: LoginResult) => {};
  let renewals = 0;
  const sessions = new Sessions(client(async () => {
    renewals += 1;
    if (renewals === 1) return ok();
    return new Promise<LoginResult>((resolve) => { release = resolve; });
  }), () => clock);
  const out = await sessions.login("a", "b", "1.1.1.1");
  clock += 2 * HOUR;
  const pending = sessions.get(out.id);
  sessions.end(out.id);
  release(ok("T2"));
  assert.equal(await pending, undefined);
});

test("a burst of guesses sent at once can't get past the limit", async () => {
  let reached = 0;
  const s = new Sessions(client(async () => {
    reached += 1;
    await new Promise((r) => setTimeout(r, 5));
    throw new PveError(401, "no");
  }));
  const out = await Promise.allSettled(Array.from({ length: 50 }, () => s.login("a@pve", "bad", "1.1.1.1")));
  assert.equal(reached, 10);
  assert.equal(out.filter((o) => o.status === "rejected" && (o.reason as AuthError).status === 429).length, 40);
});

test("a success takes its attempt back, and an unreachable Proxmox doesn't count", async () => {
  const s = new Sessions(client(async () => ok()));
  for (let i = 0; i < 25; i++) await s.login("a@pve", "pw", "1.1.1.1");
  const down = new Sessions(client(async () => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }));
  for (let i = 0; i < 25; i++) await assert.rejects(down.login("a@pve", "pw", "1.1.1.1"), /refused/);
});

test("a timeout still counts as a guess", async () => {
  const s = new Sessions(client(async () => {
    throw new Error("Proxmox took too long to answer");
  }));
  for (let i = 0; i < 10; i++) await assert.rejects(s.login("a@pve", "bad", "1.1.1.1"), /too long/);
  await assert.rejects(s.login("a@pve", "bad", "1.1.1.1"), (e: AuthError) => e.status === 429);
});

test("rotating addresses still hits the limit on the account", async () => {
  const s = new Sessions(client(wrong));
  for (let i = 0; i < 50; i++) await assert.rejects(s.login("a@pve", "bad", `10.0.0.${i}`), (e: AuthError) => e.status === 401);
  await assert.rejects(s.login("A@PVE", "bad", "10.0.1.1"), (e: AuthError) => e.status === 429, "case doesn't dodge it");
  await assert.rejects(s.login("b@pve", "bad", "10.0.1.1"), (e: AuthError) => e.status === 401, "other accounts are fine");
});

test("a 2FA challenge dies after five wrong codes, even from new addresses", async () => {
  const s = new Sessions(client(async (_u, _p, ch) => {
    if (ch) throw new PveError(500, "bad code");
    return { username: "a@pve", ticket: "CHALLENGE", csrf: "", needsCode: true };
  }));
  const first = await s.login("a@pve", "pw", "1.1.1.1");
  for (let i = 0; i < 5; i++) await assert.rejects(s.submitCode(first.id, "000000", `9.9.9.${i}`), /didn't work/);
  await assert.rejects(s.submitCode(first.id, "000000", "9.9.8.1"), /timed out/);
  await assert.rejects(s.submitCode(first.id, "000000", "9.9.8.2"), /timed out/, "and it stays dead");
});

test("old failure records don't pile up", async () => {
  let clock = 1000;
  const s = new Sessions(client(wrong), () => clock);
  for (let i = 0; i < 40; i++) await assert.rejects(s.login(`u${i}@pve`, "bad", `10.0.0.${i}`), AuthError);
  const fails = (s as unknown as { fails: Map<string, unknown> }).fails;
  assert.equal(fails.size, 80);
  clock += FIVE_MIN + 1;
  await assert.rejects(s.login("x@pve", "bad", "10.9.9.9"), AuthError);
  assert.equal(fails.size, 2);
});

const trusted = new Set(["10.0.0.5"]);

test("X-Forwarded-For is only believed from the trusted proxy", () => {
  assert.equal(clientAddress("1.2.3.4", "9.9.9.9", trusted), "1.2.3.4", "anyone else can't forge it");
  assert.equal(clientAddress("10.0.0.5", "1.2.3.4", trusted), "1.2.3.4");
  assert.equal(clientAddress("::ffff:10.0.0.5", "1.2.3.4", trusted), "1.2.3.4");
  assert.equal(clientAddress("10.0.0.5", undefined, trusted), "10.0.0.5");
});

test("a client can't forge its way past the proxy's own entry", () => {
  assert.equal(clientAddress("10.0.0.5", "9.9.9.9, 1.2.3.4", trusted), "1.2.3.4", "the proxy adds the real one on the right");
  assert.equal(clientAddress("10.0.0.5", "1.2.3.4, 10.0.0.5", trusted), "1.2.3.4", "skips trusted hops");
  assert.equal(clientAddress("1.2.3.4", "9.9.9.9", new Set()), "1.2.3.4", "with nothing trusted the header is ignored");
});
