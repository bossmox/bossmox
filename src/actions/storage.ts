
import { AuthError } from "../auth.js";
import { assertCanWipe, setupPlan, deviceIsValid, diskStorageForm, networkForm, storageBlockers, usesForm, type RawStorageConfig } from "../storage.js";
import { poolItems, poolRemoval, type RawVolume } from "../storage-map.js";
import { STORAGE, text } from "../checks.js";
import type { ActionContext } from "../server.js";
import type { Action } from "./action.js";

export function storageActions(c: ActionContext): Record<string, Action> {
  const { finishTask, guestRefs, loadOverview, nodeDisks, rule, seesAllGuests, storageMapFor, usesStorageNames, pve } = c;
  return {
    "storage-add": async (name, who, body) => {
      const form = rule(() => networkForm({ kind: text(body.kind, 8), id: text(body.id, 64), host: text(body.host, 253), path: text(body.path, 255), username: text(body.username, 64), password: text(body.password, 256), domain: text(body.domain, 64), uses: body.uses }));
      await pve.post<null>("/storage", who, form);
      // Saving doesn't prove it works, so ask a node to use it. One that can't connect isn't left behind.
      const path = `/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(form.storage as string)}/status`;
      for (let i = 0; i < 8; i++) {
        const status = await pve.get<{ active?: number }>(path, who.ticket).catch(() => null);
        if (status?.active === 1) return null;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await pve.delete<null>(`/storage/${encodeURIComponent(form.storage as string)}`, who).catch(() => null);
      throw new AuthError(400, `${name} couldn't connect to that share, so it wasn't added. Check that the NAS lets this node in.`);
    },
    "content-delete": async (name, who, body) => {
      const storage = text(body.storage, 64);
      const volid = text(body.volid, 300);
      if (!STORAGE.test(storage) || !volid || body.confirm !== volid) throw new AuthError(400, "That wasn't confirmed.");
      const base = `/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}`;
      // Fresh, not the cached overview: a guest made a moment ago must count.
      const [volumes, data] = await Promise.all([pve.get<RawVolume[]>(`${base}/content`, who.ticket), loadOverview(who.ticket)]);
      const item = poolItems(volumes, guestRefs(data), data.nodes.every((n) => n.online), await seesAllGuests(who.ticket)).find((i) => i.volid === volid);
      if (!item) throw new AuthError(400, `That isn't on ${storage} anymore.`);
      if (!item.canDelete) throw new AuthError(400, item.whyNot);
      return pve.delete<string>(`${base}/content/${encodeURIComponent(volid)}`, who);
    },
    "storage-setup": async (name, who, body) => {
      if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
      const devices = usesStorageNames(body.devices);
      const poolName = text(body.name, 32);
      const node = encodeURIComponent(name);
      const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
      const plan = rule(() => setupPlan(disks, devices, text(body.purpose, 8), poolName));
      const configs = await pve.get<RawStorageConfig[]>("/storage", who.ticket);
      if (configs.some((c) => c.storage === poolName)) throw new AuthError(400, `There's already storage called ${poolName}. Pick another name.`);
      // A drive with old data is wiped first, the same strict check as Wipe, then the pool is made on the clean drives.
      for (const disk of plan.wipe) {
        rule(() => assertCanWipe(disks, disk));
        await finishTask(name, await pve.put<string>(`/nodes/${node}/disks/wipedisk`, who, { disk }), who, 120);
      }
      const fresh = plan.wipe.length ? await nodeDisks(name, who.ticket, await loadOverview(who.ticket)) : disks;
      const form = rule(() => diskStorageForm(plan.kind, fresh, { name: poolName, devices, raid: plan.raid, filesystem: plan.filesystem }));
      await finishTask(name, await pve.post<string>(`/nodes/${node}/disks/${plan.kind}`, who, form), who, 300);
      // What it's for. Proxmox gives a new folder every use, which isn't what the person picked.
      await pve.put<null>(`/storage/${encodeURIComponent(poolName)}`, who, { content: plan.uses });
      return null;
    },
    "pool-delete": async (name, who, body) => {
      const id = text(body.storage, 64);
      if (!STORAGE.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      const [data, backupJobs] = await Promise.all([loadOverview(who.ticket), pve.get<{ storage?: string }[]>("/cluster/backup", who.ticket)]);
      const { map, config, directory } = await storageMapFor(name, who.ticket, data);
      const usedBy = storageBlockers(id, data.vms, backupJobs);
      let removal: { path: string; disks: string[] };
      try {
        removal = poolRemoval(map, id, config.find((c) => c.storage === id), directory, usedBy, config);
      } catch (err) {
        throw new AuthError(400, (err as Error).message);
      }
      return pve.delete<string>(`/nodes/${encodeURIComponent(name)}/${removal.path}`, who);
    },
    "storage-edit": async (_name, who, body) => {
      const id = text(body.id, 64);
      if (!STORAGE.test(id)) throw new AuthError(400, "That storage isn't valid.");
      const list = await pve.get<RawStorageConfig[]>("/storage", who.ticket);
      const found = list.find((s) => s.storage === id);
      if (!found) throw new AuthError(400, "That storage doesn't exist.");
      await pve.put<null>(`/storage/${encodeURIComponent(id)}`, who, { content: rule(() => usesForm(found.type ?? "", body.uses, found.content ?? "")) });
      return null;
    },
    "storage-remove": async (_name, who, body) => {
      const id = text(body.id, 64);
      if (!STORAGE.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      const [data, backupJobs] = await Promise.all([loadOverview(who.ticket), pve.get<{ storage?: string }[]>("/cluster/backup", who.ticket)]);
      const using = storageBlockers(id, data.vms, backupJobs);
      if (using.length) throw new AuthError(400, `${id} is still in use by ${using.join(", ")}.`);
      await pve.delete<null>(`/storage/${encodeURIComponent(id)}`, who);
      return null;
    },
    "disk-storage": async (name, who, body) => {
      if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
      const kind = text(body.kind, 12);
      const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
      const form = rule(() => diskStorageForm(kind, disks, { name: text(body.name, 32), devices: usesStorageNames(body.devices), raid: text(body.raid, 8), filesystem: text(body.filesystem, 8) }));
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/disks/${kind}`, who, form);
    },
    "disk-wipe": async (name, who, body) => {
      const disk = text(body.disk, 64);
      if (body.confirm !== "erase" || !deviceIsValid(disk)) throw new AuthError(400, "That wasn't confirmed.");
      const disks = await nodeDisks(name, who.ticket, await loadOverview(who.ticket));
      rule(() => assertCanWipe(disks, disk));
      return pve.put<string>(`/nodes/${encodeURIComponent(name)}/disks/wipedisk`, who, { disk });
    },
  };
}
