/**
 * Alert email through Outlook (ADR 0040): what BossMox keeps, signing in by code, staying signed in, and sending.
 * The refresh token is kept sealed (sealed.ts) in /var/lib/bossmox/email.json. The access token lives only in memory.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Session } from "./auth.js";
import { HttpError } from "./http-error.js";
import { writeJsonAtomic } from "./json-file.js";
import { OutlookError, type DeviceCode, type Outlook } from "./outlook.js";
import { seal, unseal } from "./sealed.js";

export const emailPath = (env: NodeJS.ProcessEnv) => path.join(path.dirname(env.BOSSMOX_SETTINGS ?? "/var/lib/bossmox/settings.json"), "email.json");

/** Microsoft drops a refresh token unused for 90 days; renewing weekly keeps a quiet setup signed in. */
export const RENEW_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TO = 10;
const ADDRESS = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

interface Saved {
  account: string;
  to: string[];
  token: string;
  renewedAt: number;
  /** Why the last renewal or send failed, shown in Health check until it works again. */
  failed: string | null;
  by: string;
}

export interface EmailView {
  /** False when the install has no key yet: it needs updating before email can be set up. */
  ready: boolean;
  account: string | null;
  to: string[];
  failed: string | null;
  signIn: { code: string; link: string; expiresAt: number } | { error: string } | null;
}

