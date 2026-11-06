import { randomBytes } from "node:crypto";
import { PveError, type LoginResult } from "./pve.js";

const RENEW_MS = 60 * 60 * 1000; // Proxmox tickets last 2 hours, so renew well before that.
const SESSION_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 10;

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

  constructor(private readonly client: LoginClient, private readonly now: () => number = Date.now) {}

  private drop(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) this.onEnd(s);
  }

  private checkLimit(address: string) {
    const f = this.fails.get(address);
    if (f && this.now() - f.first > FAIL_WINDOW_MS) this.fails.delete(address);
    else if (f && f.count >= MAX_FAILS) throw new AuthError(429, "Too many failed sign-ins. Wait 5 minutes and try again.");
  }
  private noteFail(address: string) {
    const f = this.fails.get(address);
    if (f) f.count += 1;
    else this.fails.set(address, { count: 1, first: this.now() });
  }
  private sweep() {
    const t = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= t) this.drop(k);
    for (const [k, c] of this.challenges) if (c.expiresAt <= t) this.challenges.delete(k);
  }
  private start(result: LoginResult): LoginOutcome {
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.set(id, { username: result.username, ticket: result.ticket, csrf: result.csrf, renewedAt: t, expiresAt: t + SESSION_MS });
    return { kind: "ok", id, username: result.username };
  }
  private async attempt(address: string, run: () => Promise<LoginResult>, wrong: string): Promise<LoginResult> {
    this.checkLimit(address);
    try {
      return await run();
    } catch (err) {
      if (err instanceof PveError && (err.status === 401 || err.status === 500)) {
        // Proxmox answers a bad second factor with either status.
        this.noteFail(address);
        throw new AuthError(401, wrong);
      }
      throw err;
    }
  }

  async login(username: string, password: string, address: string): Promise<LoginOutcome> {
    this.sweep();
    const result = await this.attempt(address, () => this.client.login(username, password), "Wrong username or password.");
    if (result.needsCode) {
      const id = randomBytes(32).toString("base64url");
      this.challenges.set(id, { username, challenge: result.ticket, expiresAt: this.now() + CHALLENGE_MS });
      return { kind: "code", id };
    }
    return this.start(result);
  }

  async submitCode(challengeId: string, code: string, address: string): Promise<LoginOutcome> {
    this.sweep();
    const c = this.challenges.get(challengeId);
    if (!c) throw new AuthError(401, "That sign-in timed out. Start again.");
    const result = await this.attempt(address, () => this.client.login(c.username, `totp:${code}`, c.challenge), "That code didn't work. Try the next one.");
    this.challenges.delete(challengeId);
    return this.start(result);
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
      s.renewedAt = t; // Stops every poll in this window from renewing at once.
      try {
        const renewed = await this.client.login(s.username, s.ticket);
        s.ticket = renewed.ticket;
        s.csrf = renewed.csrf;
      } catch (err) {
        if (err instanceof PveError && err.status === 401) {
          this.drop(id);
          return undefined;
        }
        s.renewedAt = t - RENEW_MS; // Proxmox is unreachable, so try again next time.
      }
      // Signing out can land while that was waiting. An ended session must stay ended.
      if (!this.sessions.has(id)) return undefined;
    }
    return s;
  }

  end(id: string | undefined) {
    if (id) this.drop(id);
  }
}
