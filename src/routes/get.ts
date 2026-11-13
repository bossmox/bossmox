/**
 * Every signed-in GET route, by name (review #61). The server checks the sign-in first and passes the session; a
 * route that isn't listed here doesn't exist. Moved out of server.ts's if-chain, which listed each one twice.
 */
import type http from "node:http";
import { waitingChanges } from "../guest-settings.js";
import { buildStorageList, setupPlan, deviceIsValid, StorageError, type RawStorageConfig } from "../storage.js";
import { pickAddresses } from "../hardware.js";
import { PveError } from "../pve.js";
import { jobFor, stillAway } from "../moves.js";
import { runFor } from "../run.js";
import { buildUsage, RANGES, type Range, type RawPoint } from "../usage.js";
import { NODE_NAME, UPID } from "../checks.js";
import { buildMovePlan, buildRebootPlan, buildTaskLog, section, taskView, type RawBackupStorage, type RawMovePrecondition, type RawTask, type RawTaskStatus } from "../server-detail.js";
import type { Session } from "../auth.js";
import type { RawStorage, RouteContext } from "../server.js";

export type GetRoute = (route: string, session: Session, params: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>;

export function getRoutes(c: RouteContext): Record<string, GetRoute> {
  const {
    FULL_LOG,
    HEALTH_CACHE_MS,
    VERSION,
    cache,
    guestPath,
    healthCache,
    jobs,
    json,
    loadBackups,
    loadCreatePlan,
    loadHealth,
    loadNetwork,
    loadRecommended,
    loadRestorePlan,
    loadServerDetail,
    loadStorageMap,
    nodeDisks,
    overview,
    pve,
    snapshotFixFor,
    updateView,
    viewerOf,
  } = c;
  const routes: Record<string, GetRoute> = {
    "/api/task": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      const upid = params.get("task") ?? "";
      if (!NODE_NAME.test(name) || !UPID.test(upid)) return json(res, 400, { error: "That task isn't valid." });
      const base = `/nodes/${encodeURIComponent(name)}/tasks/${encodeURIComponent(upid)}`;
      // The whole log is only for someone reading it. Following a running task needs just the end.
      const lines = params.get("full") === "1" ? FULL_LOG : 1000;
      const [status, log] = await Promise.all([pve.get<RawTaskStatus>(`${base}/status`, session.ticket), pve.get<{ n?: number; t?: string }[]>(`${base}/log?limit=${lines}`, session.ticket)]);
      const view = taskView(status, log, lines === FULL_LOG ? FULL_LOG : 200);
      // What the task changed should show right away, not after the cache runs out.
      if (view.finished) cache.delete(session);
      return json(res, 200, view);
    },
    "/api/move-plan": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      const id = params.get("guest") ?? "";
      const type = params.get("type");
      if (!NODE_NAME.test(name) || !/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) return json(res, 400, { error: "That move request isn't valid." });
      const data = await overview(session);
      const nodes = data.nodes.filter((n) => n.online).map((n) => n.name);
      const raw = type === "qemu" ? await pve.get<RawMovePrecondition>(`/nodes/${encodeURIComponent(name)}/qemu/${id}/migrate`, session.ticket) : {};
      const running = data.vms.find((v) => v.id === Number(id))?.running ?? false;
      return json(res, 200, buildMovePlan(type, name, nodes, raw, running));
    },
    "/api/rolling-plan": async (_route, session, _params, _req, res) => {
      return json(res, 200, await jobs.loadRollingPlan(session.ticket));
    },
    "/api/backups": async (_route, session, _params, _req, res) => {
      return json(res, 200, await loadBackups(session.ticket));
    },
    "/api/ha": async (_route, session, params, _req, res) => {
      const id = Number(params.get("id") ?? "");
      if (params.has("id")) {
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { error: "That guest isn't valid." });
        return json(res, 200, await c.ha.check(session, id));
      }
      return json(res, 200, { guests: await c.ha.list(session.ticket) });
    },
    "/api/alerts": async (_route, session, _params, _req, res) => json(res, 200, await c.alerts.view(session)),
    "/api/tiebreaker": async (_route, session, params, _req, res) => {
      // verify=1 reads pvecm status in a node's console after the person ran the setup there.
      if (params.get("verify") === "1") return json(res, 200, await c.tieBreaker.verify(session));
      const job = c.tieBreaker.job();
      return json(res, 200, { view: await c.tieBreaker.view(session), job: job && { ...job, by: job.by === session.username ? job.by : "Someone else" } });
    },
    "/api/heartbeat": async (_route, session, _params, _req, res) => {
      const job = c.heartbeat.job();
      // Who started it is a username; only that person sees it (review 2, S6).
      return json(res, 200, { view: await c.heartbeat.view(session), job: job && { ...job, by: job.by === session.username ? job.by : "Someone else" } });
    },
    "/api/recommended": async (_route, session, _params, _req, res) => {
      return json(res, 200, { settings: await loadRecommended(session) });
    },
    "/api/cpu-types": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const list = await pve.get<{ name?: string }[]>(`/nodes/${encodeURIComponent(name)}/capabilities/qemu/cpu`, session.ticket);
      return json(res, 200, { types: list.flatMap((c) => (c.name ? [c.name] : [])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
    },
    "/api/guest-waiting": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const type = params.get("type") === "lxc" ? "lxc" : "qemu";
      const { path } = guestPath(name, { guest: params.get("guest"), type });
      return json(res, 200, { waiting: waitingChanges(await pve.get<Parameters<typeof waitingChanges>[0]>(`${path}/pending`, session.ticket)) });
    },
    "/api/storage-list": async (_route, session, _params, _req, res) => {
      const [config, data] = await Promise.all([pve.get<RawStorageConfig[]>("/storage", session.ticket), overview(session)]);
      // Asked of each node directly: the cluster summary takes a while to notice a storage that was just added.
      const online = data.nodes.filter((n) => n.online).map((n) => n.name);
      const lists = await Promise.allSettled(online.map((n) => pve.get<(RawStorage & { total?: number })[]>(`/nodes/${encodeURIComponent(n)}/storage`, session.ticket)));
      const usage = online.flatMap((node, i) => {
        const r = lists[i];
        return r?.status === "fulfilled"
          ? r.value.filter((s) => s.enabled !== 0).map((s) => ({ name: s.storage, node, freeGb: (s.avail ?? 0) / 1024 ** 3, totalGb: (s.total ?? 0) / 1024 ** 3, online: s.active === 1 }))
          : [];
      });
      return json(res, 200, { list: buildStorageList(config, usage) });
    },
    "/api/health": async (_route, session, params, _req, res) => {
      const hit = healthCache.get(session);
      const fresh = params.get("again") !== "1" && hit && hit.epoch === c.epoch() && Date.now() - hit.at <= HEALTH_CACHE_MS;
      if (!fresh && !(hit?.running && hit.epoch === c.epoch())) {
        const value = loadHealth(session);
        healthCache.set(session, { at: Date.now(), value, running: true, epoch: c.epoch() });
        value
          .finally(() => {
            const now = healthCache.get(session);
            if (now?.value === value) now.running = false;
          })
          .catch(() => healthCache.delete(session));
      }
      return json(res, 200, { checks: await healthCache.get(session)!.value });
    },
    "/api/setup-plan": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const disks = await nodeDisks(name, session.ticket, await overview(session));
      try {
        const devices = (params.get("devices") ?? "").split(",").filter((d) => deviceIsValid(d));
        return json(res, 200, setupPlan(disks, devices, params.get("purpose") ?? "", params.get("name") ?? ""));
      } catch (err) {
        if (err instanceof StorageError) return json(res, 400, { error: err.message });
        throw err;
      }
    },
    "/api/usage": async (_route, session, params, _req, res) => {
      // Proxmox's own usage history, with the person's own rights: Sys.Audit for a node, VM.Audit for a guest.
      const name = params.get("server") ?? "";
      const range = params.get("range") ?? "";
      const vmid = params.get("vmid");
      const type = params.get("type");
      if (!NODE_NAME.test(name) || !(RANGES as readonly string[]).includes(range)) return json(res, 400, { error: "That usage request isn't valid." });
      if (vmid !== null && (!/^\d{1,9}$/.test(vmid) || (type !== "qemu" && type !== "lxc"))) return json(res, 400, { error: "That usage request isn't valid." });
      const base = `/nodes/${encodeURIComponent(name)}${vmid === null ? "" : `/${type}/${vmid}`}`;
      const raw = await pve.get<RawPoint[]>(`${base}/rrddata?timeframe=${range}&cf=AVERAGE`, session.ticket);
      return json(res, 200, buildUsage(Array.isArray(raw) ? raw : [], vmid === null ? "node" : "guest", range as Range));
    },
    "/api/storage-map": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      return json(res, 200, await loadStorageMap(name, session));
    },
    "/api/disks": async (route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      if (route === "/api/disks") return json(res, 200, { disks: await nodeDisks(name, session.ticket, await overview(session)) });
      const disk = params.get("disk") ?? "";
      if (!deviceIsValid(disk)) return json(res, 400, { error: "That disk isn't valid." });
      return json(res, 200, await pve.get<unknown>(`/nodes/${encodeURIComponent(name)}/disks/smart?disk=${encodeURIComponent(disk)}`, session.ticket));
    },
    "/api/disk-smart": (...a) => routes["/api/disks"]!(...a),
    "/api/tasks": async (_route, session, params, _req, res) => {
      const asked = Number(params.get("limit"));
      const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 2000) : 200;
      const data = await overview(session);
      const online = data.nodes.filter((n) => n.online).map((n) => n.name);
      const lists = await Promise.allSettled(online.map((n) => pve.get<RawTask[]>(`/nodes/${encodeURIComponent(n)}/tasks?source=all&limit=${limit}`, session.ticket)));
      const perNode = online.flatMap((node, i) => {
        const r = lists[i];
        return r?.status === "fulfilled" ? [{ node, tasks: r.value }] : [];
      });
      const unreachable = online.filter((_, i) => lists[i]?.status !== "fulfilled").concat(data.nodes.filter((n) => !n.online).map((n) => n.name));
      return json(res, 200, buildTaskLog(perNode, unreachable, data.vms, limit));
    },
    "/api/templates": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const list = await pve.get<{ template?: string; headline?: string; section?: string; package?: string }[]>(`/nodes/${encodeURIComponent(name)}/aplinfo`, session.ticket);
      return json(res, 200, { templates: list.filter((t) => t.section === "system" && t.template).map((t) => ({ template: t.template, title: t.headline || t.package || t.template })) });
    },
    "/api/guest-addresses": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const type = params.get("type") === "lxc" ? "lxc" : "qemu";
      const { path } = guestPath(name, { guest: params.get("guest"), type });
      try {
        const raw = await pve.get<unknown>(type === "lxc" ? `${path}/interfaces` : `${path}/agent/network-get-interfaces`, session.ticket);
        return json(res, 200, { addresses: pickAddresses(type, raw), known: true });
      } catch (err) {
        if (err instanceof PveError && err.status !== 401) return json(res, 200, { addresses: [], known: false });
        throw err;
      }
    },
    "/api/network": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      return json(res, 200, await loadNetwork(name, session.ticket));
    },
    "/api/create-plan": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      const kind = params.get("kind");
      if (!NODE_NAME.test(name) || (kind !== "qemu" && kind !== "lxc")) return json(res, 400, { error: "That request isn't valid." });
      return json(res, 200, await loadCreatePlan(name, kind, session.ticket));
    },
    "/api/restore-plan": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      const type = params.get("type");
      if (!NODE_NAME.test(name) || (type !== "qemu" && type !== "lxc")) return json(res, 400, { error: "That request isn't valid." });
      return json(res, 200, await loadRestorePlan(name, type, session.ticket));
    },
    "/api/snapshot-support": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const { path } = guestPath(name, { guest: params.get("guest"), type: params.get("type") });
      const feature = await pve.get<{ hasFeature?: number }>(`${path}/feature?feature=snapshot`, session.ticket);
      if (feature.hasFeature === 1 || params.get("type") !== "qemu") return json(res, 200, { supported: feature.hasFeature === 1, fix: [] });
      return json(res, 200, { supported: false, fix: await snapshotFixFor(name, path, session.ticket) });
    },
    "/api/reboot-plan": async (_route, session, params, _req, res) => {
      const name = params.get("server") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const base = `/nodes/${encodeURIComponent(name)}`;
      const [active, storages, evacuate] = await Promise.all([
        section(pve.get<RawTask[]>(`${base}/tasks?source=active`, session.ticket)),
        section(pve.get<RawBackupStorage[]>(`${base}/storage?content=backup`, session.ticket)),
        jobs.planEvacuation(session.ticket, name),
      ]);
      return json(res, 200, { ...buildRebootPlan(active, storages, evacuate.problems), evacuate });
    },
    "/api/run": async (_route, session, _params, _req, res) => {
      return json(res, 200, { run: runFor(jobs.currentRun, await viewerOf(session, jobs.currentRun?.by)) });
    },
    "/api/run-plan": async (_route, session, params, _req, res) => {
      const kind = params.get("kind") === "restart" ? "restart" : "update";
      const name = params.get("server") ?? "";
      if (kind === "restart" && !NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      return json(res, 200, await jobs.runPlan(session.ticket, kind, name));
    },
    "/api/moves": async (_route, session, _params, _req, res) => {
      // Only what's still where BossMox left it can go home; the rest was moved by someone since.
      const data = await overview(session);
      const where = new Map(data.vms.map((v) => [v.id, v.node]));
      // Another person's username only goes to someone who can change the whole cluster (review 2, S6).
      const admin = (await viewerOf(session, undefined)).full;
      const away = Object.fromEntries(
        Object.entries(jobs.moveRecord.away)
          .map(([node, a]) => [node, { by: admin || a.by === session.username ? a.by : "Someone else", at: a.at, guests: stillAway(jobs.moveRecord, node, where) }] as const)
          .filter(([, a]) => a.guests.length > 0),
      );
      return json(res, 200, { away, job: jobFor(jobs.moveRecord.job, await viewerOf(session, jobs.moveRecord.job?.by)) });
    },
    "/api/server": async (_route, session, params, _req, res) => {
      const name = params.get("name") ?? "";
      if (!NODE_NAME.test(name)) return json(res, 400, { error: "That server name isn't valid." });
      const detail = await loadServerDetail(name, session.ticket);
      const known = detail.summary || detail.updates || detail.services || detail.tasks;
      return known ? json(res, 200, detail) : json(res, 404, { error: "BossMox can't find that node, or your account can't see it." });
    },
    "/api/overview": async (_route, session, _params, _req, res) => {
      // Only after sign-in: the exact version tells an attacker what to try.
      return json(res, 200, { ...(await overview(session)), username: session.username, version: VERSION, update: updateView() });
    },
  };
  return routes;
}
