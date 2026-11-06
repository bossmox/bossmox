export class CreateError extends Error {}

export interface CreateInput {
  id: string;
  name: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  storage: string;
  bridge: string;
  /** An ISO for a VM, a template for a container. Optional for a VM, which can get an ISO later. */
  installer: string;
  os: string;
  start: boolean;
  password: string;
}

const NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;
const SIMPLE = /^[\w.-]{1,64}$/;
const VOLUME = /^[\w.-]+:[\w./-]+$/;
const OS: Record<string, string> = { linux: "l26", windows: "win11", other: "other" };

function checkCommon(v: CreateInput) {
  if (!/^\d{3,9}$/.test(v.id)) throw new CreateError("That ID isn't valid.");
  if (!NAME.test(v.name)) throw new CreateError("A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
  if (!Number.isInteger(v.cores) || v.cores < 1 || v.cores > 128) throw new CreateError("Pick between 1 and 128 processor cores.");
  if (!Number.isInteger(v.memoryMb) || v.memoryMb < 64) throw new CreateError("Give it at least 64 MB of memory.");
  if (!Number.isInteger(v.diskGb) || v.diskGb < 1 || v.diskGb > 65536) throw new CreateError("Give it at least 1 GB of disk.");
  if (!SIMPLE.test(v.storage) || !SIMPLE.test(v.bridge)) throw new CreateError("Pick a storage and a network.");
}

/**
 * The settings for a new VM. Windows gets a SATA disk and an Intel network card because its installer can't see
 * the faster virtio devices without extra drivers, and "no disks found" is a bad first minute.
 */
export function vmForm(v: CreateInput): Record<string, string> {
  checkCommon(v);
  if (v.installer && !VOLUME.test(v.installer)) throw new CreateError("That installer isn't valid.");
  const ostype = Object.hasOwn(OS, v.os) ? OS[v.os] : undefined;
  if (!ostype) throw new CreateError("Pick an operating system.");
  const windows = v.os === "windows";
  const disk = windows ? "sata0" : "scsi0";
  const form: Record<string, string> = {
    vmid: v.id,
    name: v.name,
    ostype,
    cores: String(v.cores),
    memory: String(v.memoryMb),
    net0: `${windows ? "e1000e" : "virtio"},bridge=${v.bridge}`,
    [disk]: `${v.storage}:${v.diskGb}`,
    scsihw: "virtio-scsi-single",
    boot: `order=${disk}${v.installer ? ";ide2" : ""}`,
  };
  if (windows) {
    Object.assign(form, { bios: "ovmf", machine: "q35", efidisk0: `${v.storage}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${v.storage}:1,version=v2.0` });
  }
  if (v.installer) form.ide2 = `${v.installer},media=cdrom`;
  if (v.start) form.start = "1";
  return form;
}

/** The settings for a new container. Nesting is on because current Linux needs it to run properly. */
export function containerForm(v: CreateInput): Record<string, string> {
  checkCommon(v);
  if (!VOLUME.test(v.installer)) throw new CreateError("Pick a template.");
  if (v.password.length < 8 || v.password.length > 128) throw new CreateError("Give it a password of at least 8 characters.");
  const form: Record<string, string> = {
    vmid: v.id,
    hostname: v.name,
    ostemplate: v.installer,
    password: v.password,
    cores: String(v.cores),
    memory: String(v.memoryMb),
    swap: "512",
    rootfs: `${v.storage}:${v.diskGb}`,
    net0: `name=eth0,bridge=${v.bridge},ip=dhcp`,
    unprivileged: "1",
    features: "nesting=1",
  };
  if (v.start) form.start = "1";
  return form;
}

export interface SettingsInput {
  name: string;
  cores: number;
  memoryMb: number;
  startsAtBoot: boolean;
  /** A VM's installer disc: a volume, "" for none, or null to leave it alone. */
  disc: string | null;
}

/** What to change on an existing guest. A disc added to a VM goes on its boot list, or the VM would never start from it. */
export function settingsForm(kind: "qemu" | "lxc", v: SettingsInput, current: { boot?: string; ide2?: string } = {}): Record<string, string> {
  if (!NAME.test(v.name)) throw new CreateError("A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
  if (!Number.isInteger(v.cores) || v.cores < 1 || v.cores > 128) throw new CreateError("Pick between 1 and 128 processor cores.");
  if (!Number.isInteger(v.memoryMb) || v.memoryMb < 64) throw new CreateError("Give it at least 64 MB of memory.");
  const form: Record<string, string> = { [kind === "qemu" ? "name" : "hostname"]: v.name, cores: String(v.cores), memory: String(v.memoryMb), onboot: v.startsAtBoot ? "1" : "0" };
  if (kind === "qemu" && v.disc !== null) {
    if (current.ide2?.includes("cloudinit")) throw new CreateError("This VM uses that drive for its setup disk, so a disc can't go there.");
    if (v.disc === "") form.ide2 = "none,media=cdrom";
    else {
      if (!VOLUME.test(v.disc)) throw new CreateError("That disc isn't valid.");
      form.ide2 = `${v.disc},media=cdrom`;
      if (current.boot?.startsWith("order=") && !current.boot.includes("ide2")) form.boot = `${current.boot};ide2`;
    }
  }
  return form;
}

/** Only disc images, from an ordinary web address, with a plain file name. */
export function discDownload(url: string): { url: string; filename: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CreateError("That doesn't look like a web address.");
  }
  // Proxmox boots whatever arrives, and plain http could be swapped on the way.
  if (parsed.protocol !== "https:") throw new CreateError("Use an address that starts with https.");
  // Taken as written, so an encoded slash or a stray % can only fail this check.
  const filename = parsed.pathname.split("/").pop() ?? "";
  if (!/^[\w.-]+\.iso$/i.test(filename)) throw new CreateError("The address has to end in a file name ending in .iso.");
  return { url: parsed.href, filename };
}

/** "local:iso/alpine-virt-3.24.iso" reads better as its file name. */
export const installerLabel = (volid: string) => volid.split("/").pop() ?? volid;
