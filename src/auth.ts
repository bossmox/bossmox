import { randomBytes } from "node:crypto";
import { PveError, type LoginResult } from "./pve.js";

const RENEW_MS = 60 * 60 * 1000; // Proxmox tickets last 2 hours, so renew well before that.
const SESSION_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 10;
// One address can't reach this alone, so locking an account out takes many machines, not one.
const MAX_ACCOUNT_FAILS = 50;
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
}
interface Challenge {
  username: string;
  challenge: string;
  expiresAt: number;
  tries: number;
}
export type LoginOutcome = { kind: "ok"; id: string; username: string } | { kind: "code"; id: string };

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Keeps Proxmox tickets on the server. The browser only ever holds a random session ID. */
export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly fails = new Map<string, { count: number; first: number }>();

  /** Runs whenever a session ends, however it ended, so nothing keeps working on its authority. */
  onEnd: (session: Session) => void = () => {};
  /** Whether a session has a console open, so it gets checked even with no requests arriving. */
  isBusy: (session: Session) => boolean = () => false;

  constructor(private readonly client: LoginClient, private readonly now: () => number = Date.now) {}

  private drop(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) this.onEnd(s);
  }

  private checkLimit(key: string, max: number) {
    const f = this.fails.get(key);
    if (f && this.now() - f.first > FAIL_WINDOW_MS) this.fails.delete(key);
    else if (f && f.count >= max) throw new AuthError(429, "Too many failed sign-ins. Wait 5 minutes and try again.");
  }
  private count(key: string) {
    const f = this.fails.get(key);
    if (f) f.count += 1;
    else this.fails.set(key, { count: 1, first: this.now() });
  }
  private uncount(key: string) {
    const f = this.fails.get(key);
    if (f && --f.count <= 0) this.fails.delete(key);
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
   * It's taken back on success, or if it never reached Proxmox and so can't have been a guess.
   */
  private async attempt(address: string, account: string, run: () => Promise<LoginResult>, wrong: string): Promise<LoginResult> {
    const byAddress = `address:${address}`;
    const byAccount = `account:${account.toLowerCase()}`;
    this.checkLimit(byAddress, MAX_FAILS);
    this.checkLimit(byAccount, MAX_ACCOUNT_FAILS);
    this.count(byAddress);
    this.count(byAccount);
    const takeBack = () => {
      this.uncount(byAddress);
      this.uncount(byAccount);
    };
    try {
      const result = await run();
      takeBack();
      return result;
    } catch (err) {
      if (err instanceof PveError && (err.status === 401 || err.status === 500)) {
        // Proxmox answers a bad second factor with either status.
        throw new AuthError(401, wrong);
      }
      if (NEVER_REACHED.has((err as NodeJS.ErrnoException).code ?? "")) takeBack();
      throw err;
    }
  }

  async login(username: string, password: string, address: string): Promise<LoginOutcome> {
    this.sweep();
    const result = await this.attempt(address, username, () => this.client.login(username, password), "Wrong username or password.");
    if (result.needsCode) {
      const id = randomBytes(32).toString("base64url");
      this.challenges.set(id, { username, challenge: result.ticket, expiresAt: this.now() + CHALLENGE_MS, tries: 0 });
      return { kind: "code", id };
    }
    return this.start(result);
  }

  async submitCode(challengeId: string, code: string, address: string): Promise<LoginOutcome> {
    this.sweep();
    const c = this.challenges.get(challengeId);
    if (!c) throw new AuthError(401, "That sign-in timed out. Start again.");
    // Counted up front too, so a burst of guesses can't all run against one challenge.
    if (++c.tries > MAX_CODE_TRIES) {
      this.challenges.delete(challengeId);
      throw new AuthError(401, "That sign-in timed out. Start again.");
    }
    const result = await this.attempt(address, c.username, () => this.client.login(c.username, `totp:${code}`, c.challenge), "That code didn't work. Try the next one.");
    this.challenges.delete(challengeId);
    return this.start(result);
  }

  private async renew(id: string, s: Session) {
    const t = this.now();
    s.renewedAt = t; // Stops every poll in this window from renewing at once.
    try {
      const renewed = await this.client.login(s.username, s.ticket);
      s.ticket = renewed.ticket;
      s.csrf = renewed.csrf;
    } catch (err) {
      if (err instanceof PveError && err.status === 401) this.drop(id);
      else s.renewedAt = t - RENEW_MS; // Proxmox is unreachable, so try again next time.
    }
  }

  /** Runs every minute. Ends expired sessions, and re-checks with Proxmox any session holding a console open. */
  async tick() {
    this.sweep();
    const t = this.now();
    const due = [...this.sessions].filter(([, s]) => this.isBusy(s) && t - s.renewedAt >= CONSOLE_CHECK_MS);
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
    if (t - s.renewedAt >= RENEW_MS) {
      await this.renew(id, s);
      // Signing out can land while that was waiting. An ended session must stay ended.
      if (!this.sessions.has(id)) return undefined;
    }
    return s;
  }

  end(id: string | undefined) {
    if (id) this.drop(id);
  }
}
