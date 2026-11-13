/**
 * Alerts through Proxmox's own notifications (ADR 0038): one target and one matcher that BossMox adds, for ntfy,
 * Discord, Slack, Teams or Gotify. Proxmox sends the alerts, so they arrive even when BossMox is down.
 *
 * Secrets (a token, the private part of a webhook link) go to Proxmox's root-only private config through Proxmox's
 * API over HTTPS. BossMox keeps them nowhere: not in a file, a log, an audit line, or an answer to the page.
 */
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import type { Form, PveClient } from "./pve.js";

export const TARGET = "bossmox-alerts-target";
export const MATCHER = "bossmox-alerts";

export type AlertKind = "ntfy" | "discord" | "slack" | "teams" | "gotify";
export const KINDS: AlertKind[] = ["ntfy", "discord", "slack", "teams", "gotify"];
export const KIND_NAMES: Record<AlertKind, string> = { ntfy: "ntfy", discord: "Discord", slack: "Slack", teams: "Microsoft Teams", gotify: "Gotify" };

export interface AlertInput {
  kind: AlertKind;
  /** ntfy and Gotify: the server, "https://ntfy.sh" by default for ntfy. */
  server?: string;
  /** ntfy: the topic, kept secret, since anyone who knows it can read it. */
  topic?: string;
  /** Discord, Slack, Teams: the webhook link the service gives. */
  link?: string;
  /** ntfy (optional) and Gotify: an access token. */
  token?: string;
  updates: boolean;
  allBackups: boolean;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const secret = (name: string, value: string) => `name=${name},value=${b64(value)}`;
const header = (name: string, value: string) => `name=${name},value=${b64(value)}`;

/** A web address BossMox will send secrets toward: https only, except a plain address on the person's own network. */
function parseServer(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, `That ${what} isn't a web address. It starts with https://.`);
  }
  const local = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(u.hostname) || u.hostname.endsWith(".lan") || u.hostname.endsWith(".local");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new HttpError(400, `That ${what} has to start with https://, so what Proxmox sends is encrypted.`);
  if (u.username || u.password) throw new HttpError(400, `Leave the name and password out of the ${what}.`);
  return u;
}

const LINK_HOSTS: Record<"discord" | "slack" | "teams", RegExp> = {
  discord: /^(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)$/,
  slack: /^hooks\.slack\.com$/,
  // Teams' Workflows links come from Power Automate and Logic Apps hosts.
  teams: /(\.logic\.azure\.com|\.powerplatform\.com|\.office\.com|\.webhook\.office\.com)$/,
};

/** The Proxmox target form for one choice. With `keepSecrets`, no secret is sent and Proxmox keeps the ones it has. */
export function targetForm(input: AlertInput, keepSecrets = false): { type: "webhook" | "gotify"; form: Form } {
  const comment = `Added by BossMox: ${KIND_NAMES[input.kind]}`;
  if (input.kind === "gotify") {
    const server = parseServer(input.server ?? "", "Gotify address");
    if (!keepSecrets && !input.token) throw new HttpError(400, "Paste the Gotify app token.");
    return { type: "gotify", form: { server: server.origin + server.pathname.replace(/\/$/, ""), comment, ...(keepSecrets ? {} : { token: input.token as string }) } };
  }
  if (input.kind === "ntfy") {
    const server = parseServer(input.server || "https://ntfy.sh", "ntfy server");
    const topic = (input.topic ?? "").trim();
    if (!keepSecrets && !/^[\w-]{1,64}$/.test(topic)) throw new HttpError(400, "Pick a topic: letters, numbers, - and _ only. Make it hard to guess, since anyone who knows it can read it.");
    const secrets = keepSecrets ? [] : [secret("topic", topic), ...(input.token ? [secret("token", input.token)] : [])];
    const headers = [header("Title", "{{ title }}"), header("Tags", "{{ severity }}")];
    if (input.token) headers.push(header("Authorization", "Bearer {{ secrets.token }}"));
    return {
      type: "webhook",
      form: {
        method: "post",
        url: `${server.origin}${server.pathname.replace(/\/$/, "")}/{{ secrets.topic }}`,
        header: headers,
        body: b64("{{ message }}"),
        comment,
        ...(secrets.length ? { secret: secrets } : {}),
      },
    };
  }
  const link = parseServer(input.link ?? "", `${KIND_NAMES[input.kind]} link`);
  if (!keepSecrets && !LINK_HOSTS[input.kind].test(link.hostname))
    throw new HttpError(400, `That doesn't look like a ${KIND_NAMES[input.kind]} webhook link. Paste the whole link the channel's webhook settings give.`);
  // The link's path (and query, for Teams) is what lets anyone post, so only the host is in Proxmox's readable config.
  const path = `${link.pathname.slice(1)}${link.search}`;
  if (!keepSecrets && path.length < 10) throw new HttpError(400, `That ${KIND_NAMES[input.kind]} link is missing its private part. Paste the whole link.`);
  const body =
    input.kind === "discord"
      ? '{"embeds": [{"title": {{ json title }}, "description": {{ json message }}}]}'
      : input.kind === "slack"
        ? '{"text": {{ json title }}, "attachments": [{"text": {{ json message }}}]}'
        : '{"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": {"type": "AdaptiveCard", "version": "1.4", "body": [{"type": "TextBlock", "text": {{ json title }}, "weight": "bolder", "wrap": true}, {"type": "TextBlock", "text": {{ json message }}, "wrap": true}]}}]}';
  return {
    type: "webhook",
    form: {
      method: "post",
      url: `${link.origin}/{{ secrets.path }}`,
      header: [header("Content-Type", "application/json")],
      body: b64(body),
      comment,
      ...(keepSecrets ? {} : { secret: [secret("path", path)] }),
    },
  };
}