export interface EmailDeps {
  file: string;
  key: Buffer | null;
  outlook: Outlook;
  canChange: (session: Session) => Promise<boolean>;
  audit: (event: string, who: string, detail: Record<string, string | number>) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** The addresses as typed, checked: commas, semicolons or spaces between them. */
export function parseAddresses(raw: string): string[] {
  const list = [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
  if (!list.length) throw new HttpError(400, "Type at least one email address.");
  if (list.length > MAX_TO) throw new HttpError(400, `At most ${MAX_TO} addresses.`);
  const bad = list.find((a) => a.length > 254 || !ADDRESS.test(a));
  if (bad) throw new HttpError(400, `"${bad}" isn't an email address.`);
  return list;
}

export function createEmail(deps: EmailDeps) {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pending: (DeviceCode & { by: string }) | { error: string } | null = null;
  let access: { token: string; until: number } | null = null;
  let busy: Promise<unknown> = Promise.resolve();

  const load = (): Saved | null => {
    if (!existsSync(deps.file)) return null;
    try {
      return JSON.parse(readFileSync(deps.file, "utf8")) as Saved;
    } catch {
      return null;
    }
  };
  const store = (s: Saved) => writeJsonAtomic(deps.file, s);
  const needKey = () => {
    if (!deps.key) throw new HttpError(400, "This BossMox install has no key to keep the sign-in safe with. Update BossMox, then set up email.");
    return deps.key;
  };
  const allowed = async (session: Session) => {
    if (!(await deps.canChange(session))) throw new HttpError(403, "Your Proxmox account can't change where alerts go.");
  };

  /** One renewal at a time: Microsoft hands out a new refresh token each time, and the old one stops working. */
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = busy.then(job, job);
    busy = next.catch(() => null);
    return next;
  };

  /** A working access token, renewing (and keeping the new refresh token) when needed. Records why if it can't. */
  function fresh(): Promise<string> {
    return serial(async () => {
      if (access && access.until - 60_000 > now()) return access.token;
      const key = needKey();
      const saved = load();
      if (!saved) throw new HttpError(400, "Email alerts aren't set up.");
      const refresh = unseal(saved.token, key);
      if (!refresh) {
        store({ ...saved, failed: "BossMox can't open its saved sign-in. Connect the account again." });
        throw new HttpError(400, "BossMox can't open its saved sign-in. Connect the account again.");
      }
      try {
        const t = await deps.outlook.renew(refresh);
        store({ ...saved, token: seal(t.refresh, key), renewedAt: now(), failed: null });
        access = { token: t.access, until: t.accessExpiresAt };
        return t.access;
      } catch (err) {
        // Losing sight of Microsoft isn't losing the sign-in. Only a refusal is written down.
        if (err instanceof OutlookError && err.code !== "unreachable") store({ ...saved, failed: `Microsoft stopped letting BossMox send: ${err.message} Connect the account again.` });
        throw new HttpError(502, (err as Error).message);
      }
    });
  }

  async function pollUntilDone(code: DeviceCode & { by: string }) {
    let interval = code.intervalMs;
    while (pending === code && now() < code.expiresAt) {
      await wait(interval);
      if (pending !== code) return;
      try {
        const r = await deps.outlook.poll(code.deviceCode);
        if (r.state === "slower") interval += 5000;
        if (r.state !== "done") continue;
        const account = await deps.outlook.account(r.tokens.access);
        const key = needKey();
        const before = load();
        store({ account, to: before?.account === account ? before.to : [account], token: seal(r.tokens.refresh, key), renewedAt: now(), failed: null, by: code.by });
        access = { token: r.tokens.access, until: r.tokens.accessExpiresAt };
        pending = null;
        deps.audit("email-connect", code.by, { account });
        return;
      } catch (err) {
        if (pending === code) pending = { error: (err as Error).message };
        return;
      }
    }
    if (pending === code) pending = { error: "The code ran out before it was used. Start again." };
  }

  return {
    view(): EmailView {
      const saved = load();
      const p = pending;
      return {
        ready: !!deps.key,
        account: saved?.account ?? null,
        to: saved?.to ?? [],
        failed: saved?.failed ?? null,
        signIn: !p ? null : "error" in p ? { error: p.error } : { code: p.userCode, link: p.verificationUri, expiresAt: p.expiresAt },
      };
    },

    /** Starts sign-in by code. The page shows the code and asks view() until it's done. */
    async start(session: Session) {
      await allowed(session);
      needKey();
      const code = { ...(await deps.outlook.startSignIn()), by: session.username };
      pending = code;
      void pollUntilDone(code);
      return { code: code.userCode, link: code.verificationUri, expiresAt: code.expiresAt };
    },

    async cancel(session: Session) {
      await allowed(session);
      pending = null;
    },

    async recipients(session: Session, raw: string) {
      await allowed(session);
      const saved = load();
      if (!saved) throw new HttpError(400, "Connect an account first.");
      const to = parseAddresses(raw);
      store({ ...saved, to });
      deps.audit("email-recipients", session.username, { count: to.length });
    },

    /** Sends one alert. Used by the test button and by alerts coming in from Proxmox. */
    async send(subject: string, text: string) {
      const saved = load();
      if (!saved) throw new HttpError(400, "Email alerts aren't set up.");
      const token = await fresh();
      try {
        await deps.outlook.send(token, saved.to, subject, text);
      } catch (err) {
        if (err instanceof OutlookError && err.code !== "unreachable") store({ ...(load() ?? saved), failed: `Microsoft didn't send the last alert: ${err.message}` });
        throw new HttpError(502, (err as Error).message);
      }
      const after = load();
      if (after?.failed) store({ ...after, failed: null });
    },

    async test(session: Session) {
      await allowed(session);
      await this.send("BossMox test alert", "This is a test from BossMox. If it arrived, alerts will reach you by email.");
      deps.audit("email-test", session.username, {});
    },

    /** Forgets the account: the sealed token is deleted, not just switched off. */
    async remove(session: Session) {
      await allowed(session);
      pending = null;
      access = null;
      if (existsSync(deps.file)) unlinkSync(deps.file);
      deps.audit("email-remove", session.username, {});
    },

    /** Called on a timer: renews a sign-in that hasn't been used in a week, so it never lapses. */
    async keepAlive() {
      const saved = load();
      if (!saved || !deps.key || now() - saved.renewedAt < RENEW_EVERY_MS) return;
      access = null;
      await fresh().catch(() => null);
    },
  };
}
export type Email = ReturnType<typeof createEmail>;
