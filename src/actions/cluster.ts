
import { AuthError } from "../auth.js";
import { applyChannel, ChannelError } from "../update-channel.js";
import { canChangeCluster, KEEP_FREE_CHOICES, writePreferences } from "../preferences.js";
import { runMoveHome, runMoveOff } from "../moves.js";
import { optionsForm, RecommendedError } from "../recommended.js";
import { NODE_NAME, text } from "../checks.js";
import type { ActionContext } from "../server.js";
import type { Action } from "./action.js";
import { HttpError } from "../http-error.js";

export function clusterActions(c: ActionContext): Record<string, Action> {
  const { audit, readOptions, pve, jobs, updates } = c;
  return {
    "heartbeat-link-add": async (_name, who, body) => {
      await c.heartbeat.start(who, text(body.network, 32), text(body.confirm, 64));
      return null;
    },
    "check-updates": (name, who) => pve.post<string>(`/nodes/${encodeURIComponent(name)}/apt/update`, who),
    "update-channel": async (name, who, body) => {
      const target = body.channel;
      if (target !== "free" && target !== "enterprise") throw new HttpError(400, "That request isn't valid.");
      try {
        return await applyChannel({
          get: (p) => pve.get(p, who.ticket),
          put: (p, form) => pve.put(p, who, form),
          post: (p, form) => pve.post(p, who, form),
        }, name, target);
      } catch (err) {
        if (err instanceof ChannelError) throw new HttpError(400, err.message);
        throw err;
      }
    },
    "restart-server": async (name, who, body) => {
      // The browser only sends this after the person types "reboot", so a stray click can't restart a server.
      if (body.confirm !== "reboot") throw new HttpError(400, "The restart wasn't confirmed.");
      return pve.post<null>(`/nodes/${encodeURIComponent(name)}/status`, who, { command: "reboot" });
    },
    "move-guest": (name, who, body) => {
      const id = text(body.guest, 12);
      const target = text(body.target, 64);
      const type = body.type;
      if (!/^\d+$/.test(id) || !NODE_NAME.test(target) || (type !== "qemu" && type !== "lxc")) throw new HttpError(400, "That move request isn't valid.");
      if (body.confirm !== id) throw new HttpError(400, "The move wasn't confirmed.");
      const form: Record<string, string> = type === "qemu"
        ? { target, online: "1", "with-local-disks": "1" }
        : { target, restart: "1" };
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${type}/${id}/migrate`, who, form);
    },
    "move-off": async (name, who, body) => {
      // The browser sends this after the person has seen the plan and confirmed it for this node.
      if (body.confirm !== name) throw new HttpError(400, "The move wasn't confirmed.");
      return jobs.startMoveJob(who, async () => {
        const plan = await jobs.planEvacuation(who.ticket, name);
        if (plan.problems.length) throw new HttpError(400, plan.problems.join(" "));
        if (!plan.moves.length) return null;
        const batch = await jobs.batchFor(who.ticket);
        return (deps) => runMoveOff(jobs.moveRecord, deps, name, who.username, plan.moves, batch);
      });
    },
    "move-home": async (name, who, body) => {
      if (body.confirm !== name) throw new HttpError(400, "The move wasn't confirmed.");
      return jobs.startMoveJob(who, async () => {
        if (!jobs.moveRecord.away[name]?.guests.length) throw new HttpError(400, `BossMox has nothing recorded as moved off ${name}.`);
        const batch = await jobs.batchFor(who.ticket);
        return (deps) => runMoveHome(jobs.moveRecord, deps, name, who.username, batch);
      });
    },
    "run-start": (_name, who, body) => {
      const kind = body.kind === "restart" ? "restart" : body.kind === "update" ? "update" : null;
      if (!kind) throw new HttpError(400, "That request isn't valid.");
      const server = text(body.server, 64);
      if (kind === "restart" && !NODE_NAME.test(server)) throw new HttpError(400, "That server name isn't valid.");
      const choices = (body.choices && typeof body.choices === "object" ? body.choices : {}) as Record<string, unknown>;
      return jobs.startRun(who, kind, server, body.confirm === (kind === "update" ? "confirm" : "reboot"), choices);
    },
    "run-stop": async (_name, who) => {
      if (!jobs.currentRun?.running) return null;
      // The person who started it, or anyone who can change the cluster's settings.
      if (jobs.currentRun.by !== who.username) {
        const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", who.ticket).catch((): Record<string, Record<string, number>> => ({}));
        if (!canChangeCluster(perms)) throw new AuthError(403, "Only the person who started it, or someone who can change the cluster's settings, can stop it.");
      }
      jobs.currentRun.stop = `${who.username} pressed Stop.`;
      jobs.saveRun(jobs.currentRun);
      return null;
    },
    "move-stop": async (_name, who) => {
      const job = jobs.moveRecord.job;
      if (!job?.running) return null;
      if (job.by !== who.username) throw new AuthError(403, `Only ${job.by}, who started these moves, can stop them.`);
      // The move under way finishes; nothing new starts.
      jobs.moveJob.stop = `${who.username} pressed Stop.`;
      return null;
    },
    "update-check-now": async () => {
      // Anyone signed in may ask; the checker answers from its last look if that was under a minute ago.
      await updates.checkNow();
      return null;
    },
    "preferences-set": async (_name, who, body) => {
      const elsewhere = body.backupsElsewhere, check = body.updateCheck, keep = body.keepFreePct;
      if ((elsewhere !== undefined && typeof elsewhere !== "boolean") || (check !== undefined && typeof check !== "boolean") || (keep !== undefined && !(typeof keep === "number" && KEEP_FREE_CHOICES.includes(keep))) || (elsewhere === undefined && check === undefined && keep === undefined))
        throw new HttpError(400, "That request isn't valid.");
      // A cluster-wide choice needs the right to change the cluster's own settings in Proxmox (ADR 0018).
      const perms = await pve.get<Record<string, Record<string, number>>>("/access/permissions?path=%2F", who.ticket).catch((): Record<string, Record<string, number>> => ({}));
      if (!canChangeCluster(perms)) throw new AuthError(403, "Your Proxmox account can't change settings for the whole cluster. That needs the Sys.Modify permission on the whole cluster (/).");
      const next = { ...c.preferences(), ...(typeof elsewhere === "boolean" ? { backupsElsewhere: elsewhere } : {}), ...(typeof check === "boolean" ? { updateCheck: check } : {}), ...(typeof keep === "number" ? { keepFreePct: keep } : {}) };
      try {
        writePreferences(c.preferencesFile, next);
      } catch {
        throw new HttpError(500, "BossMox couldn't save that setting. Nothing changed.");
      }
      const turned = next.updateCheck !== c.preferences().updateCheck;
      c.setPreferences(next);
      if (turned) await updates.setOn(next.updateCheck);
      c.bumpEpoch();
      return null;
    },
    "recommended-set": async (_name, who, body) => {
      const id = body.id;
      if ((id !== "move-network" && id !== "move-limit" && id !== "ha-shutdown") || typeof body.on !== "boolean") throw new HttpError(400, "That request isn't valid.");
      const { options, net } = await readOptions(who.ticket);
      let form: Record<string, string>;
      try {
        form = optionsForm(id, body.on, text(body.choice, 43), options, net);
      } catch (err) {
        if (err instanceof RecommendedError) throw new HttpError(400, err.message);
        throw err;
      }
      await pve.put<null>("/cluster/options", who, form);
      audit("cluster-option", who.username, "settings", { [id]: body.on ? "on" : "off", ...form });
      // Health check reads these too, so its kept answer is out of date now.
      c.bumpEpoch();
      return null;
    },
  };
}
