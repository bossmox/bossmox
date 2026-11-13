/**
 * Sending alert email through an Outlook or Microsoft 365 account (ADR 0040): sign-in by code, the refresh token
 * that keeps it signed in, and Microsoft Graph's sendMail. Only the network calls live here; what's kept and when
 * is email.ts.
 */

/** BossMox's app registration, in Rocky's own tenant. Public: it ships in every install and has no secret. */
export const CLIENT_ID = "c4ea3caf-6aeb-4153-b096-73f3a7c55e40";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Send mail, read who signed in, and stay signed in. Nothing can read the mailbox. */
export const SCOPE = "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A refusal from Microsoft, in its own words, with its error code for the caller to act on. */
export class OutlookError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}
export interface Tokens {
  access: string;
  refresh: string;
  accessExpiresAt: number;
}
export type PollResult = { state: "waiting" } | { state: "slower" } | { state: "done"; tokens: Tokens };

export interface Outlook {
  startSignIn(): Promise<DeviceCode>;
  poll(deviceCode: string): Promise<PollResult>;
  renew(refresh: string): Promise<Tokens>;
  account(access: string): Promise<string>;
  send(access: string, to: string[], subject: string, text: string): Promise<void>;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

export function createOutlook(clientId: string = CLIENT_ID, fetcher: Fetcher = fetch as unknown as Fetcher, now: () => number = Date.now): Outlook {
  async function call(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Awaited<ReturnType<Fetcher>>;
    try {
      res = await fetcher(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new OutlookError("unreachable", `BossMox couldn't reach Microsoft: ${(err as Error).message}`);
    }
    const raw = await res.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      /* Graph's sendMail answers 202 with no body */
    }
    return { status: res.status, data };
  }
  const post = (url: string, fields: Record<string, string>) => call(url, "POST", { "Content-Type": "application/x-www-form-urlencoded" }, form(fields));
  const refusal = (data: Record<string, unknown>, fallback: string) => {
    const e = data.error;
    if (e && typeof e === "object") {
      const g = e as { code?: string; message?: string };
      return new OutlookError(g.code ?? "graph", g.message ?? fallback);
    }
    // Microsoft's sign-in errors start with an AADSTS number and a sentence, then trace ids nobody needs.
    const said = String(data.error_description ?? "").split(/\r?\n/)[0] ?? "";
    return new OutlookError(String(e ?? "refused"), said || fallback);
  };
  const tokens = (data: Record<string, unknown>): Tokens => {
    const access = data.access_token;
    const refresh = data.refresh_token;
    if (typeof access !== "string" || typeof refresh !== "string") throw new OutlookError("no-token", "Microsoft signed in but gave no token to stay signed in with.");
    return { access, refresh, accessExpiresAt: now() + (Number(data.expires_in) || 3600) * 1000 };
  };

  return {
    async startSignIn() {
      const { status, data } = await post(`${LOGIN}/devicecode`, { client_id: clientId, scope: SCOPE });
      if (status !== 200 || typeof data.device_code !== "string" || typeof data.user_code !== "string") throw refusal(data, "Microsoft didn't start the sign-in.");
      return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : "https://microsoft.com/devicelogin",
        expiresAt: now() + (Number(data.expires_in) || 900) * 1000,
        intervalMs: (Number(data.interval) || 5) * 1000,
      };
    },
    async poll(deviceCode) {
      const { status, data } = await post(`${LOGIN}/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode });
      if (status === 200) return { state: "done", tokens: tokens(data) };
      if (data.error === "authorization_pending") return { state: "waiting" };
      if (data.error === "slow_down") return { state: "slower" };
      throw refusal(data, "Microsoft refused the sign-in.");
    },
    async renew(refresh) {
      const { status, data } = await post(`${LOGIN}/token`, { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh, scope: SCOPE });
      if (status !== 200) throw refusal(data, "Microsoft wouldn't keep BossMox signed in.");
      return tokens(data);
    },
    async account(access) {
      const { status, data } = await call(`${GRAPH}/me?$select=mail,userPrincipalName`, "GET", { Authorization: `Bearer ${access}` });
      if (status !== 200) throw refusal(data, "Microsoft didn't say which account signed in.");
      const mail = typeof data.mail === "string" && data.mail ? data.mail : data.userPrincipalName;
      if (typeof mail !== "string" || !mail) throw new OutlookError("no-account", "Microsoft didn't say which account signed in.");
      return mail;
    },
    async send(access, to, subject, text) {
      const message = { subject, body: { contentType: "Text", content: text }, toRecipients: to.map((address) => ({ emailAddress: { address } })) };
      const { status, data } = await call(
        `${GRAPH}/me/sendMail`,
        "POST",
        { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        JSON.stringify({ message, saveToSentItems: false }),
      );
      if (status !== 202) throw refusal(data, `Microsoft didn't send the email (status ${status}).`);
    },
  };
}
