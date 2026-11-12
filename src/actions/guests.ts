
import { AuthError } from "../auth.js";
import { clonesOf, type RawConfig } from "../model.js";
import { containerForm, CreateError, discDownload, discForm, vmForm, type CreateInput } from "../create.js";
import { changesForm, SettingsError } from "../guest-settings.js";
import { addDiskForm, addNicForm, addressForm, growForm, HardwareError, removeDiskForm, removeNicForm } from "../hardware.js";
import type { RawTaskStatus } from "../server-detail.js";
import { STORAGE, text } from "../checks.js";
import type { ActionContext } from "../server.js";
import type { Action } from "./action.js";

const POWER = new Set(["start", "shutdown", "reboot", "stop"]);
const UEFI_WINDOW_MS = 8000;
const UEFI_GAP_MS = 1200;
const BIOS_SETTLE_MS = 8000;
const BIOS_ESC_AFTER_MS = 1500;

export function guestActions(c: ActionContext): Record<string, Action> {
  const { finishTask, guestPath, keepsFiles, kindOf, loadOverview, ownAddresses, part, snapshotFixFor, snapshotName, withConfig, pve } = c;
  return {
    "guest-power": (name, who, body) => {
      const { id, path } = guestPath(name, body);
      const power = text(body.power, 16);
      if (!POWER.has(power)) throw new AuthError(400, "That request isn't valid.");
      if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      // Force off has to win over a shutdown that's stuck waiting for the guest.
      return pve.post<string>(`${path}/status/${power}`, who, power === "stop" ? { "overrule-shutdown": "1" } : {});
    },
    "boot-on": async (_name, who, body) => {
      const ids = text(body.guests, 400);
      if (!/^\d+(,\d+)*$/.test(ids)) throw new AuthError(400, "That request isn't valid.");
      const data = await loadOverview(who.ticket);
      for (const id of ids.split(",").map(Number)) {
        const v = data.vms.find((g) => g.id === id);
        if (!v) continue;
        await pve.put<null>(`/nodes/${encodeURIComponent(v.node)}/${v.type}/${id}/config`, who, { onboot: "1" });
      }
      return null;
    },
    "leftover-remove": async (name, who, body) => {
      // Deletes one detached disk for good. The browser sends the volume the person saw; if the slot now holds
      // something else, nothing is removed.
      const { path } = guestPath(name, body);
      const slot = text(body.slot, 12);
      if (!/^unused\d+$/.test(slot)) throw new AuthError(400, "That request isn't valid.");
      const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
      const now = String(config[slot] ?? "").split(",")[0];
      if (!now || now !== body.confirm) throw new AuthError(400, "That disk has changed since BossMox looked. Check again, then remove it.");
      return pve.put<null>(`${path}/config`, who, { delete: slot });
    },
    "snapshot-fix": async (name, who, body) => {
      const { id, path } = guestPath(name, { ...body, type: "qemu" });
      if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      const status = await pve.get<{ status?: string }>(`${path}/status/current`, who.ticket);
      // Tested with the VM shut down. Converting the firmware and TPM disks of a running VM isn't something to try.
      if (status.status !== "stopped") throw new AuthError(400, "Shut it down first.");
      const slots = await snapshotFixFor(name, path, who.ticket);
      if (!slots.length) throw new AuthError(400, "Converting its disks wouldn't make snapshots work, so nothing was changed.");
      const config = await pve.get<RawConfig>(`${path}/config`, who.ticket);
      for (const disk of slots) {
        const storage = String(config[disk]).split(":")[0] ?? "";
        await finishTask(name, await pve.post<string>(`${path}/move_disk`, who, { disk, storage, format: "qcow2", delete: "1" }), who, 900);
      }
      return null;
    },
    "snapshot-take": (name, who, body) => {
      const { path } = guestPath(name, body);
      const snapname = snapshotName(body);
      const description = text(body.description, 200);
      return pve.post<string>(`${path}/snapshot`, who, description ? { snapname, description } : { snapname });
    },
    "snapshot-restore": (name, who, body) => {
      const { path } = guestPath(name, body);
      const snap = snapshotName(body);
      // The browser only sends this after the person types "restore", because newer changes are lost.
      if (body.confirm !== "restore") throw new AuthError(400, "That wasn't confirmed.");
      return pve.post<string>(`${path}/snapshot/${snap}/rollback`, who, body.start === true ? { start: "1" } : {});
    },
    "snapshot-delete": (name, who, body) => {
      const { path } = guestPath(name, body);
      const snap = snapshotName(body);
      if (body.confirm !== snap) throw new AuthError(400, "That wasn't confirmed.");
      return pve.delete<string>(`${path}/snapshot/${snap}`, who);
    },
    "guest-create": async (name, who, body) => {
      const kind = body.kind;
      if (kind !== "qemu" && kind !== "lxc") throw new AuthError(400, "That request isn't valid.");
      const input: CreateInput = {
        id: text(body.id, 12),
        name: text(body.name, 63),
        cores: Number(body.cores),
        memoryMb: Number(body.memoryMb),
        diskGb: Number(body.diskGb),
        storage: text(body.storage, 64),
        bridge: text(body.bridge, 64),
        installer: text(body.installer, 256),
        os: text(body.os, 16),
        start: body.start === true,
        password: text(body.password, 128),
        fileStorage: kind === "qemu" && (await keepsFiles(name, text(body.storage, 64), who.ticket)),
      };
      try {
        const form = kind === "qemu" ? vmForm(input) : containerForm(input);
        return pve.post<string>(`/nodes/${encodeURIComponent(name)}/${kind}`, who, form);
      } catch (err) {
        if (err instanceof CreateError) throw new AuthError(400, err.message);
        throw err;
      }
    },
    "guest-settings": async (name, who, body) => {
      const { path } = guestPath(name, body);
      if (typeof body.changes !== "object" || body.changes === null || Array.isArray(body.changes)) throw new AuthError(400, "That request isn't valid.");
      const [config, status] = await Promise.all([pve.get<RawConfig>(`${path}/config`, who.ticket), pve.get<{ status?: string }>(`${path}/status/current`, who.ticket)]);
      try {
        await pve.put<null>(`${path}/config`, who, changesForm(kindOf(body), config, body.changes as Record<string, unknown>, status.status === "running"));
        return null;
      } catch (err) {
        if (err instanceof SettingsError) throw new AuthError(400, err.message);
        throw err;
      }
    },
    /**
     * Proxmox has no "stop at the boot menu" setting, so this presses the key at the right moment. BIOS opens its
     * menu on Esc and also closes it on Esc, so it gets exactly one press. The moment is only dependable after a
     * reset, so a shut-down VM is started and then reset. UEFI ignores repeats of F2, so it's pressed throughout.
     */
    "guest-boot-menu": async (name, who, body) => {
      const { id, path } = guestPath(name, { ...body, type: "qemu" });
      if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      const [current, config] = await Promise.all([pve.get<{ status?: string }>(`${path}/status/current`, who.ticket), pve.get<RawConfig>(`${path}/config`, who.ticket)]);
      const uefi = config.bios === "ovmf";
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const reset = () => pve.post<string | null>(`${path}/status/reset`, who);
      if (current.status === "running") await reset();
      else {
        const task = await pve.post<string>(`${path}/status/start`, who);
        const taskPath = `/nodes/${encodeURIComponent(name)}/tasks/${encodeURIComponent(task)}/status`;
        for (let i = 0; i < 60; i++) {
          const status = await pve.get<RawTaskStatus>(taskPath, who.ticket);
          if (status.status === "stopped") {
            if (status.exitstatus !== "OK") throw new AuthError(400, status.exitstatus ?? "It wouldn't start.");
            break;
          }
          await wait(250);
        }
        // Proxmox doesn't answer for a VM that's only just started, so it gets a few seconds before the reset.
        await wait(BIOS_SETTLE_MS);
        for (let i = 0; ; i++) {
          const done = await reset().then(() => true, () => false);
          if (done) break;
          if (i === 12) throw new AuthError(400, "It started, but wouldn't restart to the boot menu.");
          await wait(1000);
        }
      }
      if (uefi) {
        // A VM still starting can refuse a key, which only means pressing again.
        const until = Date.now() + UEFI_WINDOW_MS;
        while (Date.now() < until) {
          await pve.put<null>(`${path}/sendkey`, who, { key: "f2" }).catch(() => null);
          await wait(UEFI_GAP_MS);
        }
        return null;
      }
      await wait(BIOS_ESC_AFTER_MS);
      await pve.put<null>(`${path}/sendkey`, who, { key: "esc" });
      return null;
    },
    "guest-disc": async (name, who, body) => {
      const { path } = guestPath(name, body);
      if (typeof body.disc !== "string" || body.disc.length > 256) throw new AuthError(400, "That disc isn't valid.");
      const slot = body.slot === undefined ? "ide2" : text(body.slot, 12);
      const current = await pve.get<RawConfig>(`${path}/config`, who.ticket);
      try {
        await pve.put<null>(`${path}/config`, who, discForm(body.disc, current, slot));
        return null;
      } catch (err) {
        if (err instanceof CreateError) throw new AuthError(400, err.message);
        throw err;
      }
    },
    "disc-download": (name, who, body) => {
      const storage = text(body.storage, 64);
      if (!STORAGE.test(storage)) throw new AuthError(400, "That request isn't valid.");
      try {
        const { url, filename } = discDownload(text(body.url, 1024));
        return pve.post<string>(`/nodes/${encodeURIComponent(name)}/storage/${encodeURIComponent(storage)}/download-url`, who, { content: "iso", url, filename });
      } catch (err) {
        if (err instanceof CreateError) throw new AuthError(400, err.message);
        throw err;
      }
    },
    "disk-grow": async (name, who, body) => {
      const { path } = guestPath(name, body);
      const form = await withConfig(path, who, (c) => growForm(kindOf(body), c, text(body.disk, 16), Number(body.addGb)));
      return (await pve.put<string | null>(`${path}/resize`, who, form)) ?? null;
    },
    "disk-add": async (name, who, body) => {
      const { path } = guestPath(name, body);
      const fileStorage = kindOf(body) === "qemu" && (await keepsFiles(name, text(body.storage, 64), who.ticket));
      const form = await withConfig(path, who, (c) => addDiskForm(kindOf(body), c, { storage: text(body.storage, 64), sizeGb: Number(body.sizeGb), mount: text(body.mount, 200), fileStorage }));
      await pve.put<null>(`${path}/config`, who, form);
      return null;
    },
    "disk-remove": async (name, who, body) => {
      const { path } = guestPath(name, body);
      // This one erases data, so it needs the typed word, and the disk is cleared rather than left detached.
      if (body.confirm !== "erase") throw new AuthError(400, "That wasn't confirmed.");
      const slot = text(body.disk, 16);
      const before = await withConfig(path, who, (c) => ({ config: c, form: removeDiskForm(kindOf(body), c, slot) }));
      const volume = String(before.config[slot]).split(",")[0];
      await pve.put<null>(`${path}/config`, who, before.form);
      const after = await pve.get<RawConfig>(`${path}/config`, who.ticket);
      const unused = Object.entries(after).find(([k, v]) => /^unused\d+$/.test(k) && String(v) === volume)?.[0];
      if (unused) await pve.put<null>(`${path}/config`, who, { delete: unused });
      return null;
    },
    "nic-add": async (name, who, body) => {
      const { path } = guestPath(name, body);
      const form = await withConfig(path, who, (c) => addNicForm(kindOf(body), c, { bridge: text(body.bridge, 32), vlan: text(body.vlan, 4) }));
      await pve.put<null>(`${path}/config`, who, form);
      return null;
    },
    "guest-address": async (name, who, body) => {
      const { path } = guestPath(name, body);
      if (kindOf(body) !== "lxc") throw new AuthError(400, "Only a container's address can be set from here. A VM sets its own, inside the VM.");
      const slot = text(body.nic, 8);
      if (body.confirm !== slot) throw new AuthError(400, "That wasn't confirmed.");
      const form = await withConfig(path, who, (c) => {
        // Moving the container BossMox runs in would cut off everyone using it, this page included.
        const mine = ownAddresses();
        const configured = part(String(c[slot] ?? ""), "ip").split("/")[0] ?? "";
        if (mine.has(configured)) throw new HardwareError("This container is BossMox itself. Changing its address here would cut you off, so it isn't offered.");
        return addressForm(c, slot, { mode: text(body.mode, 8), address: text(body.address, 20), gateway: text(body.gateway, 16) });
      });
      const live = await pve.get<{ inet?: string }[]>(`${path}/interfaces`, who.ticket).catch(() => []);
      if (live.some((i) => ownAddresses().has(String(i.inet ?? "").split("/")[0] ?? ""))) throw new AuthError(400, "This container is BossMox itself. Changing its address here would cut you off, so it isn't offered.");
      await pve.put<null>(`${path}/config`, who, form);
      return null;
    },
    "nic-remove": async (name, who, body) => {
      const { path } = guestPath(name, body);
      if (body.confirm !== text(body.nic, 8)) throw new AuthError(400, "That wasn't confirmed.");
      const form = await withConfig(path, who, (c) => removeNicForm(c, text(body.nic, 8)));
      await pve.put<null>(`${path}/config`, who, form);
      return null;
    },
    "guest-clone": async (name, who, body) => {
      const { path } = guestPath(name, body);
      const newName = text(body.name, 63);
      const storage = text(body.storage, 64);
      if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(newName)) throw new AuthError(400, "A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
      if (!STORAGE.test(storage)) throw new AuthError(400, "Pick a storage.");
      const newid = String(await pve.get<string | number>("/cluster/nextid", who.ticket));
      return pve.post<string>(`${path}/clone`, who, { newid, full: "1", storage, [kindOf(body) === "qemu" ? "name" : "hostname"]: newName });
    },
    "guest-template": async (name, who, body) => {
      const { path } = guestPath(name, body);
      // There's no way back from this short of cloning it, so it gets the typed word too.
      if (body.confirm !== "template") throw new AuthError(400, "That wasn't confirmed.");
      return (await pve.post<string | null>(`${path}/template`, who)) ?? null;
    },
    "template-download": (name, who, body) => {
      const storage = text(body.storage, 64);
      const template = text(body.template, 200);
      if (!STORAGE.test(storage) || !/^[\w.+-]+$/.test(template)) throw new AuthError(400, "That request isn't valid.");
      return pve.post<string>(`/nodes/${encodeURIComponent(name)}/aplinfo`, who, { storage, template });
    },
    "guest-delete": async (name, who, body) => {
      const { id, path } = guestPath(name, body);
      if (body.confirm !== id) throw new AuthError(400, "That wasn't confirmed.");
      const clones = clonesOf(Number(id), (await loadOverview(who.ticket)).vms);
      if (clones.length) throw new AuthError(400, `${clones.join(", ")} ${clones.length === 1 ? "was" : "were"} made from this template and still ${clones.length === 1 ? "needs" : "need"} it. Delete ${clones.length === 1 ? "that clone" : "those clones"} first.`);
      return pve.delete<string>(`${path}?purge=1`, who);
    },
  };
}
