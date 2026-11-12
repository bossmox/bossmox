type Config = Record<string, string | number | undefined>;

export class HardwareError extends Error {}

const QEMU_DISK = /^(scsi|virtio|sata|ide)\d+$/;
const LXC_DISK = /^(rootfs|mp\d+)$/;
const NIC = /^net\d+$/;
const NAME_LIMITS: Record<string, number> = { scsi: 31, virtio: 16, sata: 6, ide: 4, mp: 256, net: 32 };
// Dot-only names ("." and "..") are refused: addresses fold them into the path around them (pre-public review 2026-11-09).
const STORAGE = /^(?!\.+$)[\w.-]{1,64}$/;
const MOUNT = /^\/[\w./-]{0,200}$/;
const BRIDGE = /^[\w.-]{1,32}$/;

/** "local:32", "size=32G", "size=512M": Proxmox writes sizes a few ways, and this page only needs gigabytes. */
function sizeGb(value: string): number {
  const m = value.match(/(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  const scale = { "": 1 / 1024 ** 3, K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 }[m[2] as "" | "K" | "M" | "G" | "T"];
  return Math.round(n * scale * 10) / 10;
}
const part = (value: string, key: string) => value.split(",").find((p) => p.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";

/** The first disk in the boot order, which is the one that can't be taken away. */
export function bootDisk(type: "qemu" | "lxc", config: Config): string {
  if (type === "lxc") return "rootfs";
  const order = String(config.boot ?? "").match(/order=([^,]+)/)?.[1]?.split(";") ?? [];
  return order.find((d) => QEMU_DISK.test(d) && !String(config[d] ?? "").includes("media=cdrom")) ?? "";
}

export function readDisks(type: "qemu" | "lxc", config: Config) {
  const boot = bootDisk(type, config);
  const pattern = type === "qemu" ? QEMU_DISK : LXC_DISK;
  return Object.entries(config)
    .filter(([k, v]) => pattern.test(k) && !String(v).includes("media=cdrom") && String(v) !== "none")
    .map(([slot, v]) => ({
      slot,
      storage: String(v).split(":")[0] ?? "",
      sizeGb: sizeGb(String(v)),
      mount: part(String(v), "mp"),
      boot: slot === boot,
    }))
    .sort((a, b) => Number(b.boot) - Number(a.boot) || a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

const SNAP_POOLS = new Set(["lvmthin", "zfspool", "rbd", "btrfs"]);
const FILE_TYPES = new Set(["dir", "nfs", "cifs", "glusterfs"]);
/**
 * The disks to convert so a VM can be snapshotted (ADR 0016): raw files on a folder or share, which Proxmox made
 * when not asked for qcow2. Only offered when converting them would be enough, so every other disk already can.
 */
export function snapshotFix(config: Config, storageTypes: Record<string, string>): string[] {
  const slots = Object.entries(config).filter(([k, v]) => (QEMU_DISK.test(k) || k === "efidisk0" || k === "tpmstate0") && !String(v).includes("media=cdrom") && String(v) !== "none" && String(v).includes(":"));
  const convert: string[] = [];
  for (const [slot, v] of slots) {
    const volume = String(v).split(",")[0] ?? "";
    const type = storageTypes[volume.split(":")[0] ?? ""] ?? "";
    if (SNAP_POOLS.has(type) || (FILE_TYPES.has(type) && volume.endsWith(".qcow2"))) continue;
    if (FILE_TYPES.has(type) && /\.(raw|vmdk)$/.test(volume)) convert.push(slot);
    else return [];
  }
  return convert;
}

export function readNics(type: "qemu" | "lxc", config: Config) {
  return Object.entries(config)
    .filter(([k]) => NIC.test(k))
    .map(([slot, v]) => {
      const value = String(v);
      const first = value.split(",")[0] ?? "";
      return {
        slot,
        model: type === "qemu" ? first.split("=")[0] ?? "" : part(value, "name"),
        mac: type === "qemu" ? first.split("=")[1] ?? "" : part(value, "hwaddr"),
        bridge: part(value, "bridge"),
        vlan: part(value, "tag"),
        // A container's address is in its own settings; a VM's is inside the VM, where Proxmox can't set it.
        ...(type === "lxc" ? { ip: part(value, "ip"), gw: part(value, "gw") } : {}),
      };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

function nextSlot(prefix: string, config: Config): string {
  const limit = NAME_LIMITS[prefix] ?? 32;
  for (let i = 0; i < limit; i++) if (config[`${prefix}${i}`] === undefined) return `${prefix}${i}`;
  throw new HardwareError("This guest has no free slots left for that.");
}

export function growForm(type: "qemu" | "lxc", config: Config, slot: string, addGb: number): Record<string, string> {
  if (!Object.hasOwn(config, slot) || !(type === "qemu" ? QEMU_DISK : LXC_DISK).test(slot)) throw new HardwareError("That disk doesn't exist.");
  if (!Number.isInteger(addGb) || addGb < 1 || addGb > 65536) throw new HardwareError("Add between 1 and 65536 GB.");
  return { disk: slot, size: `+${addGb}G` };
}

export function addDiskForm(type: "qemu" | "lxc", config: Config, v: { storage: string; sizeGb: number; mount: string; fileStorage?: boolean }): Record<string, string> {
  if (!STORAGE.test(v.storage)) throw new HardwareError("Pick a storage.");
  if (!Number.isInteger(v.sizeGb) || v.sizeGb < 1 || v.sizeGb > 65536) throw new HardwareError("A disk is between 1 and 65536 GB.");
  if (type === "lxc") {
    if (!MOUNT.test(v.mount) || v.mount === "/") throw new HardwareError("Enter where it should appear, such as /data.");
    return { [nextSlot("mp", config)]: `${v.storage}:${v.sizeGb},mp=${v.mount}` };
  }
  // Windows has no driver for the fast disk types until someone installs one, so it stays on what it can see.
  const prefix = config.sata0 !== undefined && config.scsi0 === undefined ? "sata" : config.virtio0 !== undefined && config.scsi0 === undefined ? "virtio" : "scsi";
  // On a folder or share, raw disks can't be snapshotted, so ask for qcow2 as Proxmox's own screen does.
  return { [nextSlot(prefix, config)]: `${v.storage}:${v.sizeGb}${v.fileStorage ? ",format=qcow2" : ""}` };
}

/** Only ordinary data disks can go. Losing the boot disk, or a volume with a guest's whole system on it, is never one click. */
export function removeDiskForm(type: "qemu" | "lxc", config: Config, slot: string): Record<string, string> {
  if (!Object.hasOwn(config, slot) || !(type === "qemu" ? QEMU_DISK : LXC_DISK).test(slot)) throw new HardwareError("That disk doesn't exist.");
  if (String(config[slot]).includes("media=cdrom")) throw new HardwareError("That's a disc drive, not a disk.");
  if (slot === bootDisk(type, config) || slot === "rootfs") throw new HardwareError("That's the disk it starts from, so it can't be removed.");
  return { delete: slot };
}

export function addNicForm(type: "qemu" | "lxc", config: Config, v: { bridge: string; vlan: string }): Record<string, string> {
  if (!BRIDGE.test(v.bridge)) throw new HardwareError("Pick a network.");
  if (v.vlan && (!/^\d{1,4}$/.test(v.vlan) || Number(v.vlan) < 1 || Number(v.vlan) > 4094)) throw new HardwareError("A VLAN is a number from 1 to 4094.");
  const slot = nextSlot("net", config);
  const tag = v.vlan ? `,tag=${v.vlan}` : "";
  if (type === "lxc") return { [slot]: `name=eth${slot.slice(3)},bridge=${v.bridge},ip=dhcp${tag}` };
  const model = String(config.net0 ?? "").split("=")[0] || "virtio";
  return { [slot]: `${model},bridge=${v.bridge}${tag}` };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipv4 = (s: string) => {
  const m = IPV4.exec(s);
  return m?.slice(1).every((n) => Number(n) <= 255) ? m.slice(1).reduce((a, n) => a * 256 + Number(n), 0) : null;
};
/** True when the gateway sits on the address's own network, the usual mistake being a typo in either. */
export function sameNetwork(address: string, prefix: number, gateway: string) {
  const a = ipv4(address), g = ipv4(gateway);
  if (a === null || g === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(a / size) === Math.floor(g / size);
}

/**
 * A container card's new IPv4 address (ADR 0024): automatic, or fixed with a gateway. Everything else on the card
 * (its name, MAC, bridge, VLAN, IPv6, firewall, limits) stays as it was.
 */
export function addressForm(config: Config, slot: string, v: { mode: string; address: string; gateway: string }): Record<string, string> {
  if (!NIC.test(slot) || !Object.hasOwn(config, slot)) throw new HardwareError("That network card doesn't exist.");
  let ip: string, gw: string;
  if (v.mode === "dhcp") {
    ip = "dhcp";
    gw = "";
  } else if (v.mode === "fixed") {
    const [addr = "", bits = ""] = v.address.trim().split("/");
    const prefix = Number(bits);
    if (ipv4(addr) === null || !/^\d{1,2}$/.test(bits) || prefix < 8 || prefix > 32) throw new HardwareError("Type the address with its network size, like 192.168.1.30/24.");
    const gateway = v.gateway.trim();
    if (gateway) {
      if (ipv4(gateway) === null) throw new HardwareError("The gateway is four numbers, like 192.168.1.1.");
      if (gateway === addr) throw new HardwareError("The gateway can't be the container's own address.");
      if (!sameNetwork(addr, prefix, gateway)) throw new HardwareError(`${gateway} isn't on the same network as ${addr}/${prefix}. Check both.`);
    }
    ip = `${addr}/${prefix}`;
    gw = gateway;
  } else throw new HardwareError("Pick automatic or fixed.");
  const parts = String(config[slot]).split(",").filter((p) => !p.startsWith("ip=") && !p.startsWith("gw="));
  return { [slot]: [...parts, `ip=${ip}`, ...(gw ? [`gw=${gw}`] : [])].join(",") };
}

export function removeNicForm(config: Config, slot: string): Record<string, string> {
  if (!NIC.test(slot) || !Object.hasOwn(config, slot)) throw new HardwareError("That network card doesn't exist.");
  return { delete: slot };
}

interface LxcInterface {
  name?: string;
  inet?: string;
  inet6?: string;
}
interface AgentInterface {
  name?: string;
  "ip-addresses"?: { "ip-address"?: string; "ip-address-type"?: string }[];
}

/** The guest's own addresses, leaving out loopback and link-local ones nobody can connect to. */
export function pickAddresses(type: "qemu" | "lxc", raw: unknown): string[] {
  const usable = (a: string) => a && !/^(127\.|::1|fe80:|169\.254\.)/i.test(a);
  if (type === "lxc") {
    return (raw as LxcInterface[]).filter((i) => i.name !== "lo").flatMap((i) => [i.inet, i.inet6]).map((a) => (a ?? "").split("/")[0] as string).filter(usable);
  }
  const list = (raw as { result?: AgentInterface[] }).result ?? [];
  return list.filter((i) => i.name !== "lo").flatMap((i) => (i["ip-addresses"] ?? []).map((a) => a["ip-address"] ?? "")).filter(usable);
}
