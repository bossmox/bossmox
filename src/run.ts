/**
 * An update or restart run, driven by the BossMox server (ADR 0027). Kept in runs.json beside the settings, so any
 * browser can follow it and closing the page changes nothing. One node at a time; every step is saved as it ends.
 */
import { readFileSync, } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-file.js";

export type Choice = "move" | "shutdown";
export type VmState = "waiting" | "moving" | "moved" | "stopping" | "off" | "starting" | "started" | "home" | "stayed" | "failed";
export type Phase = "waiting" | "checking" | "emptying" | "installing" | "restarting" | "starting" | "returning" | "done" | "failed";

export interface RunVm {
  id: number;
  name: string;
  type: "qemu" | "lxc";
  choice: Choice;
  state: VmState;
  /** Where it is now, once it has moved. */
  on?: string;
  note?: string;
}
export interface RunNode {
  name: string;
  install: boolean;
  restart: boolean;
  updates: number;
  phase: Phase;
  vms: RunVm[];
  note: string | null;
  /** Config files apt kept the old version of; the new one is beside each. */
  keptConfig: string[];
}
export interface Run {
  id: string;
  kind: "update" | "restart";
  by: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  /** Set by Stop or sign-out: the step under way finishes and nothing new starts. */
  stop: string | null;
  error: string | null;
  current: number;
  nodes: RunNode[];
}

/** What one person may see of the cluster: everything, or only the nodes and guests Proxmox shows them. */
export interface Viewer {
  full: boolean;
  nodes: Set<string>;
  guests: Set<number>;
}
const HIDDEN = "Someone else";

/**
 * A run as this person may see it (review S6). Someone who can change the cluster, or who started it, sees all of
 * it. Anyone else sees only the nodes and guests Proxmox already shows them, and no names they couldn't see: not
 * who started it, and not the error or node notes, which can name hidden guests.
 */
export function runFor(run: Run | null, who: Viewer): Run | null {
  if (!run || who.full) return run;
  return {
    ...run,
    by: HIDDEN,
    error: run.error ? "It stopped before finishing." : null,
    nodes: run.nodes.filter((n) => who.nodes.has(n.name)).map((n) => ({ ...n, note: null, vms: n.vms.filter((v) => who.guests.has(v.id)) })),
  };
}

export const runsPath = (settingsFile: string) => path.join(path.dirname(settingsFile), "runs.json");

/** A run that was going when BossMox stopped isn't going any more, and doesn't pick itself back up. */
export function readRun(file: string): Run | null {
  try {
    const run = JSON.parse(readFileSync(file, "utf8")) as Run;
    if (!run || !Array.isArray(run.nodes)) return null;
    if (run.running) {
      const at = run.nodes[run.current];
      run.running = false;
      run.finishedAt = Date.now();
      run.error = `BossMox restarted during the run${at ? `, while ${at.name} was ${at.phase}` : ""}. Nothing more was done. Check that node, then start again if needed.`;
      if (at && at.phase !== "done") at.phase = "failed";
    }
    return run;
  } catch {
    return null;
  }
}

export function writeRun(file: string, run: Run) {
  writeJsonAtomic(file, run);
}

export interface InstallResult {
  exitCode: number;
  keptConfig: string[];
  /** Updates still waiting after the install, or null if BossMox couldn't read them. */
  left: number | null;
}
export interface MoveOffResult {
  went: Record<number, string>;
  error: string | null;
}
/** What a run needs from Proxmox and the move job, passed in so the run is tested without either. */
export interface RunDeps {
  stopped(): string | null;
  save(run: Run): void;
  wait(ms: number): Promise<void>;
  /** Why the cluster or this node isn't ready right now, or null. */
  notReady(node: string): Promise<string | null>;
  /** The guests running on the node right now. */
  runningOn(node: string): Promise<{ id: number; name: string; type: "qemu" | "lxc" }[]>;
  shutdown(node: string, vm: RunVm): Promise<void>;
  /**
   * Moves these VMs off the node, in batches. Resolves with where each one is now that's no longer on the node,
   * whoever moved it, and why the moves ended early if they did. One missing from `went` is still on the node.
   * Rejects only when it can't tell.
   */
  moveOff(node: string, ids: number[]): Promise<MoveOffResult>;
  install(node: string): Promise<InstallResult>;
  restart(node: string): Promise<void>;
  start(node: string, vm: RunVm): Promise<void>;
  /** Brings this node's moved VMs home. Resolves with each of `ids` that isn't home afterwards: where it is, and why. */
  moveHome(node: string, ids: number[]): Promise<Record<number, { on: string; why: string }>>;
}

