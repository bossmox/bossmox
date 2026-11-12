/**
 * Guests moved off a node, and the job that moves them (ADR 0025). The record lives on the BossMox server beside
 * its settings, so any browser and any person can see what's away and send it home.
 */
import { readFileSync, } from "node:fs";
import path from "node:path";
import type { Move, MovePlan, Pending } from "./placement.js";
import { writeJsonAtomic } from "./json-file.js";

export interface AwayGuest {
  id: number;
  name: string;
  type: "qemu" | "lxc";
  /** The node BossMox moved it to. */
  to: string;
}
export interface Away {
  by: string;
  at: number;
  guests: AwayGuest[];
}
export interface JobGuest {
  id: number;
  name: string;
  target: string;
  state: "waiting" | "moving" | "done" | "failed" | "stayed";
  /** Why it stayed where it is, when it did. */
  note?: string;
}
export interface JobView {
  kind: "off" | "home";
  node: string;
  by: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  guests: JobGuest[];
  /** Why it stopped early, in plain words. */
  error: string | null;
}
/** A move job as someone who can't see the whole cluster may see it: their own guests only (review S6). */
export function jobFor(job: JobView | null, who: { full: boolean; nodes: Set<string>; guests: Set<number> }): JobView | null {
  if (!job || who.full) return job;
  if (!who.nodes.has(job.node)) return null;
  return { ...job, by: "Someone else", error: job.error ? "It stopped before finishing." : null, guests: job.guests.filter((g) => who.guests.has(g.id)) };
}

export interface MoveRecord {
  /** By home node. */
  away: Record<string, Away>;
  job: JobView | null;
}

export const movesPath = (settingsFile: string) => path.join(path.dirname(settingsFile), "moves.json");

/** A job that was running when BossMox stopped can't still be running. */
export function readMoves(file: string): MoveRecord {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<MoveRecord>;
    const away = raw.away && typeof raw.away === "object" ? raw.away : {};
    const job = raw.job ?? null;
    if (job?.running) {
      job.running = false;
      job.finishedAt = Date.now();
      job.error = "BossMox restarted during the moves. Anything already moved is listed as away.";
      for (const g of job.guests) if (g.state === "moving" || g.state === "waiting") g.state = "failed";
    }
    return { away, job };
  } catch {
    return { away: {}, job: null };
  }
}

/** Written to a temporary file first, so a power cut can't leave half a file. */
export function writeMoves(file: string, record: MoveRecord) {
  writeJsonAtomic(file, record);
}

export interface TaskEnd {
  finished: boolean;
  ok: boolean;
  error: string;
}
/** Everything the job needs from Proxmox, passed in so the job is tested without one. */
export interface MoveDeps {
  /**
   * A fresh plan for these guests of `from`. With `only`, that node is the one target allowed. `pending` is memory
   * already promised to nodes by moves in the same batch, counted as used.
   */
  plan(from: string, ids: number[], only?: string, pending?: Pending): Promise<MovePlan>;
  /** Starts one move and returns the Proxmox task. */
  migrate(move: Move, from: string): Promise<string>;
  task(node: string, upid: string): Promise<TaskEnd>;
  /** Where every guest is right now. */
  where(): Promise<Map<number, string>>;
  /** Why to stop before the next move (signed out, or someone pressed Stop), or null to carry on. */
  stopped(): string | null;
  wait(ms: number): Promise<void>;
  save(record: MoveRecord): void;
}

/** How many moves run at once (ADR 0027). */
export const BATCH = 3;
/** After Proxmox says a move finished, how long to wait for the guest to show up there (HA moves report early). */
const ARRIVE_MS = 10 * 60 * 1000;
const BLIP_MS = 2 * 60 * 1000;

/** Runs one move to the end: the task, then the guest seen on the target. Throws with a plain reason. */
async function moveOne(deps: MoveDeps, move: Move, from: string): Promise<void> {
  const upid = await deps.migrate(move, from);
  // Watching is a read: a blip in reaching Proxmox is waited out for a while, since the move carries on regardless.
  let failingSince = 0;
  const read = async <T>(get: () => Promise<T>): Promise<T | undefined> => {
    try {
      const value = await get();
      failingSince = 0;
      return value;
    } catch (err) {
      failingSince ||= Date.now();
      if (Date.now() - failingSince > BLIP_MS) throw err;
      return undefined;
    }
  };
  for (;;) {
    await deps.wait(2000);
    const end = await read(() => deps.task(from, upid));
    if (!end?.finished) continue;
    if (!end.ok) throw new Error(`Proxmox couldn't move ${move.name}: ${end.error}`);
    break;
  }
  for (const until = Date.now() + ARRIVE_MS; ; await deps.wait(3000)) {
    if ((await read(() => deps.where()))?.get(move.id) === move.target) return;
    if (Date.now() > until) throw new Error(`Proxmox finished moving ${move.name}, but it hasn't shown up on ${move.target}.`);
  }
}

