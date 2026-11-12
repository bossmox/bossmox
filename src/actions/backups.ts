/** Actions on backups and their schedules. Moved out of server.ts (review #61); the server passes what they need. */
import { AuthError } from "../auth.js";
import { isListedBackup, type RawVolume } from "../storage-map.js";
import { STORAGE, VOLUME, JOB_ID, SCHEDULE, text } from "../checks.js";
import type { ActionContext } from "../server.js";
import type { Action } from "./action.js";

export function backupActions(c: ActionContext): Record<string, Action> {
  const { pve } = c;
  return {
    "backup-restore": async (name, who, body) => {
      const volid = text(body.volid, 256);
      const storage = text(body.storage, 64);
      const type = body.type;
      const id = text(body.guest, 12);
      if (!VOLUME.test(volid) || !STORAGE.test(storage) || !/^\d+$/.test(id) || (type !== "qemu" && type !== "lxc")) throw new AuthError(400, "That restore request isn't valid.");
      const replace = body.replace === true;
      // Replacing erases the guest as it is now, so it needs its own typed word.
      if (replace && body.confirm !== "replace") throw new AuthError(400, "That wasn't confirmed.");
      const form: Record<string, string> = { vmid: id, storage };
      if (replace) form.force = "1";
      else form.unique = "1";
      const copyName = text(body.name, 63);
      if (!replace && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(copyName)) form[type === "qemu" ? "name" : "hostname"] = copyName;
      if (type === "qemu") form.archive = volid;
      else Object.assign(form, { ostemplate: volid, restore: "1" });
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${type}`, who, form);
    },
    "backup-delete": async (name, who, body) => {
      const volid = text(body.volid, 256);
      const storage = text(body.storage, 64);
      if (!VOLUME.test(volid) || !STORAGE.test(storage)) throw new AuthError(400, "That request isn't valid.");
      if (body.confirm !== volid) throw new AuthError(400, "That wasn't confirmed.");
      const base = `/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}`;
      if (!isListedBackup(await pve.get<RawVolume[]>(`${base}/content?content=backup`, who.ticket), volid)) throw new AuthError(400, `That isn't a backup on ${storage}.`);
      return pve.delete<string>(`${base}/content/${encodeURIComponent(volid)}`, who);
    },
    "schedule-add": async (_name, who, body) => {
      const schedule = text(body.schedule, 16);
      const storage = text(body.storage, 64);
      const guests = text(body.guests, 256);
      const keep = Number(body.keep);
      if (!SCHEDULE.test(schedule) || !STORAGE.test(storage) || !Number.isInteger(keep) || keep < 1 || keep > 99) throw new AuthError(400, "That schedule isn't valid.");
      if (guests !== "all" && !/^\d+(,\d+)*$/.test(guests)) throw new AuthError(400, "That schedule isn't valid.");
      await pve.post<null>("/cluster/backup", who, { schedule, storage, mode: "snapshot", compress: "zstd", enabled: "1", "prune-backups": `keep-last=${keep}`, ...(guests === "all" ? { all: "1" } : { vmid: guests }) });
      return null;
    },
    "schedule-toggle": async (_name, who, body) => {
      const id = text(body.job, 64);
      if (!JOB_ID.test(id) || typeof body.on !== "boolean") throw new AuthError(400, "That request isn't valid.");
      await pve.put<null>(`/cluster/backup/${encodeURIComponent(id)}`, who, { enabled: body.on ? "1" : "0" });
      return null;
    },
    "schedule-delete": async (_name, who, body) => {
      const id = text(body.job, 64);
      if (!JOB_ID.test(id) || body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      await pve.delete<null>(`/cluster/backup/${encodeURIComponent(id)}`, who);
      return null;
    },
    "back-up-guests": (name, who, body) => {
      const vmid = text(body.guests, 256);
      const storage = text(body.storage, 64);
      if (!/^\d+(,\d+)*$/.test(vmid) || !/^[\w.-]+$/.test(storage)) throw new AuthError(400, "That backup request isn't valid.");
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/vzdump`, who, { vmid, storage, mode: "snapshot", compress: "zstd" });
    },
  };
}
