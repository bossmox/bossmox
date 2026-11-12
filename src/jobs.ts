/**
 * Moving guests and update or restart runs (ADR 0025, 0027): planning where guests go, the move job, and the run
 * itself, with the state they share. Moved out of server.ts (review #61) so the deciding parts can be tested
 * against a fake Proxmox. The server only wires it: it passes Proxmox access and settings in through `JobsContext`.
 */
import { networkInterfaces } from "node:os";
import { AuthError, type Session } from "./auth.js";
import { discForm } from "./create.js";
import { checkNetworks, migrationNetwork, SAFE_BATCH, type NetCheck } from "./cluster-net.js";
import type { Overview, RawConfig, RawResource, RawSnapshot } from "./model.js";
import { readMoves, runMoveHome, runMoveOff, writeMoves, type MoveDeps } from "./moves.js";
import { INSTALL_COMMAND, runOnNode, STILL_RUNNING, type ShellConfig } from "./node-shell.js";
import { asEjected, gbText, guestNeed, planMoves, room as roomFor, type MovePlan, type NodeRoom, type Pending, type RawPrecondition } from "./placement.js";
import type { Preferences } from "./preferences.js";
import { PveError, type PveClient } from "./pve.js";
import { drive, readRun, writeRun, type Choice, type Run, type RunDeps, type RunNode } from "./run.js";
import { buildRebootPlan, buildRollingPlan, groupUpdates, haQuorumBlock, section, tieBreakerVotes, type RawStatus, type RawTask, type RawTaskStatus, type RawUpdate, type RollingInput, type Section } from "./server-detail.js";
import type { TermProxy } from "./terminal.js";

/** What the jobs need from the server. Tests pass a fake Proxmox and files in a temporary folder. */
export interface JobsContext {
  pve: Pick<PveClient, "get" | "post" | "put">;
  preferences: () => Preferences;
  loadOverview: (ticket: string) => Promise<Overview>;
  audit: (event: string, who: string, address: string, fields?: Record<string, string | number>) => void;
  /** A job ended: the person's cached overview is out of date. */
  jobEnded: (session: Session) => void;
  shell: () => ShellConfig;
  movesFile: string;
  runsFile: string;
  /** This BossMox's own network cards; the real ones unless a test says otherwise. */
  macs?: () => Set<string>;
}

/** The MAC addresses of this BossMox's own network cards: the VM that has one of them is BossMox itself. */
function ownMacs(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flat().map((i) => i?.mac?.toLowerCase() ?? "").filter((m) => m && m !== "00:00:00:00:00:00"));
}

