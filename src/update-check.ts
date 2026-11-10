/**
 * Checks GitHub for a newer BossMox release every 6 hours (ADR 0019). It only tells people; it never installs.
 * The person installs with the update one-liner on a Proxmox node, as the README says.
 */
export const RELEASES_API = "https://api.github.com/repos/bossmox/bossmox/releases/latest";
export const UPDATE_COMMAND = 'bash -c "$(curl -fsSL https://github.com/bossmox/bossmox/releases/latest/download/update-bossmox.sh)"';
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The first check waits a minute after start, so a restart loop can't hammer GitHub. */
export const FIRST_CHECK_MS = 60 * 1000;
/** Check now, when a person asks: at most once a minute, so repeated clicks can't use up GitHub's allowance. */
export const CHECK_NOW_GAP_MS = 60 * 1000;

export interface Available {
  version: string;
  url: string;
}
export interface UpdateState {
  /** False when the person turned the check off. */
  on: boolean;
  /** When the last check finished, ms since 1970, or null before the first. */
  checkedAt: number | null;
  /** A newer release, if the last check found one. */
  available: Available | null;
  /** Why the last check failed, in plain words, or null when it worked. */
  failed: string | null;
}

/** The numbers at the front of a version or tag: "v0.1.1-preview" and "0.1.1-preview.20261109.abc" both give [0, 1, 1]. */
export function versionNumbers(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The release if it's newer than what's running. Every release bumps the version number, so the numbers decide;
 * a copy with no version (run from the repo) never offers an update.
 */
export function newerRelease(current: string, release: { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }): Available | null {
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return null;
  if (!release.html_url.startsWith("https://github.com/bossmox/bossmox/releases/")) return null;
  const mine = versionNumbers(current);
  const theirs = versionNumbers(release.tag_name);
  if (!mine || !theirs) return null;
  for (let i = 0; i < 3; i++) {
    if (theirs[i]! > mine[i]!) return { version: release.tag_name.replace(/^v/, ""), url: release.html_url };
    if (theirs[i]! < mine[i]!) return null;
  }
  return null;
}

class CheckError extends Error {}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class UpdateChecker {
  state: UpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly current: string,
    on: boolean,
    private readonly fetcher: Fetcher = fetch as unknown as Fetcher,
  ) {
    this.state = { on, checkedAt: null, available: null, failed: null };
  }

  /** One check now. Never throws: a failure is kept, in plain words, for the health check. */
  async check(): Promise<UpdateState> {
    if (!this.state.on || !versionNumbers(this.current)) return this.state;
    try {
      const res = await this.fetcher(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `BossMox/${this.current}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new CheckError(res.status === 403 || res.status === 429 ? "GitHub asked BossMox to slow down" : `GitHub answered ${res.status}`);
      const available = newerRelease(this.current, (await res.json()) as Record<string, unknown>);
      if (this.state.on) this.state = { on: true, checkedAt: Date.now(), available, failed: null };
    } catch (err) {
      const why = err instanceof CheckError ? err.message : "BossMox couldn't reach GitHub";
      if (this.state.on) this.state = { ...this.state, checkedAt: Date.now(), failed: why };
    }
    return this.state;
  }

  /** A check a person asked for. Within a minute of the last one, the answer it already has is the answer. */
  async checkNow(gapMs = CHECK_NOW_GAP_MS, now = Date.now()): Promise<UpdateState> {
    if (this.state.checkedAt && now - this.state.checkedAt < gapMs) return this.state;
    return this.check();
  }

  /** Checks a minute after start, then every 6 hours, while it's on. */
  start(firstMs = FIRST_CHECK_MS, everyMs = CHECK_EVERY_MS) {
    this.stop();
    if (!this.state.on || !versionNumbers(this.current)) return;
    const run = (wait: number) => {
      this.timer = setTimeout(async () => {
        await this.check();
        if (this.state.on) run(everyMs);
      }, wait);
      this.timer.unref?.();
    };
    run(firstMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Turning it off forgets what it knew, so no stale notice lingers; turning it on checks straight away. */
  async setOn(on: boolean): Promise<UpdateState> {
    this.state = { on, checkedAt: null, available: null, failed: null };
    if (!on) {
      this.stop();
      return this.state;
    }
    this.start(CHECK_EVERY_MS);
    return this.check();
  }
}