const READY_WAIT_MS = 3 * 60 * 1000;
const plain = (err: unknown) => (err instanceof Error && err.message ? err.message : "BossMox lost contact with Proxmox.");

/** One phase of a node. It begins only if nobody pressed Stop, unless it finishes something already under way. */
async function step(run: Run, deps: RunDeps, node: RunNode, phase: Phase, work: () => Promise<void>, finishes = false) {
  const stop = deps.stopped();
  if (stop && !finishes) throw new StopError(stop);
  node.phase = phase;
  deps.save(run);
  await work();
  deps.save(run);
}
class StopError extends Error {}

/** Drives the run to its end. Never throws: how it ended is written on the run. */
export async function drive(run: Run, deps: RunDeps): Promise<void> {
  run.running = true;
  deps.save(run);
  try {
    for (; run.current < run.nodes.length; run.current++) {
      const node = run.nodes[run.current] as RunNode;
      // Set the moment the reboot is asked for. Before that, ending the node starts again what was shut down (review 2).
      let rebootAsked = false;
      try {
        await step(run, deps, node, "checking", async () => {
          // A node that just came back can look busy or absent for a moment.
          for (const until = Date.now() + READY_WAIT_MS; ; await deps.wait(5000)) {
            const why = await deps.notReady(node.name);
            if (!why) return;
            if (Date.now() > until) throw new Error(why);
          }
        });
        // The list made at the start is out of date by now: a guest that stayed away from an earlier node may be
        // running here. Live 2026-11-11 one did, and went down with the restart. Anything new here is moved off.
        const here = node.restart ? await deps.runningOn(node.name) : [];
        for (const g of here) {
          if (!node.vms.some((v) => v.id === g.id)) node.vms.push({ ...g, choice: "move", state: "waiting", note: "arrived during the run" });
        }
        const running = new Set(here.map((g) => g.id));
        for (const v of node.vms) if (v.choice === "shutdown" && v.state === "waiting" && !running.has(v.id)) v.note = "wasn't running here at its turn";
        if (node.restart && node.vms.length) {
          await step(run, deps, node, "emptying", async () => {
            // One chosen to shut down that isn't running here any more is left alone.
            for (const vm of node.vms.filter((v) => v.choice === "shutdown" && running.has(v.id))) {
              vm.state = "stopping";
              deps.save(run);
              try {
                await deps.shutdown(node.name, vm);
              } catch (err) {
                vm.state = "failed";
                vm.note = plain(err);
                throw new Error(`${vm.name} didn't shut down: ${plain(err)}`);
              }
              vm.state = "off";
              deps.save(run);
            }
            const moving = node.vms.filter((v) => v.choice === "move");
            if (!moving.length) return;
            for (const vm of moving) vm.state = "moving";
            deps.save(run);
            let result: MoveOffResult;
            try {
              result = await deps.moveOff(node.name, moving.map((v) => v.id));
            } catch (err) {
              for (const vm of moving) vm.state = "failed";
              throw err;
            }
            for (const vm of moving) {
              const on = result.went[vm.id];
              if (on) {
                vm.state = "moved";
                vm.on = on;
              } else {
                // Stopped or failed partway: the ones not reached yet are simply still here, running.
                vm.state = result.error ? "waiting" : "failed";
                vm.note = `still on ${node.name}`;
              }
            }
            if (result.error) throw run.stop ? new StopError(run.stop) : new Error(result.error);
            // Never restart a node with a VM on it that was meant to be moved off.
            const left = moving.filter((v) => v.state === "failed");
            if (left.length) throw new Error(`${left.map((v) => v.name).join(", ")} didn't move off ${node.name}, so it wasn't updated or restarted.`);
          });
        }
        if (node.install) {
          await step(run, deps, node, "installing", async () => {
            const r = await deps.install(node.name);
            node.keptConfig = r.keptConfig;
            if (r.exitCode !== 0) throw new Error(`The install on ${node.name} ended with an error (apt exit code ${r.exitCode}), so it wasn't restarted.`);
            if (r.left === null) throw new Error(`BossMox couldn't confirm the updates installed on ${node.name}, so it wasn't restarted.`);
            if (r.left > 0) throw new Error(`${r.left} ${r.left === 1 ? "update is" : "updates are"} still waiting on ${node.name} after the install, so it wasn't restarted.`);
          });
        }
        if (node.restart) {
          await step(run, deps, node, "restarting", async () => {
            // Read again right before the restart: a guest may have arrived during the moves or the install (#49).
            const late = (await deps.runningOn(node.name)).filter((g) => !node.vms.some((v) => v.id === g.id && v.state === "off"));
            if (late.length) {
              for (const g of late) if (!node.vms.some((v) => v.id === g.id)) node.vms.push({ ...g, choice: "move", state: "waiting", note: "arrived during the run" });
              const lateVms = node.vms.filter((v) => late.some((g) => g.id === v.id));
              for (const vm of lateVms) vm.state = "moving";
              deps.save(run);
              const result = await deps.moveOff(node.name, lateVms.map((v) => v.id));
              for (const vm of lateVms) {
                const on = result.went[vm.id];
                if (on) {
                  vm.state = "moved";
                  vm.on = on;
                } else {
                  vm.state = "failed";
                  vm.note = `still on ${node.name}`;
                }
              }
              const left = lateVms.filter((v) => v.state === "failed");
              if (left.length) throw new Error(`${left.map((v) => v.name).join(", ")} arrived on ${node.name} during the run and didn't move off, so it wasn't restarted.`);
            }
            rebootAsked = true;
            await deps.restart(node.name);
          });
          // Starting what was shut down finishes this node's restart, so Stop doesn't skip it (#44).
          await step(run, deps, node, "starting", async () => {
            for (const vm of node.vms.filter((v) => v.state === "off")) {
              vm.state = "starting";
              deps.save(run);
              try {
                await deps.start(node.name, vm);
                vm.state = "started";
              } catch (err) {
                vm.state = "failed";
                vm.note = `didn't start: ${plain(err)}`;
              }
              deps.save(run);
            }
          }, true);
          if (node.vms.some((v) => v.state === "moved")) {
            await step(run, deps, node, "returning", async () => {
              const moved = node.vms.filter((v) => v.state === "moved");
              const stayed = await deps.moveHome(node.name, moved.map((v) => v.id));
              for (const vm of moved) {
                const away = stayed[vm.id];
                if (away) {
                  vm.state = "stayed";
                  vm.on = away.on;
                  vm.note = away.why;
                } else {
                  vm.state = "home";
                  delete vm.on;
                }
              }
            });
          }
        }
        node.phase = "done";
        node.note = node.vms.some((v) => v.state === "failed") ? `Done, but not everything started: ${node.vms.filter((v) => v.state === "failed").map((v) => v.name).join(", ")}.` : null;
        deps.save(run);
      } catch (err) {
        // Ended before the restart: start again what was shut down for it, so nothing stays off for a restart
        // that never came. (Live 2026-11-11, Stop during emptying left a container off.)
        if (node.phase === "emptying" || node.phase === "installing" || (node.phase === "restarting" && !rebootAsked)) {
          for (const vm of node.vms.filter((v) => v.state === "off")) {
            try {
              await deps.start(node.name, vm);
              vm.state = "started";
              vm.note = `started again: ${node.name} wasn't restarted`;
            } catch (e) {
              vm.state = "failed";
              vm.note = `didn't start again: ${plain(e)}`;
            }
            deps.save(run);
          }
        }
        if (err instanceof StopError) {
          run.error = `Stopped: ${err.message} ${node.phase === "checking" ? `${node.name} wasn't touched.` : `${node.name} stopped after ${node.phase}.`}`;
          if (node.phase === "checking") node.phase = "waiting";
        } else {
          node.phase = "failed";
          node.note = plain(err);
          run.error = `${node.name}: ${plain(err)}`;
        }
        deps.save(run);
        break;
      }
    }
  } finally {
    run.running = false;
    run.finishedAt = Date.now();
    deps.save(run);
  }
}