const plainError = (err: unknown) => (err instanceof Error && err.message ? err.message : "BossMox lost contact with Proxmox.");

/**
 * Moves the given guests off `node`, a batch at a time. Each move is planned again with fresh numbers first, so a node
 * that filled up meanwhile isn't used. Every finished move is written to the record at once.
 */
export async function runMoveOff(record: MoveRecord, deps: MoveDeps, node: string, by: string, first: Move[], batch = BATCH): Promise<void> {
  const job: JobView = { kind: "off", node, by, startedAt: Date.now(), finishedAt: null, running: true, error: null, guests: first.map((m) => ({ id: m.id, name: m.name, target: m.target, state: "waiting" })) };
  record.job = job;
  deps.save(record);
  try {
    for (;;) {
      const left = job.guests.filter((x) => x.state === "waiting");
      if (!left.length) break;
      const stop = deps.stopped();
      if (stop) throw new Error(`BossMox stopped before the next move: ${stop}`);
      // One plan for everything still to go, so the batch's room is counted together.
      const fresh = await deps.plan(node, left.map((x) => x.id));
      if (fresh.problems.length) throw new Error(`The room changed while moving: ${fresh.problems.join(" ")}`);
      const gone = left.find((x) => !fresh.moves.some((m) => m.id === x.id));
      if (gone) throw new Error(`${gone.name} is no longer on ${node}, so BossMox stopped to let you check.`);
      const take = fresh.moves.slice(0, batch);
      for (const m of take) {
        const g = job.guests.find((x) => x.id === m.id) as JobGuest;
        g.target = m.target;
        g.state = "moving";
      }
      deps.save(record);
      const results = await Promise.allSettled(take.map((m) => moveOne(deps, m, node)));
      // A move that errored may still have happened: BossMox lost sight of it, Proxmox carried on. Where each one
      // is now decides, not the error (#50). If even that can't be read, it stays a failure.
      const now = results.some((r) => r.status === "rejected") ? await deps.where().catch(() => null) : null;
      let failure: unknown = null;
      take.forEach((m, i) => {
        const g = job.guests.find((x) => x.id === m.id) as JobGuest;
        const r = results[i] as PromiseSettledResult<void>;
        let to = m.target;
        if (r.status === "rejected") {
          const at = now?.get(g.id);
          if (!at || at === node) {
            g.state = "failed";
            failure ??= r.reason;
            return;
          }
          to = at;
          g.target = at;
          g.note = `BossMox lost sight of the move, but it finished on ${at}.`;
        }
        g.state = "done";
        recordAway(record, node, by, { id: g.id, name: g.name, type: m.type }, to);
      });
      deps.save(record);
      if (failure) throw failure;
    }
  } catch (err) {
    job.error = plainError(err);
  }
  job.running = false;
  job.finishedAt = Date.now();
  deps.save(record);
}

/**
 * Writes down where a guest moved off `node` went. A guest already away from another node keeps that node as its
 * home, and only where it is now changes. One that has just arrived back on its own home isn't away any more.
 */