export function createJobs(ctx: JobsContext) {
  const { pve } = ctx;
  const enc = encodeURIComponent;
  /** Guests moved off a node and the job moving them (ADR 0025). One job at a time across the cluster. */
  const moveRecord = readMoves(ctx.movesFile);
  const moveJob: { session: Session | null; stop: string | null; starting: boolean } = { session: null, stop: null, starting: false };
  /**
   * Fresh numbers from Proxmox, and where each guest of `from` would go (ADR 0025). Without `ids` it plans every
   * running guest. With `only`, that node is the one target allowed (sending guests home).
   */
  async function planEvacuation(ticket: string, from: string, ids?: number[], only?: string, pending: Pending = {}, assumeEjected: number[] = []) {
    const resources = await pve.get<RawResource[]>("/cluster/resources", ticket);
    const online = resources.filter((r) => r.type === "node" && r.status === "online" && (!only || r.node === from || r.node === only));
    const statuses = await Promise.all(online.map((n) => pve.get<RawStatus>(`/nodes/${enc(n.node ?? "")}/status`, ticket).catch(() => null)));
    const storagesOf = (node: string) => Object.fromEntries(resources
      .filter((r) => r.type === "storage" && r.node === node && r.status === "available")
      .map((r) => [r.storage ?? "", { free: (r.maxdisk ?? 0) - (r.disk ?? 0), total: r.maxdisk ?? 0, shared: r.shared === 1 }]));
    const nodes: NodeRoom[] = online.map((r, i) => ({
      name: r.node ?? "",
      version: statuses[i]?.pveversion?.split("/")[1] ?? null,
      cpuModel: statuses[i]?.cpuinfo?.model ?? null,
      cores: r.maxcpu ?? 0,
      cpuLoad: (r.cpu ?? 0) * (r.maxcpu ?? 0),
      memTotal: r.maxmem ?? 0,
      memUsed: r.mem ?? 0,
      storages: storagesOf(r.node ?? ""),
    }));
    // A guest that just arrived shows only the memory it has touched so far. Everything BossMox moved counts at its
    // full set memory, so planning again between moves can't fill a node the first plan had already filled.
    const arrived = new Set([...Object.values(moveRecord.away).flatMap((a) => a.guests.map((g) => g.id)), ...(moveRecord.job?.guests.filter((g) => g.state === "done").map((g) => g.id) ?? [])]);
    for (const r of resources) {
      const n = nodes.find((x) => x.name === r.node);
      if (n && (r.type === "qemu" || r.type === "lxc") && r.status === "running" && arrived.has(Number(r.vmid))) n.memUsed += Math.max(0, (r.maxmem ?? 0) - (r.mem ?? 0));
    }
    for (const n of nodes) {
      n.memUsed += pending[n.name]?.mem ?? 0;
      n.cpuLoad += pending[n.name]?.cpu ?? 0;
    }
    // Restricted HA groups (Proxmox 8): a guest in one may only run on the group's nodes.
    const [haResources, haGroups] = await Promise.all([
      pve.get<{ sid?: string; group?: string }[]>("/cluster/ha/resources", ticket).catch(() => []),
      pve.get<{ group?: string; nodes?: string; restricted?: number }[]>("/cluster/ha/groups", ticket).catch(() => []),
    ]);
    const haNodesOf = (type: string, id: number) => {
      const group = haResources.find((r) => r.sid === `${type === "lxc" ? "ct" : "vm"}:${id}`)?.group;
      const g = group ? haGroups.find((x) => x.group === group && x.restricted === 1) : undefined;
      return g ? (g.nodes ?? "").split(",").map((n) => n.split(":")[0]?.trim() ?? "").filter(Boolean) : undefined;
    };
    const guests = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.node === from && r.template !== 1 && (ids ? ids.includes(Number(r.vmid)) : r.status === "running" || r.status === "paused"));
    const needs = await Promise.all(guests.map(async (g) => {
      const type = g.type === "lxc" ? "lxc" : "qemu";
      const id = Number(g.vmid);
      const base = `/nodes/${enc(from)}/${type}/${id}`;
      const [read, snaps, checked] = await Promise.all([
        pve.get<RawConfig>(`${base}/config`, ticket),
        pve.get<RawSnapshot[]>(`${base}/snapshot`, ticket).catch((): RawSnapshot[] => []),
        // Older Proxmox has no migrate check for containers; BossMox's own storage check still applies.
        pve.get<RawPrecondition>(`${base}/migrate`, ticket).catch((): RawPrecondition => ({})),
      ]);
      // Planned as if its discs were out, when a person chose to eject them; they only come out once every check passes.
      const assumed = assumeEjected.includes(id);
      const config = assumed ? (asEjected(read).config as RawConfig) : read;
      const precondition = assumed ? { ...checked, local_disks: (checked.local_disks ?? []).filter((d) => !d.cdrom) } : checked;
      return guestNeed({
        id,
        type,
        name: g.name ?? String(config.name ?? config.hostname ?? `VM ${id}`),
        mem: g.maxmem ?? 0,
        cores: g.maxcpu ?? 0,
        cpuLoad: (g.cpu ?? 0) * (g.maxcpu ?? 0),
        config,
        hasSnapshots: snaps.some((s) => s.name !== "current"),
        precondition,
        sourceStorages: storagesOf(from),
        ...(haNodesOf(type, id) ? { haNodes: haNodesOf(type, id) as string[] } : {}),
      });
    }));
    const keep = ctx.preferences().keepFreePct;
    const plan: MovePlan = planMoves(from, needs, nodes, keep);
    // What each other node has now and would have after, so the person sees why it was picked.
    const room = nodes.filter((n) => n.name !== from).map((n) => {
      const adds = plan.moves.filter((m) => m.target === n.name).reduce((sum, m) => sum + (needs.find((g) => g.id === m.id)?.mem ?? 0), 0);
      return { name: n.name, guests: plan.moves.filter((m) => m.target === n.name).length, freeNow: gbText(n.memTotal - n.memUsed), freeAfter: gbText(n.memTotal - n.memUsed - adds), keeps: gbText((n.memTotal * roomFor(keep).memFreePct) / 100) };
    });
    return { ...plan, room, keepFreePct: keep };
  }

  /** How a move job reaches Proxmox: always with the person's current login, which renewals replace. */
  function moveDeps(session: Session): MoveDeps {
    return {
      plan: (from, ids, only, pending) => planEvacuation(session.ticket, from, ids, only, pending),
      migrate: async (move, from) => {
        const base = `/nodes/${enc(from)}/${move.type}/${move.id}`;
        const now = await pve.get<{ status?: string }>(`${base}/status/current`, session.ticket);
        const running = now.status === "running" || now.status === "paused";
        const form: Record<string, string> = move.type === "qemu"
          ? { target: move.target, "with-local-disks": "1", ...(running ? { online: "1" } : {}) }
          : { target: move.target, ...(running ? { restart: "1" } : {}) };
        // A node that has just come back can refuse a move for a few seconds. A refusal means nothing started.
        for (const until = Date.now() + 60 * 1000; ; await new Promise((r) => setTimeout(r, 5000))) {
          try {
            return await pve.post<string>(`${base}/migrate`, session, form);
          } catch (err) {
            if (!(err instanceof PveError) || err.status === 401 || err.status === 403 || Date.now() > until) throw err;
          }
        }
      },
      task: async (node, upid) => {
        const s = await pve.get<RawTaskStatus>(`/nodes/${enc(node)}/tasks/${enc(upid)}/status`, session.ticket);
        const exit = s.exitstatus ?? "";
        return { finished: s.status === "stopped", ok: exit === "OK" || exit.startsWith("WARNINGS"), error: exit || "unknown error" };
      },
      where: async () => new Map((await pve.get<RawResource[]>("/cluster/resources?type=vm", session.ticket)).map((r) => [Number(r.vmid), r.node ?? ""])),
      stopped: () => moveJob.stop,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      save: (record) => {
        try {
          writeMoves(ctx.movesFile, record);
        } catch (err) {
          console.error("Couldn't save the move record:", (err as Error).message);
        }
      },
    };
  }

  /** Starts a move job in the background. The check and the claim happen before any wait, so two can't start. */
  async function startMoveJob(session: Session, prepare: () => Promise<((deps: MoveDeps) => Promise<void>) | null>): Promise<string | null> {
    // A run claims the cluster before its first wait, while it plans; that counts as going too (#45).
    if (currentRun?.running || runState.starting) throw new AuthError(409, "An update or restart run is going. Its moves are part of it.");
    if (moveJob.starting || moveRecord.job?.running) throw new AuthError(409, `BossMox is already moving guests${moveRecord.job?.running ? ` (${moveRecord.job.kind === "off" ? "off" : "home to"} ${moveRecord.job.node})` : ""}. Wait for that to finish.`);
    moveJob.starting = true;
    try {
      const run = await prepare();
      if (!run) return null;
      moveJob.session = session;
      moveJob.stop = null;
      void run(moveDeps(session))
        .catch((err: Error) => console.error("Move job failed:", err.message))
        .finally(() => {
          moveJob.session = null;
          ctx.jobEnded(session);
        });
      // The job is on the record by now; its start time is how the page knows it's following this one.
      return moveRecord.job ? `job:${moveRecord.job.startedAt}` : null;
    } finally {
      moveJob.starting = false;
    }
  }

  async function loadRollingPlan(ticket: string, assumeEjected: number[] = []) {
    const data = await ctx.loadOverview(ticket);
    const [cluster, tieBreaker, servers] = await Promise.all([
      section(pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", ticket)),
      section(pve.get<{ State?: string }>("/cluster/config/qdevice", ticket)),
      Promise.all(data.nodes.map(async (n): Promise<RollingInput> => {
        if (!n.online) return { name: n.name, online: false, version: null, updates: null, rebootNeeded: false, busy: [], cantMove: [], ejectable: [] };
        const base = `/nodes/${encodeURIComponent(n.name)}`;
        const [status, updates, active] = await Promise.all([
          section(pve.get<RawStatus>(`${base}/status`, ticket)),
          section(pve.get<RawUpdate[]>(`${base}/apt/update`, ticket)),
          section(pve.get<RawTask[]>(`${base}/tasks?source=active`, ticket)),
        ]);
        const list = updates.available ? groupUpdates(updates.value) : null;
        // Each node that restarts is planned against the cluster as it is now: guests go home before the next one.
        const evac = list?.rebootNeeded && list.total > 0
          ? await planEvacuation(ticket, n.name, undefined, undefined, {}, assumeEjected).catch((err: Error) => ({ problems: [`BossMox couldn't plan the moves: ${err.message}`], ejectable: [] }))
          : { problems: [], ejectable: [] };
        const cantMove = evac.problems.map((p) => `${n.name}: ${p}`);
        const ejectable = (evac.ejectable ?? []).map((g) => ({ ...g, node: n.name }));
        return {
          name: n.name,
          online: true,
          version: status.available ? status.value.pveversion?.split("/")[1] ?? null : null,
          updates: list ? list.total : null,
          rebootNeeded: list?.rebootNeeded ?? false,
          busy: buildRebootPlan(active, { available: false }).busy,
          cantMove,
          ejectable,
        };
      })),
    ]);
    const quorate: Section<boolean> = cluster.available
      ? { available: true, value: cluster.value.find((c) => c.type === "cluster")?.quorate === 1 }
      : { available: false };
    return buildRollingPlan(servers, quorate, tieBreaker);
  }

  /* Update and restart runs on the server (ADR 0027). */
  let currentRun: Run | null = readRun(ctx.runsFile);
  const runState: { session: Session | null; starting: boolean } = { session: null, starting: false };
  const saveRun = (run: Run) => {
    try {
      writeRun(ctx.runsFile, run);
    } catch (err) {
      console.error("Couldn't save the run:", (err as Error).message);
    }
  };

  const isSelf = (config: RawConfig, macs: Set<string>) => Object.entries(config).some(([k, v]) => /^net\d+$/.test(k) && [...macs].some((m) => String(v).toLowerCase().includes(m)));

  const waitTask = async (node: string, upid: string, ticket: string, limitMs: number) => {
    for (const until = Date.now() + limitMs; ; await new Promise((r) => setTimeout(r, 2000))) {
      const s = await pve.get<RawTaskStatus>(`/nodes/${enc(node)}/tasks/${enc(upid)}/status`, ticket).catch(() => null);
      if (s?.status === "stopped") {
        const exit = s.exitstatus ?? "";
        if (exit === "OK" || exit.startsWith("WARNINGS")) return;
        throw new Error(exit || "it failed");
      }
      if (Date.now() > until) throw new Error("it took too long");
    }
  };

  interface PlanVm { id: number; name: string; type: "qemu" | "lxc"; canMove: boolean; why: string; to: string | null; self: boolean; discSlots: string[]; choice: "move" | "shutdown" }
  /** What a run would do on each node, with a choice per running VM: what it can do, and the safe default. */
  async function runPlan(ticket: string, kind: "update" | "restart", server: string, assumeEjected: number[] = []) {
    const macs = (ctx.macs ?? ownMacs)();
    const rolling = kind === "update" ? await loadRollingPlan(ticket, assumeEjected) : null;
    const nodes = kind === "update"
      ? (rolling?.servers ?? []).map((s) => ({ name: s.name, version: s.version, updates: s.updates ?? 0, restart: s.rebootNeeded, install: true }))
      : [{ name: server, version: null, updates: 0, restart: true, install: false }];
    const out = await Promise.all(nodes.map(async (n) => {
      if (!n.restart) return { ...n, vms: [] as PlanVm[] };
      const evac = await planEvacuation(ticket, n.name, undefined, undefined, {}, assumeEjected);
      const resources = await pve.get<RawResource[]>("/cluster/resources?type=vm", ticket);
      const running = resources.filter((r) => r.node === n.name && (r.status === "running" || r.status === "paused") && r.template !== 1);
      const vms: PlanVm[] = await Promise.all(running.map(async (r) => {
        const id = Number(r.vmid);
        const type = r.type === "lxc" ? "lxc" : "qemu";
        const config = await pve.get<RawConfig>(`/nodes/${enc(n.name)}/${type}/${id}/config`, ticket).catch((): RawConfig => ({}));
        const unplaced = evac.unplaced?.find((u) => u.id === id);
        const to = evac.tentative?.find((m) => m.id === id)?.target ?? null;
        const self = isSelf(config, macs);
        return { id, name: r.name ?? `VM ${id}`, type, canMove: !unplaced, why: unplaced?.why ?? "", to, self, discSlots: evac.ejectable?.find((e) => e.id === id)?.slots ?? [], choice: unplaced && !self ? "shutdown" : "move" };
      }));
      return { ...n, vms: vms.sort((a, b) => a.name.localeCompare(b.name)) };
    }));
    // Rooms counted with every VM moving; a person's Shut down choices only free more.
    const blocked = [...(rolling?.blocked.filter((b) => !rolling.servers.some((s) => b.startsWith(`${s.name}: `))) ?? [])];
    for (const n of out) for (const v of n.vms) {
      if (!v.self) continue;
      // A running container only moves by stopping, which would stop BossMox in the middle of the run (#46).
      if (v.type === "lxc") blocked.push(`BossMox runs in the container ${v.name} on ${n.name}. A container can't move without stopping, and that would stop BossMox in the middle of the run. Restart ${n.name} from Proxmox instead, after moving its other guests.`);
      else if (!v.canMove) blocked.push(`BossMox runs in ${v.name} on ${n.name}, and it can't move: ${v.why} BossMox can't shut itself down, so this has to be fixed first.`);
    }
    // Votes for both kinds of run, counted the same way (#43, #51).
    const [members, qdevice, ha] = await Promise.all([
      pve.get<unknown[]>("/cluster/config/nodes", ticket).catch(() => []),
      pve.get<{ State?: string }>("/cluster/config/qdevice", ticket).catch(() => null),
      pve.get<{ sid?: string }[]>("/cluster/ha/resources", ticket).catch(() => []),
    ]);
    const votes = rolling?.votes ?? members.length + (tieBreakerVotes(qdevice) ? 1 : 0);
    const haBlock = out.some((n) => n.restart) ? haQuorumBlock(votes, members.length, ha.filter((r) => /^(vm|ct):/.test(r.sid ?? "")).length) : null;
    if (haBlock) blocked.push(haBlock);
    const net = await readNetCheck(ticket);
    return { kind, nodes: out, blocked, votes, keepsMajority: votes >= 3, keepFreePct: ctx.preferences().keepFreePct, moveBatch: net.batch, moveShared: net.known && net.shared };
  }

  /**
   * Whether moves share the heartbeat's only network (ADR 0028), read fresh from Proxmox. Anything it can't read
   * gives "can't tell", which means the careful one-at-a-time moves.
   */
  async function readNetCheck(ticket: string): Promise<NetCheck> {
    try {
      const [config, options, resources] = await Promise.all([
        pve.get<Record<string, unknown>[]>("/cluster/config/nodes", ticket),
        pve.get<{ migration?: string | { network?: string } }>("/cluster/options", ticket),
        pve.get<RawResource[]>("/cluster/resources?type=node", ticket),
      ]);
      const online = new Set(resources.filter((r) => r.status === "online").map((r) => r.node));
      if (config.some((c) => !online.has(String(c.node ?? c.name ?? "")))) return checkNetworks([], null);
      const nodes = await Promise.all(config.map(async (c) => {
        const name = String(c.node ?? c.name ?? "");
        const links = Object.keys(c).filter((k) => /^ring\d+_addr$/.test(k)).sort().map((k) => String(c[k]));
        const ifaces = await pve.get<{ cidr?: string }[]>(`/nodes/${enc(name)}/network`, ticket);
        return { name, links, addresses: ifaces.flatMap((i) => (i.cidr ? [i.cidr] : [])) };
      }));
      return checkNetworks(nodes, migrationNetwork(options.migration));
    } catch {
      return checkNetworks([], null);
    }
  }
  const batchFor = (ticket: string) => readNetCheck(ticket).then((c) => c.batch, () => SAFE_BATCH);

  /** How long bringing guests home waits for a just-restarted node's processor to calm down. */
  const RETURN_SETTLE_MS = 5 * 60 * 1000;

  /** How a run reaches Proxmox and the move job, always with the starting person's current login. */
  function runDeps(session: Session, run: Run): RunDeps {
    const t = () => session.ticket;
    const moves: MoveDeps = { ...moveDeps(session), stopped: () => run.stop ?? moveJob.stop };
    return {
      stopped: () => run.stop,
      save: saveRun,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      notReady: async (node) => {
        const [status, resources, active] = await Promise.all([
          pve.get<{ type?: string; quorate?: number }[]>("/cluster/status", t()).catch(() => null),
          pve.get<RawResource[]>("/cluster/resources?type=node", t()).catch(() => null),
          section(pve.get<RawTask[]>(`/nodes/${enc(node)}/tasks?source=active`, t())),
        ]);
        if (!status || !resources) return "BossMox can't tell whether the cluster is healthy.";
        if (status.some((c) => c.type === "cluster") && status.find((c) => c.type === "cluster")?.quorate !== 1) return "The cluster has lost its majority.";
        const off = resources.filter((r) => r.status !== "online").map((r) => r.node);
        if (off.length) return `Waiting for these to come back online: ${off.join(", ")}.`;
        const busy = buildRebootPlan(active, { available: false }).busy;
        return busy.length ? `${node} is busy: ${busy.join(", ")}.` : null;
      },
      runningOn: async (node) => (await pve.get<RawResource[]>("/cluster/resources?type=vm", t()))
        .filter((r) => r.node === node && r.template !== 1 && (r.status === "running" || r.status === "paused"))
        .map((r) => ({ id: Number(r.vmid), name: r.name ?? `VM ${r.vmid}`, type: r.type === "lxc" ? "lxc" as const : "qemu" as const })),
      shutdown: async (node, vm) => {
        const upid = await pve.post<string>(`/nodes/${enc(node)}/${vm.type}/${vm.id}/status/shutdown`, session, { timeout: "180", forceStop: "1" });
        await waitTask(node, upid, t(), 5 * 60 * 1000);
      },
      moveOff: async (node, ids) => {
        const plan = await planEvacuation(t(), node, ids);
        if (plan.problems.length) throw new Error(plan.problems.join(" "));
        await runMoveOff(moveRecord, moves, node, session.username, plan.moves, await batchFor(t()));
        // Where each one is now, read from Proxmox: one may already have gone, moved home to another node earlier in the run.
        const where = await moves.where();
        const went = Object.fromEntries(ids.filter((id) => where.has(id) && where.get(id) !== node).map((id) => [id, where.get(id) as string]));
        return { went, error: moveRecord.job?.error ?? null };
      },
      install: async (node) => {
        const proxy = await pve.post<TermProxy>(`/nodes/${enc(node)}/termproxy`, session);
        const r = await runOnNode(ctx.shell(), node, t(), proxy, INSTALL_COMMAND);
        if (r.exitCode === STILL_RUNNING) throw new Error(`An earlier update is still installing on ${node}, so BossMox didn't start another. Wait for it to finish, then run again.`);
        const left = await pve.get<RawUpdate[]>(`/nodes/${enc(node)}/apt/update`, t()).then((u) => groupUpdates(u).total, () => null);
        return { exitCode: r.exitCode, keptConfig: r.keptConfig, left };
      },
      restart: async (node) => {
        const asked = Date.now();
        await pve.post<null>(`/nodes/${enc(node)}/status`, session, { command: "reboot" });
        for (const until = asked + 20 * 60 * 1000; ; await new Promise((r) => setTimeout(r, 5000))) {
          const s = await pve.get<RawStatus>(`/nodes/${enc(node)}/status`, t()).catch(() => null);
          const back = s?.uptime !== undefined && s.uptime * 1000 < Date.now() - asked;
          if (back) {
            const resources = await pve.get<RawResource[]>("/cluster/resources?type=node", t()).catch(() => []);
            if (resources.some((r) => r.node === node && r.status === "online")) return;
          }
          if (Date.now() > until) throw new Error(`${node} hasn't come back after 20 minutes. Someone may need to look at the node itself.`);
        }
      },
      start: async (node, vm) => {
        // A node that has just come back can refuse for a few seconds.
        for (let i = 0; ; i++) {
          try {
            // Start at boot or HA may have started it already, and starting a running guest fails (#59).
            const now = await pve.get<{ status?: string }>(`/nodes/${enc(node)}/${vm.type}/${vm.id}/status/current`, t()).catch(() => null);
            if (now?.status === "running") return;
            const upid = await pve.post<string>(`/nodes/${enc(node)}/${vm.type}/${vm.id}/status/start`, session);
            return await waitTask(node, upid, t(), 5 * 60 * 1000);
          } catch (err) {
            if (i >= 6 || (err instanceof PveError && (err.status === 401 || err.status === 403))) throw err;
            await new Promise((r) => setTimeout(r, 10_000));
          }
        }
      },
      moveHome: async (node, ids) => {
        const notes = new Map<number, string>();
        if (moveRecord.away[node]?.guests.length) {
          // A node just back from a restart is busy for a while. Give it up to 5 minutes to drop under the processor cap.
          const cap = 100 - ctx.preferences().keepFreePct;
          const until = Date.now() + RETURN_SETTLE_MS;
          for (; Date.now() < until; await new Promise((r) => setTimeout(r, 10_000))) {
            const s = await pve.get<RawStatus>(`/nodes/${enc(node)}/status`, t()).catch(() => null);
            if (s && (s.cpu ?? 0) * 100 <= cap) break;
          }
          // Each guest that comes home makes the node busier, so one turned away for that alone gets the rest of the window.
          await runMoveHome(moveRecord, moves, node, session.username, await batchFor(t()), Math.max(0, until - Date.now()));
          const job = moveRecord.job;
          if (job?.error) throw new Error(job.error);
          for (const g of job?.guests ?? []) if (g.state === "stayed") notes.set(g.id, g.note ?? "its home had no room");
        }
        const where = await moves.where();
        const out: Record<number, { on: string; why: string }> = {};
        for (const id of ids) {
          const on = where.get(id);
          if (on === undefined || on === node) continue;
          out[id] = { on, why: notes.get(id) ?? "BossMox's record has another node as its home" };
        }
        return out;
      },
    };
  }

  /** Starts a run with the person's choices. Everything is checked again here; the page's copy is only a request. */
  async function startRun(session: Session, kind: "update" | "restart", server: string, confirmed: boolean, choices: Record<string, unknown>): Promise<string> {
    if (!confirmed) throw new AuthError(400, "It wasn't confirmed.");
    if (currentRun?.running || runState.starting) throw new AuthError(409, "A run is already going. Open it to follow or stop it.");
    if (moveRecord.job?.running || moveJob.starting) throw new AuthError(409, "BossMox is moving guests right now. Wait for that to finish.");
    runState.starting = true;
    try {
      // Discs chosen to come out are planned as already out. Nothing is ejected until every check below passes (#48).
      const eject = Object.entries(choices).filter(([, c]) => c === "eject").map(([id]) => Number(id));
      const plan = await runPlan(session.ticket, kind, server, eject);
      if (plan.blocked.length) throw new AuthError(400, plan.blocked.join(" "));
      if (kind === "update" && !plan.nodes.length) throw new AuthError(400, "Every node is up to date.");
      const nodes: RunNode[] = plan.nodes.map((n) => ({
        name: n.name, install: n.install, restart: n.restart, updates: n.updates, phase: "waiting", note: null, keptConfig: [],
        vms: n.vms.map((v) => {
          const asked = choices[String(v.id)];
          const choice: Choice = v.self ? "move" : asked === "shutdown" ? "shutdown" : asked === "move" || asked === "eject" ? "move" : v.choice;
          return { id: v.id, name: v.name, type: v.type, choice, state: "waiting" as const };
        }),
      }));
      // Everything chosen to move has to fit together, node by node.
      for (const n of nodes) {
        const moving = n.vms.filter((v) => v.choice === "move").map((v) => v.id);
        if (!moving.length || !n.restart) continue;
        const check = await planEvacuation(session.ticket, n.name, moving, undefined, {}, eject);
        if (check.problems.length) throw new AuthError(400, `${n.name}: ${check.problems.join(" ")} Choose Shut down for it, or lower Keep free.`);
      }
      // Every check passed. Only now do the chosen discs come out.
      for (const n of plan.nodes) for (const v of n.vms.filter((x) => eject.includes(x.id) && x.type === "qemu")) {
        const path = `/nodes/${enc(n.name)}/qemu/${v.id}`;
        const current = await pve.get<RawConfig>(`${path}/config`, session.ticket);
        const { slots } = asEjected(current);
        for (const slot of slots) await pve.put<null>(`${path}/config`, session, discForm("", current, slot));
        if (slots.length) ctx.audit("eject", session.username, "run", { node: n.name, guest: v.id });
      }
      currentRun = { id: `run:${Date.now()}`, kind, by: session.username, startedAt: Date.now(), finishedAt: null, running: true, stop: null, error: null, current: 0, nodes };
      const run = currentRun;
      runState.session = session;
      moveJob.stop = null;
      saveRun(run);
      void drive(run, runDeps(session, run))
        .catch((err: Error) => console.error("Run failed:", err.message))
        .finally(() => {
          runState.session = null;
          ctx.jobEnded(session);
        });
      return run.id;
    } finally {
      runState.starting = false;
    }
  }

  return {
    moveRecord,
    moveJob,
    runState,
    get currentRun() {
      return currentRun;
    },
    saveRun,
    planEvacuation,
    runPlan,
    startRun,
    startMoveJob,
    loadRollingPlan,
    readNetCheck,
    batchFor,
  };
}
export type Jobs = ReturnType<typeof createJobs>;
