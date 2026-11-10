/**
 * Guests moved off a node, and the job that moves them (ADR 0025). The record lives on the BossMox server beside
 * its settings, so any browser and any person can see what's away and send it home.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Move, MovePlan } from "./placement.js";

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
  state: "waiting" | "moving" | "done" | "failed";
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
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.new`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 });
  chmodSync(temp, 0o640);
  renameSync(temp, file);
}

export interface TaskEnd {
  finished: boolean;
  ok: boolean;
  error: string;
}
/** Everything the job needs from Proxmox, passed in so the job is tested without one. */
export interface MoveDeps {
  /** A fresh plan for these guests of `from`. With `only`, that node is the one target allowed. */
  plan(from: string, ids: number[], only?: string): Promise<MovePlan>;
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
 * Moves the given guests off `node`, one at a time. Each move is planned again with fresh numbers first, so a node
 * that filled up meanwhile isn't used. Every finished move is written to the record at once.
 */
export async function runMoveOff(record: MoveRecord, deps: MoveDeps, node: string, by: string, first: Move[]): Promise<void> {
  const job: JobView = { kind: "off", node, by, startedAt: Date.now(), finishedAt: null, running: true, error: null, guests: first.map((m) => ({ id: m.id, name: m.name, target: m.target, state: "waiting" })) };
  record.job = job;
  deps.save(record);
  try {
    for (const g of job.guests) {
      const stop = deps.stopped();
      if (stop) throw new Error(`BossMox stopped before the next move: ${stop}`);
      const left = job.guests.filter((x) => x.state === "waiting").map((x) => x.id);
      const fresh = await deps.plan(node, left);
      if (fresh.problems.length) throw new Error(`The room changed while moving: ${fresh.problems.join(" ")}`);
      const move = fresh.moves.find((m) => m.id === g.id);
      if (!move) throw new Error(`${g.name} is no longer on ${node}, so BossMox stopped to let you check.`);
      g.target = move.target;
      g.state = "moving";
      deps.save(record);
      try {
        await moveOne(deps, move, node);
      } catch (err) {
        g.state = "failed";
        throw err;
      }
      g.state = "done";
      const away = (record.away[node] ??= { by, at: Date.now(), guests: [] });
      away.guests = [...away.guests.filter((a) => a.id !== g.id), { id: g.id, name: g.name, type: move.type, to: move.target }];
      deps.save(record);
    }
  } catch (err) {
    job.error = plainError(err);
  }
  job.running = false;
  job.finishedAt = Date.now();
  deps.save(record);
}

/** The guests still where BossMox left them. Anything moved elsewhere since is someone else's choice. */
export function stillAway(record: MoveRecord, node: string, where: Map<number, string>): AwayGuest[] {
  return (record.away[node]?.guests ?? []).filter((g) => where.get(g.id) === g.to);
}

/** Sends a node's guests home, one at a time, each checked for room on the way back. */
export async function runMoveHome(record: MoveRecord, deps: MoveDeps, node: string, by: string): Promise<void> {
  // The job is on the record before anything waits, so whoever started it can follow it at once.
  const job: JobView = { kind: "home", node, by, startedAt: Date.now(), finishedAt: null, running: true, error: null, guests: (record.away[node]?.guests ?? []).map((g) => ({ id: g.id, name: g.name, target: node, state: "waiting" })) };
  record.job = job;
  deps.save(record);
  const away = record.away[node];
  let back: AwayGuest[] = [];
  try {
    back = stillAway(record, node, await deps.where());
    // Guests that aren't where BossMox left them are dropped: whoever moved them decided where they live now.
    job.guests = job.guests.filter((g) => back.some((b) => b.id === g.id));
    if (away) away.guests = back;
    deps.save(record);
    for (const g of back) {
      const stop = deps.stopped();
      if (stop) throw new Error(`BossMox stopped before the next move: ${stop}`);
      const jg = job.guests.find((x) => x.id === g.id) as JobGuest;
      const fresh = await deps.plan(g.to, [g.id], node);
      if (fresh.problems.length) throw new Error(fresh.problems.join(" "));
      const move = fresh.moves[0];
      if (!move) throw new Error(`${g.name} is no longer on ${g.to}, so BossMox left it there.`);
      jg.state = "moving";
      deps.save(record);
      try {
        await moveOne(deps, move, g.to);
      } catch (err) {
        jg.state = "failed";
        throw err;
      }
      jg.state = "done";
      if (away) away.guests = away.guests.filter((a) => a.id !== g.id);
      deps.save(record);
    }
  } catch (err) {
    job.error = plainError(err);
  }
  if (away && away.guests.length === 0) delete record.away[node];
  job.running = false;
  job.finishedAt = Date.now();
  deps.save(record);
}