function recordAway(record: MoveRecord, node: string, by: string, g: { id: number; name: string; type: "qemu" | "lxc" }, to: string) {
  const home = Object.entries(record.away).find(([, a]) => a.guests.some((x) => x.id === g.id));
  if (home) {
    const [homeNode, entry] = home;
    if (homeNode === to) {
      entry.guests = entry.guests.filter((x) => x.id !== g.id);
      if (!entry.guests.length) delete record.away[homeNode];
    } else (entry.guests.find((x) => x.id === g.id) as AwayGuest).to = to;
    return;
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: creates the node's entry on first use and returns it.
  const away = (record.away[node] ??= { by, at: Date.now(), guests: [] });
  away.guests.push({ id: g.id, name: g.name, type: g.type, to });
}

/** The guests still where BossMox left them. Anything moved elsewhere since is someone else's choice. */
export function stillAway(record: MoveRecord, node: string, where: Map<number, string>): AwayGuest[] {
  return (record.away[node]?.guests ?? []).filter((g) => where.get(g.id) === g.to);
}

/** How long a guest turned away only because its home was too busy waits before it's tried again. */
export const BUSY_RETRY_MS = 15_000;
/** A refusal only because the node's processor is too busy. That passes by itself; memory and storage don't. */
export const onlyBusy = (plan: MovePlan) => (plan.unplaced ?? []).length > 0 && (plan.unplaced ?? []).every((u) => u.busyOnly === true);

/**
 * Sends a node's guests home, up to `batch` at a time. Each is checked for room with the rest of its batch already
 * counted on the node. One that doesn't fit stays where it is, still recorded as away. With `patienceMs`, one turned
 * away only because the node is busy (a node just back from a restart, busier with each guest that returns) is
 * tried again every 15 seconds until that time runs out.
 */
export async function runMoveHome(record: MoveRecord, deps: MoveDeps, node: string, by: string, batch = BATCH, patienceMs = 0): Promise<void> {
  // The job is on the record before anything waits, so whoever started it can follow it at once.
  const job: JobView = { kind: "home", node, by, startedAt: Date.now(), finishedAt: null, running: true, error: null, guests: (record.away[node]?.guests ?? []).map((g) => ({ id: g.id, name: g.name, target: node, state: "waiting" })) };
  record.job = job;
  deps.save(record);
  const away = record.away[node];
  try {
    const back = stillAway(record, node, await deps.where());
    // Guests that aren't where BossMox left them are dropped: whoever moved them decided where they live now.
    job.guests = job.guests.filter((g) => back.some((b) => b.id === g.id));
    if (away) away.guests = back;
    deps.save(record);
    const queue = [...back];
    const later: AwayGuest[] = [];
    let retries = Math.floor(patienceMs / BUSY_RETRY_MS);
    while (queue.length || (later.length && retries > 0)) {
      if (!queue.length) {
        // Everything that could come home has. Give the node a moment, then try the busy ones again.
        retries -= 1;
        await deps.wait(BUSY_RETRY_MS);
        queue.push(...later.splice(0));
        for (const g of queue) (job.guests.find((x) => x.id === g.id) as JobGuest).state = "waiting";
        deps.save(record);
      }
      const stop = deps.stopped();
      if (stop) throw new Error(`BossMox stopped before the next move: ${stop}`);
      const take: { g: AwayGuest; move: Move }[] = [];
      const pending: Pending = {};
      while (queue.length && take.length < batch) {
        const g = queue.shift() as AwayGuest;
        const jg = job.guests.find((x) => x.id === g.id) as JobGuest;
        const fresh = await deps.plan(g.to, [g.id], node, pending);
        const move = fresh.moves[0];
        // No room at home isn't a failure: it stays where it is, still recorded as away, and the rest carry on.
        if (fresh.problems.length || !move) {
          if (retries > 0 && onlyBusy(fresh)) later.push(g);
          jg.state = "stayed";
          jg.note = fresh.problems[0] ?? `${g.name} is no longer on ${g.to}.`;
          continue;
        }
        // Memory and processor both: a batch coming home to a just-restarted node mustn't overload it (#59).
        const was = pending[node] ?? { mem: 0, cpu: 0 };
        pending[node] = { mem: was.mem + (move.mem ?? 0), cpu: was.cpu + (move.cpu ?? 0) };
        jg.state = "moving";
        take.push({ g, move });
      }
      deps.save(record);
      if (!take.length) continue;
      const results = await Promise.allSettled(take.map(({ g, move }) => moveOne(deps, move, g.to)));
      let failure: unknown = null;
      take.forEach(({ g }, i) => {
        const jg = job.guests.find((x) => x.id === g.id) as JobGuest;
        if ((results[i] as PromiseSettledResult<void>).status === "rejected") {
          jg.state = "failed";
          failure ??= (results[i] as PromiseRejectedResult).reason;
          return;
        }
        jg.state = "done";
        if (away) away.guests = away.guests.filter((a) => a.id !== g.id);
      });
      deps.save(record);
      if (failure) throw failure;
    }
  } catch (err) {
    job.error = plainError(err);
  }
  if (away && away.guests.length === 0) delete record.away[node];
  job.running = false;
  job.finishedAt = Date.now();
  deps.save(record);
}
