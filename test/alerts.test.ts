import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/auth.js";
import { createAlerts, matcherForm, readAlerts, scrub, targetForm } from "../src/alerts.js";
import { PveError, type PveClient } from "../src/pve.js";

const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const base = { updates: true, allBackups: false };
const DISCORD = "https://discord.com/api/webhooks/123456789/AbCdEfSecretToken";

test("Discord: only the host is readable; the private path is a Proxmox secret; the body is JSON (ADR 0038)", () => {
  const { type, form } = targetForm({ kind: "discord", link: DISCORD, ...base });
  assert.equal(type, "webhook");
  assert.equal(form.url, "https://discord.com/{{ secrets.path }}");
  assert.deepEqual(
    (form.secret as string[]).map((s) => s.split(",value=").map((x, i) => (i ? unb64(x) : x))),
    [["name=path", "api/webhooks/123456789/AbCdEfSecretToken"]],
  );
  assert.equal(JSON.stringify(form).includes("AbCdEfSecretToken"), false, "the token appears only base64'd, inside the secret");
  assert.match(unb64(form.body as string), /^\{"embeds": \[\{"title": \{\{ json title \}\}/);
});

test("Teams keeps its query string private too; Slack has its own shape", () => {
  const teams = targetForm({ kind: "teams", link: "https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRETSIG", ...base });
  assert.equal(teams.form.url, "https://prod-12.westus.logic.azure.com/{{ secrets.path }}");
  assert.match(unb64((teams.form.secret as string[])[0]?.split(",value=")[1] ?? ""), /\?api-version=1&sig=SECRETSIG$/);
  assert.match(unb64(teams.form.body as string), /AdaptiveCard/);
  assert.match(unb64(targetForm({ kind: "slack", link: "https://hooks.slack.com/services/T0/B0/XYZsecret", ...base }).form.body as string), /^\{"text": \{\{ json title \}\}/);
});

test("ntfy: the topic is a secret, the token goes in a header by reference; Gotify uses Proxmox's own target", () => {
  const n = targetForm({ kind: "ntfy", topic: "rocky-lab-x9", token: "tk_123", ...base });
  assert.equal(n.form.url, "https://ntfy.sh/{{ secrets.topic }}");
  const headers = (n.form.header as string[]).map((h) => [h.split(",")[0], unb64(h.split(",value=")[1] ?? "")]);
  assert.deepEqual(headers, [
    ["name=Title", "{{ title }}"],
    ["name=Tags", "{{ severity }}"],
    ["name=Authorization", "Bearer {{ secrets.token }}"],
  ]);
  assert.equal(JSON.stringify(n.form).includes("tk_123") || JSON.stringify(n.form).includes("rocky-lab-x9"), false);
  assert.equal(
    targetForm({ kind: "ntfy", server: "http://10.0.30.248:8080", topic: "lab", ...base }).form.url,
    "http://10.0.30.248:8080/{{ secrets.topic }}",
    "plain http only on the person's own network",
  );
  assert.deepEqual(targetForm({ kind: "gotify", server: "https://push.example.org/", token: "AppTok", ...base }), {
    type: "gotify",
    form: { server: "https://push.example.org", comment: "Added by BossMox: Gotify", token: "AppTok" },
  });
});

test("refused: plain http to the internet, a link from the wrong service, a link without its private part, a bad topic", () => {
  const bad = (input: Parameters<typeof targetForm>[0]) =>
    assert.throws(
      () => targetForm(input),
      (e: { status: number }) => e.status === 400,
    );
  bad({ kind: "ntfy", server: "http://ntfy.example.com", topic: "x1", ...base });
  bad({ kind: "discord", link: "https://hooks.slack.com/services/T0/B0/X", ...base });
  bad({ kind: "slack", link: "https://hooks.slack.com/", ...base });
  bad({ kind: "ntfy", topic: "has space", ...base });
  bad({ kind: "discord", link: "https://user:pw@discord.com/api/webhooks/1/x", ...base });
});

test("the matcher: failures and warnings always; updates and every backup by choice", () => {
  assert.deepEqual(matcherForm({ updates: false, allBackups: false })["match-severity"], ["warning", "error"]);
  assert.equal(matcherForm({ updates: false, allBackups: false })["match-field"], undefined);
  assert.deepEqual(matcherForm({ updates: true, allBackups: true })["match-field"], ["exact:type=package-updates", "exact:type=vzdump"]);
  assert.equal(matcherForm(base).mode, "any");
});

test("reading what's set up: a fresh Proxmox delivers nowhere; BossMox's target, confirmed or not; someone else's", () => {
  const builtin = { name: "mail-to-root", type: "sendmail", origin: "builtin" };
  const defaultMatcher = { name: "default-matcher", target: ["mail-to-root"] };
  assert.equal(readAlerts([builtin], [defaultMatcher], null, null, null).nothingDelivers, true);
  assert.equal(readAlerts([builtin], [defaultMatcher], "ops@example.org", null, null).nothingDelivers, false, "root has an email address");
  const mine = { name: "bossmox-alerts-target", type: "webhook", comment: "Added by BossMox: Discord" };
  const v = readAlerts(
    [builtin, mine],
    [defaultMatcher, { name: "bossmox-alerts", target: ["bossmox-alerts-target"], "match-field": ["exact:type=package-updates"] }],
    null,
    "https://discord.com/{{ secrets.path }}",
    null,
  );
  assert.deepEqual([v.kind, v.where, v.confirmed, v.updates, v.allBackups, v.nothingDelivers], ["discord", "discord.com", false, true, false, false]);
  assert.equal(
    readAlerts([builtin, { ...mine, comment: "Added by BossMox: Discord; test arrived 2026-11-13" }], [{ name: "bossmox-alerts", target: "bossmox-alerts-target" }], null, null, null).confirmed,
    true,
  );
  assert.deepEqual(readAlerts([builtin, { name: "ops-gotify", type: "gotify" }], [{ name: "m", target: ["ops-gotify"] }], null, null, null).others, ["ops-gotify"]);
});

test("scrub takes a secret out in every form it could come back in", () => {
  const msg = `bad value ${Buffer.from("tk_123").toString("base64")} and tk_123 and ${Buffer.from("api/webhooks/1/AbC").toString("base64")}`;
  assert.equal(scrub(msg, ["tk_123", "https://discord.com/api/webhooks/1/AbC"]), "bad value [hidden] and [hidden] and [hidden]");
});

function fake(opts: { existing?: string; failWith?: string } = {}) {
  const calls: { m: string; path: string; form?: unknown }[] = [];
  const audits: string[] = [];
  let matcher = !!opts.existing;
  const pve = {
    get: async (path: string) => {
      if (path === "/cluster/notifications/targets") return opts.existing ? [{ name: "bossmox-alerts-target", type: "webhook", comment: `Added by BossMox: ${opts.existing}` }] : [];
      if (path === "/cluster/notifications/matchers") return matcher ? [{ name: "bossmox-alerts", target: ["bossmox-alerts-target"] }] : [];
      throw new Error(`unexpected ${path}`);
    },
    post: async (path: string, _w: unknown, form: unknown) => {
      calls.push({ m: "POST", path, form });
      if (opts.failWith) throw new PveError(400, opts.failWith);
      return null;
    },
    put: async (path: string, _w: unknown, form: unknown) => {
      calls.push({ m: "PUT", path, form });
      return null;
    },
    delete: async (path: string) => {
      calls.push({ m: "DELETE", path });
      if (path.endsWith("/matchers/bossmox-alerts")) matcher = false;
      return null;
    },
  } as unknown as PveClient;
  const a = createAlerts({ pve, viaProxy: false, audit: (e, _w, d) => audits.push(`${e} ${JSON.stringify(d)}`) });
  return { a, calls, audits };
}
const root = { username: "root@pam", ticket: "T" } as Session;

test("save: a webhook target then the matcher; the audit line never holds a secret", async () => {
  const { a, calls, audits } = fake();
  await a.save(root, { kind: "discord", link: DISCORD, ...base });
  assert.deepEqual(
    calls.map((c) => `${c.m} ${c.path}`),
    ["POST /cluster/notifications/endpoints/webhook", "POST /cluster/notifications/matchers"],
  );
  assert.equal(
    audits.some((x) => x.includes("AbCdEf") || x.includes("webhooks")),
    false,
  );
});

test("save: only the choices changed keeps the target and its secrets; a new kind replaces it", async () => {
  const same = fake({ existing: "Discord" });
  await same.a.save(root, { kind: "discord", updates: false, allBackups: false });
  assert.deepEqual(
    same.calls.map((c) => `${c.m} ${c.path}`),
    ["PUT /cluster/notifications/matchers/bossmox-alerts"],
  );
  const other = fake({ existing: "Discord" });
  await other.a.save(root, { kind: "ntfy", topic: "lab-topic-1", ...base });
  assert.deepEqual(
    other.calls.map((c) => `${c.m} ${c.path}`),
    [
      "DELETE /cluster/notifications/matchers/bossmox-alerts",
      "DELETE /cluster/notifications/endpoints/webhook/bossmox-alerts-target",
      "POST /cluster/notifications/endpoints/webhook",
      "POST /cluster/notifications/matchers",
    ],
  );
});

test("an error from Proxmox comes back without the secret in it", async () => {
  const { a } = fake({ failWith: "value 'api/webhooks/123456789/AbCdEfSecretToken' is not allowed" });
  await assert.rejects(a.save(root, { kind: "discord", link: DISCORD, ...base }), (e: { message: string }) => !e.message.includes("AbCdEf") && e.message.includes("[hidden]"));
});
