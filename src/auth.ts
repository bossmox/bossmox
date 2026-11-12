import { randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";
import { PveError, type LoginResult } from "./pve.js";
import { HttpError } from "./http-error.js";

const RENEW_MS = 60 * 60 * 1000; // Proxmox tickets last 2 hours, so renew well before that.
const SESSION_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 10;
// A limit across many addresses. An address that has already signed in as this account skips it, so an attacker
// can't lock someone out of the machine they normally use.
const MAX_ACCOUNT_FAILS = 50;
const MAX_TRACKED = 10000;
const MAX_KNOWN_ADDRESSES = 20;
const MAX_CODE_TRIES = 5;
// An open console sends no HTTP requests, so nothing else would notice a disabled account.
const CONSOLE_CHECK_MS = 5 * 60 * 1000;
const NEVER_REACHED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

export interface LoginClient {
  login(username: string, password: string, tfaChallenge?: string): Promise<LoginResult>;
}
export interface Session {
  username: string;
  ticket: string;
  csrf: string;
  renewedAt: number;
  expiresAt: number;
  /** Set while a renewal is waiting on Proxmox, so anything else asking waits for the same answer. */
  renewing?: Promise<void> | undefined;
  /** Set once it has ended (signed out, expired, refused), so work still holding it stops at its next step. */
  ended?: boolean;
}
interface Challenge {
  username: string;
  challenge: string;
  expiresAt: number;
  tries: number;
}
interface Fails {
  count: number;
  first: number;
}
export type LoginOutcome = { kind: "ok"; id: string; username: string } | { kind: "code"; id: string };

/** A sign-in refusal: wrong password, a lockout, no permission. Every other refusal is a plain HttpError. */
export class AuthError extends HttpError {}

/** A machine can hold a whole IPv6 /64, so that counts as one client. */
export function clientGroup(address: string): string {
  if (!isIPv6(address)) return address;
  const [head = "", tail] = address.toLowerCase().split("::");
  const front = head.split(":").filter(Boolean);
  const back = tail === undefined ? [] : tail.split(":").filter(Boolean);
  const full = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** Keeps Proxmox tickets on the server. The browser only ever holds a random session ID. */
export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly fails = new Map<string, Fails>();
  private readonly known = new Map<string, Set<string>>();

  /** Runs whenever a session ends, however it ended, so nothing keeps working on its authority. */
  onEnd: (session: Session) => void = () => {};
  /** Whether a session has a console open, so it gets checked even with no requests arriving. */
  isBusy: (session: Session) => boolean = () => false;

  constructor(private readonly client: LoginClient, private readonly now: () => number = Date.now) {}

  private drop(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) {
      s.ended = true;
      this.onEnd(s);
    }
  }

  private checkLimit(key: string, max: number) {
    const f = this.fails.get(key);
    if (f && this.now() - f.first > FAIL_WINDOW_MS) this.fails.delete(key);
    else if (f && f.count >= max) throw new AuthError(429, "Too many failed sign-ins. Wait 5 minutes and try again.");
  }
  private count(key: string): Fails {
    const f = this.fails.get(key);
    if (f) {
      f.count += 1;
      return f;
    }
    if (this.fails.size >= MAX_TRACKED) this.fails.delete(this.fails.keys().next().value as string);
    const fresh = { count: 1, first: this.now() };
    this.fails.set(key, fresh);
    return fresh;
  }
  /** Takes back from the record it was counted on, which may already have been replaced by a new window. */
  private uncount(key: string, f: Fails) {
    if (this.fails.get(key) === f && --f.count <= 0) this.fails.delete(key);
  }
  private remember(account: string, group: string) {
    const groups = this.known.get(account) ?? new Set<string>();
    groups.delete(group);
    groups.add(group);
    if (groups.size > MAX_KNOWN_ADDRESSES) groups.delete(groups.values().next().value as string);
    this.known.set(account, groups);
    if (this.known.size > MAX_TRACKED) this.known.delete(this.known.keys().next().value as string);
  }
  private sweep() {
    const t = this.now();
    for (const [k, f] of this.fails) if (t - f.first > FAIL_WINDOW_MS) this.fails.delete(k);
    for (const [k, s] of this.sessions) if (s.expiresAt <= t) this.drop(k);
    for (const [k, c] of this.challenges) if (c.expiresAt <= t) this.challenges.delete(k);
  }
  private start(result: LoginResult): LoginOutcome {
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.set(id, { username: result.username, ticket: result.ticket, csrf: result.csrf, renewedAt: t, expiresAt: t + SESSION_MS });
    return { kind: "ok", id, username: result.username };
  }
  /**
   * Every attempt counts before Proxmox answers, or a burst sent at once would all pass the check.
   * It's taken back on success, or if Proxmox didn't give an answer about the password.
   */
  private async attempt(address: string, account: string, run: () => Promise<LoginResult>, wrong: string, codeStep = false): Promise<LoginResult> {
    const group = clientGroup(address);
    const name = account.toLowerCase();
    const byAddress = `address:${group}`;
    const byAccount = `account:${name}`;
    this.checkLimit(byAddress, MAX_FAILS);
    if (!this.known.get(name)?.has(group)) this.checkLimit(byAccount, MAX_ACCOUNT_FAILS);
    const addressEntry = this.count(byAddress);
    const accountEntry = this.count(byAccount);
    const takeBack = () => {
      this.uncount(byAddress, addressEntry);
      this.uncount(byAccount, accountEntry);
    };
    try {
      const result = await run();
      takeBack();
      if (!result.needsCode) this.remember(name, group);
      return result;
    } catch (err) {
      // Proxmox answers a bad second factor with 401 or 500. At the password step a 500 is Proxmox failing, not a wrong
      // password, so it isn't counted against the person (#59).
      if (err instanceof PveError && (err.status === 401 || (codeStep && err.status === 500))) {
        throw new AuthError(401, wrong);
      }
      const failure = err as NodeJS.ErrnoException & { unreached?: boolean };
      if (err instanceof PveError || failure.unreached || NEVER_REACHED.has(failure.code ?? "")) takeBack();
      throw err;
    }
  }

  async login(username: string, password: string, address: string): Promise<LoginOutcome> {
    const result = await this.attempt(address, username, () => this.client.login(username, password), "Wrong username or password.");
    if (result.needsCode) {
      const id = randomBytes(32).toString("base64url");
      this.challenges.set(id, { username, challenge: result.ticket, expiresAt: this.now() + CHALLENGE_MS, tries: 0 });
      return { kind: "code", id };
    }
    return this.start(result);
  }

  async submitCode(challengeId: string, code: string, address: string): Promise<LoginOutcome> {
    const c = this.challenges.get(challengeId);
    if (!c || c.expiresAt <= this.now()) throw new AuthError(401, "That sign-in timed out. Start again.");
    // Counted up front too, so a burst of guesses can't all run against one challenge.
    if (++c.tries > MAX_CODE_TRIES) {
      this.challenges.delete(challengeId);
      throw new AuthError(401, "That sign-in timed out. Start again.");
    }
    const result = await this.attempt(address, c.username, () => this.client.login(c.username, `totp:${code}`, c.challenge), "That code didn't work. Try the next one.", true);
    this.challenges.delete(challengeId);
    return this.start(result);
  }

  private renew(id: string, s: Session): Promise<void> {
    const t = this.now();
    s.renewedAt = t; // Stops every poll in this window from renewing at once.
    s.renewing = (async () => {
      try {
        const renewed = await this.client.login(s.username, s.ticket);
        s.ticket = renewed.ticket;
        s.csrf = renewed.csrf;
      } catch (err) {
        if (err instanceof PveError && err.status === 401) this.drop(id);
        else s.renewedAt = t - RENEW_MS; // Proxmox is unreachable, so try again next time.
      } finally {
        s.renewing = undefined;
      }
    })();
    return s.renewing;
  }

  /** Runs every minute. Ends expired sessions, and re-checks with Proxmox any session holding a console open. */
  async tick() {
    this.sweep();
    const t = this.now();
    const due = [...this.sessions].filter(([, s]) => !s.renewing && this.isBusy(s) && t - s.renewedAt >= CONSOLE_CHECK_MS);
    await Promise.all(due.map(([id, s]) => this.renew(id, s)));
  }

  /** Returns a live session, renewing its Proxmox ticket when due. */
  async get(id: string | undefined): Promise<Session | undefined> {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const t = this.now();
    if (s.expiresAt <= t) {
      this.drop(id);
      return undefined;
    }
    if (s.renewing) await s.renewing;
    else if (t - s.renewedAt >= RENEW_MS) await this.renew(id, s);
    // Signing out or a refused ticket can land while that was waiting. An ended session must stay ended.
    return this.sessions.has(id) ? s : undefined;
  }

  /** Ends a session on the spot, with no call to Proxmox in the way, and says whose it was. */
  end(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const who = this.sessions.get(id)?.username;
    this.drop(id);
    return who;
  }
}