/** Which of Proxmox's messages go to the target: failures and warnings always, the rest by choice. */
export function matcherForm(input: { updates: boolean; allBackups: boolean }): Form {
  const fields = [...(input.updates ? ["exact:type=package-updates"] : []), ...(input.allBackups ? ["exact:type=vzdump"] : [])];
  return {
    target: TARGET,
    mode: "any",
    "match-severity": ["warning", "error"],
    ...(fields.length ? { "match-field": fields } : {}),
    comment: "Added by BossMox: failures and warnings, and what was chosen in Settings",
  };
}

interface RawTarget {
  name: string;
  type?: string;
  origin?: string;
  disable?: number;
  comment?: string;
}
interface RawMatcher {
  name: string;
  target?: string[] | string;
  disable?: number;
  "match-field"?: string[] | string;
}
const list = (v: string[] | string | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export interface AlertsView {
  /** BossMox's target, if there is one. */
  kind: AlertKind | null;
  where: string | null;
  confirmed: boolean;
  updates: boolean;
  allBackups: boolean;
  /** Nothing would tell anyone: only the built-in mail target, and root@pam has no email address. */
  nothingDelivers: boolean;
  /** Someone else's targets that do deliver, so BossMox doesn't call it unset. */
  others: string[];
}

/** What's set up, read from Proxmox's notification config. Pure, for the Health check and Settings. */
export function readAlerts(targets: RawTarget[], matchers: RawMatcher[], rootEmail: string | null, webhookUrl: string | null, gotifyServer: string | null): AlertsView {
  const mine = targets.find((t) => t.name === TARGET);
  const m = matchers.find((x) => x.name === MATCHER);
  const kind = mine?.comment ? (KINDS.find((k) => mine.comment?.includes(`BossMox: ${KIND_NAMES[k]}`)) ?? null) : null;
  const routed = new Set(matchers.filter((x) => x.disable !== 1).flatMap((x) => list(x.target)));
  const delivering = targets.filter((t) => t.disable !== 1 && routed.has(t.name) && (t.origin !== "builtin" || !!rootEmail));
  const fields = list(m?.["match-field"]);
  return {
    kind: mine && mine.disable !== 1 ? kind : null,
    where: kind ? (kind === "gotify" ? gotifyServer : webhookUrl ? new URL(webhookUrl.replace("{{ secrets.topic }}", "").replace("{{ secrets.path }}", "")).host : null) : null,
    confirmed: !!mine?.comment?.includes("test arrived"),
    updates: fields.includes("exact:type=package-updates"),
    allBackups: fields.includes("exact:type=vzdump"),
    nothingDelivers: delivering.length === 0,
    others: delivering.filter((t) => t.name !== TARGET).map((t) => t.name),
  };
}

/** A message with every secret, as typed or in base64, replaced. */
export function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s.length < 4) continue;
    for (const form of [s, b64(s), encodeURIComponent(s)]) out = out.split(form).join("[hidden]");
    try {
      const u = new URL(s);
      const priv = `${u.pathname.slice(1)}${u.search}`;
      if (priv.length >= 4) for (const form of [priv, b64(priv)]) out = out.split(form).join("[hidden]");
    } catch {
      /* not a link */
    }
  }
  return out;
}

export interface AlertsDeps {
  pve: PveClient;
  /** BossMox serves plain HTTP behind someone's own HTTPS proxy: the hop from that proxy is theirs. */
  viaProxy: boolean;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
}

export function createAlerts(deps: AlertsDeps) {
  const { pve } = deps;

  /** Changing where alerts go needs Proxmox's own right to change notification targets. Email asks the same question. */
  async function canChange(session: Session): Promise<boolean> {
    const perms = await pve
      .get<Record<string, Record<string, number>>>("/access/permissions?path=%2Fmapping%2Fnotifications", session.ticket)
      .catch((): Record<string, Record<string, number>> => ({}));
    return perms["/mapping/notifications"]?.["Mapping.Modify"] === 1;
  }

  async function view(session: Session): Promise<AlertsView & { canChange: boolean; viaProxy: boolean }> {
    const t = session.ticket;
    const [targets, matchers, root, change] = await Promise.all([
      pve.get<RawTarget[]>("/cluster/notifications/targets", t),
      pve.get<RawMatcher[]>("/cluster/notifications/matchers", t),
      pve.get<{ email?: string }>("/access/users/root@pam", t).catch(() => ({ email: undefined })),
      canChange(session),
    ]);
    const mine = targets.find((x) => x.name === TARGET);
    const detail = mine
      ? await pve.get<{ url?: string; server?: string }>(`/cluster/notifications/endpoints/${mine.type}/${TARGET}`, t).catch(() => ({ url: undefined, server: undefined }))
      : { url: undefined, server: undefined };
    return {
      ...readAlerts(targets, matchers, root.email ?? null, detail.url ?? null, detail.server ?? null),
      canChange: change,
      viaProxy: deps.viaProxy,
    };
  }

  /** Adds or changes BossMox's target and matcher, with every secret taken out of any error Proxmox gives back. */
  async function save(session: Session, input: AlertInput) {
    try {
      await saveInner(session, input);
    } catch (err) {
      const secrets = [input.token, input.topic, input.link].filter((s): s is string => !!s);
      if (err instanceof HttpError) throw new HttpError(err.status, scrub(err.message, secrets));
      throw new HttpError(502, `Proxmox didn't take the settings: ${scrub((err as Error).message, secrets)}`);
    }
  }

  /** Adds or changes BossMox's target and matcher. Empty secrets on a change keep the ones Proxmox has. */
  async function saveInner(session: Session, input: AlertInput) {
    const t = session.ticket;
    const targets = await pve.get<RawTarget[]>("/cluster/notifications/targets", t);
    const mine = targets.find((x) => x.name === TARGET);
    const sameKind = mine?.comment?.includes(`BossMox: ${KIND_NAMES[input.kind]}`);
    // Only the choices changed: the target, and the secrets in it, stay as they are. A new destination means pasting
    // its link or token again, so nothing half-old is left behind.
    const keep = !!sameKind && !input.token && !input.topic && !input.link;
    const { type, form } = keep ? { type: mine?.type ?? "webhook", form: {} } : targetForm(input);
    if (mine && !sameKind) {
      // A different kind is a different target type in Proxmox: the matcher goes first, then the old target.
      await pve.delete<null>(`/cluster/notifications/matchers/${MATCHER}`, session).catch(() => null);
      await pve.delete<null>(`/cluster/notifications/endpoints/${mine.type}/${TARGET}`, session);
    }
    if (mine && sameKind) {
      if (!keep) await pve.put<null>(`/cluster/notifications/endpoints/${type}/${TARGET}`, session, form);
    } else await pve.post<null>(`/cluster/notifications/endpoints/${type}`, session, { name: TARGET, ...form });
    const matchers = await pve.get<RawMatcher[]>("/cluster/notifications/matchers", t);
    const mform = matcherForm(input);
    if (matchers.some((m) => m.name === MATCHER))
      await pve.put<null>(`/cluster/notifications/matchers/${MATCHER}`, session, { ...mform, ...(input.updates || input.allBackups ? {} : { delete: "match-field" }) });
    else await pve.post<null>("/cluster/notifications/matchers", session, { name: MATCHER, ...mform });
    deps.audit("alerts-save", session.username, { kind: input.kind, updates: input.updates ? 1 : 0, backups: input.allBackups ? 1 : 0 });
  }

  /** Proxmox's own test for the target. */
  async function test(session: Session) {
    await pve.post<null>(`/cluster/notifications/targets/${TARGET}/test`, session);
    deps.audit("alerts-test", session.username, {});
  }

  /** The person saw the test arrive: noted in the target's own comment, so BossMox keeps nothing itself. */
  async function confirm(session: Session) {
    const targets = await pve.get<RawTarget[]>("/cluster/notifications/targets", session.ticket);
    const mine = targets.find((x) => x.name === TARGET);
    if (!mine?.type) throw new HttpError(400, "Alerts aren't set up.");
    const base = (mine.comment ?? "").replace(/; test arrived.*$/, "");
    await pve.put<null>(`/cluster/notifications/endpoints/${mine.type}/${TARGET}`, session, { comment: `${base}; test arrived ${new Date().toISOString().slice(0, 10)}` });
  }

  /** Removes only BossMox's matcher and target. */
  async function remove(session: Session) {
    const targets = await pve.get<RawTarget[]>("/cluster/notifications/targets", session.ticket);
    const mine = targets.find((x) => x.name === TARGET);
    await pve.delete<null>(`/cluster/notifications/matchers/${MATCHER}`, session).catch(() => null);
    if (mine?.type) await pve.delete<null>(`/cluster/notifications/endpoints/${mine.type}/${TARGET}`, session);
    deps.audit("alerts-remove", session.username, {});
  }

  return { view, canChange, save, test, confirm, remove };
}
