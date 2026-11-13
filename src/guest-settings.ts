type Config = Record<string, string | number | undefined>;
type Kind = "qemu" | "lxc";

export class SettingsError extends Error {}

const NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;
const CPU = /^[\w.+-]{1,64}$/;
const MACHINE = /^(q35|pc|pc-(i440fx|q35)-\d+\.\d+(\+pve\d+)?)$/;
const TAG = /^[\w.+-]{1,64}$/;
const DNS = /^[0-9a-fA-F:.]+( [0-9a-fA-F:.]+)*$/;
const DOMAIN = /^[A-Za-z0-9.-]{1,253}$/;
const OSTYPES = ["l26", "l24", "win11", "win10", "win8", "win7", "wvista", "w2k8", "w2k3", "w2k", "wxp", "solaris", "other"];
const CONTROLLERS = ["virtio-scsi-single", "virtio-scsi-pci", "lsi", "lsi53c810", "megasas", "pvscsi"];
const DISPLAYS = ["std", "virtio", "qxl", "vmware", "cirrus", "serial0", "none"];

const first = (value: unknown) => String(value ?? "").split(",")[0] ?? "";
const rest = (value: unknown) =>
  String(value ?? "")
    .split(",")
    .slice(1);
const part = (value: unknown, key: string) =>
  String(value ?? "")
    .split(",")
    .find((p) => p.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? "";
const onByDefault = (value: unknown) => value === undefined || String(value) !== "0";
const flag = (value: unknown) => String(value ?? "0") === "1";
/** "2048" or "current=2048": Proxmox has written memory both ways. */
const memoryOf = (value: unknown) => Number(String(value ?? "").match(/\d+/)?.[0] ?? 0);
const cpuOf = (value: unknown) => {
  const named = part(value, "cputype");
  return named || (first(value).includes("=") ? "" : first(value));
};
const agentOn = (value: unknown) => first(value) === "1" || part(value, "enabled") === "1";
const orderOf = (value: unknown) => Number(part(value, "order")) || null;

/** The values a person sees and edits, in one flat shape for each kind of guest. */
export function readSettings(kind: Kind, c: Config) {
  const common = {
    name: String(c.name ?? c.hostname ?? ""),
    notes: String(c.description ?? "").trimEnd(),
    tags: String(c.tags ?? "")
      .split(/[;,\s]+/)
      .filter(Boolean)
      .join(" "),
    onboot: flag(c.onboot),
    protection: flag(c.protection),
    startOrder: orderOf(c.startup),
    cores: Number(c.cores ?? 1),
    cpuLimit: c.cpulimit === undefined ? null : Number(c.cpulimit),
    memoryMb: memoryOf(c.memory) || 512,
  };
  if (kind === "lxc") {
    return {
      ...common,
      swapMb: Number(c.swap ?? 512),
      dns: String(c.nameserver ?? ""),
      searchDomain: String(c.searchdomain ?? ""),
      nesting: part(c.features, "nesting") === "1",
      keyctl: part(c.features, "keyctl") === "1",
      fuse: part(c.features, "fuse") === "1",
      system: String(c.ostype ?? ""),
      unprivileged: flag(c.unprivileged),
    };
  }
  return {
    ...common,
    sockets: Number(c.sockets ?? 1),
    cpu: cpuOf(c.cpu),
    numa: flag(c.numa),
    balloonMb: c.balloon === undefined ? null : Number(c.balloon),
    ostype: String(c.ostype ?? "other"),
    machine: first(c.machine),
    bios: String(c.bios ?? "seabios"),
    scsihw: String(c.scsihw ?? "lsi"),
    display: first(c.vga),
    agent: agentOn(c.agent),
    tablet: onByDefault(c.tablet),
    acpi: onByDefault(c.acpi),
    kvm: onByDefault(c.kvm),
  };
}

const wrong = (line: string): never => {
  throw new SettingsError(line);
};
const bool = (v: unknown, label: string) => (typeof v === "boolean" ? (v ? "1" : "0") : wrong(`${label} isn't valid.`));
function whole(v: unknown, low: number, high: number, line: string) {
  const n = Number(v);
  return v !== null && v !== "" && Number.isInteger(n) && n >= low && n <= high ? n : wrong(line);
}
const swapFirst = (value: unknown, next: string) => [next, ...rest(value)].join(",");

/**
 * Turns the changed values into what Proxmox expects. Only named settings get through, each checked for its
 * own shape, and options a person can't see here (CPU flags, display memory) are carried over rather than lost.
 */
export function changesForm(kind: Kind, c: Config, changes: Record<string, unknown>, running: boolean) {
  const form: Record<string, string> = {};
  const remove: string[] = [];
  const on = (key: string, value: string) => {
    if (value === "") remove.push(key);
    else form[key] = value;
  };
  const shared: Record<string, (v: unknown) => void> = {
    name: (v) => {
      const name = typeof v === "string" && NAME.test(v) ? v : wrong("A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
      form[kind === "qemu" ? "name" : "hostname"] = name;
    },
    notes: (v) => on("description", typeof v === "string" && v.length <= 8000 ? v : wrong("Notes can be up to 8000 characters.")),
    tags: (v) => {
      const tags = String(v ?? "")
        .split(/[;,\s]+/)
        .filter(Boolean);
      if (tags.some((t) => !TAG.test(t))) wrong("Tags use letters, numbers, dots and dashes.");
      on("tags", tags.join(";"));
    },
    onboot: (v) => (form.onboot = bool(v, "Start at boot")),
    protection: (v) => (form.protection = bool(v, "Protection")),
    startOrder: (v) => {
      const others = String(c.startup ?? "")
        .split(",")
        .filter((p) => p && !p.startsWith("order="));
      if (v === null || v === "") return on("startup", others.join(","));
      on("startup", [`order=${whole(v, 1, 999, "Start order is a number from 1 to 999.")}`, ...others].join(","));
    },
    cores: (v) => (form.cores = String(whole(v, 1, 128, "Pick between 1 and 128 processor cores."))),
    cpuLimit: (v) => {
      if (v === null || v === "" || v === 0) return on("cpulimit", "");
      const n = Number(v);
      form.cpulimit = n > 0 && n <= 128 ? String(n) : wrong("A processor limit is between 0 and 128.");
    },
    memoryMb: (v) => (form.memory = String(whole(v, 16, 4194304, "Give it at least 16 MB of memory."))),
  };
  const qemu: Record<string, (v: unknown) => void> = {
    sockets: (v) => (form.sockets = String(whole(v, 1, 4, "Pick between 1 and 4 sockets."))),
    cpu: (v) => {
      if (v === "") return on("cpu", "");
      const type = typeof v === "string" && CPU.test(v) ? v : wrong("That processor type isn't valid.");
      const keep = String(c.cpu ?? "")
        .split(",")
        .filter((p) => p.includes("=") && !p.startsWith("cputype="));
      form.cpu = [type, ...keep].join(",");
    },
    numa: (v) => (form.numa = bool(v, "NUMA")),
    balloonMb: (v) => {
      if (v === null || v === "") return on("balloon", "");
      const memory = Number(changes.memoryMb ?? memoryOf(c.memory));
      form.balloon = String(whole(v, 0, memory, "Memory it can shrink to has to be less than its full memory."));
    },
    ostype: (v) => (form.ostype = OSTYPES.includes(String(v)) ? String(v) : wrong("That operating system isn't valid.")),
    machine: (v) => {
      if (v === "") return on("machine", rest(c.machine).length ? swapFirst(c.machine, "pc") : "");
      form.machine = swapFirst(c.machine, typeof v === "string" && MACHINE.test(v) ? v : wrong("That machine type isn't valid."));
    },
    bios: (v) => {
      if (v !== "seabios" && v !== "ovmf") wrong("Pick BIOS or UEFI.");
      if (running) wrong("Shut it down before changing how it starts up.");
      form.bios = String(v);
      if (v === "ovmf" && c.efidisk0 === undefined) {
        // UEFI needs a small disk for its settings. It goes wherever the system disk already is.
        const home = Object.entries(c).find(([k, x]) => /^(scsi|virtio|sata)\d+$/.test(k) && !String(x).includes("media=cdrom"));
        const store = home ? String(home[1]).split(":")[0] : "";
        form.efidisk0 = store ? `${store}:1,efitype=4m,pre-enrolled-keys=0` : wrong("Give it a disk before switching to UEFI.");
      }
    },
    scsihw: (v) => (form.scsihw = CONTROLLERS.includes(String(v)) ? String(v) : wrong("That disk controller isn't valid.")),
    display: (v) => {
      if (v === "") return on("vga", rest(c.vga).length ? swapFirst(c.vga, "std") : "");
      form.vga = swapFirst(c.vga, DISPLAYS.includes(String(v)) ? String(v) : wrong("That display isn't valid."));
    },
    agent: (v) => {
      const keep = String(c.agent ?? "")
        .split(",")
        .filter((p) => p.includes("=") && !p.startsWith("enabled="));
      form.agent = [bool(v, "The guest agent"), ...keep].join(",");
    },
    tablet: (v) => (form.tablet = bool(v, "Tablet pointer")),
    acpi: (v) => (form.acpi = bool(v, "ACPI")),
    kvm: (v) => (form.kvm = bool(v, "Hardware virtualization")),
  };
  const container: Record<string, (v: unknown) => void> = {
    swapMb: (v) => (form.swap = String(whole(v, 0, 4194304, "Swap can't be negative."))),
    dns: (v) => on("nameserver", v === "" ? "" : typeof v === "string" && DNS.test(v) ? v : wrong("Enter DNS servers as addresses separated by spaces.")),
    searchDomain: (v) => on("searchdomain", v === "" ? "" : typeof v === "string" && DOMAIN.test(v) ? v : wrong("That search domain isn't valid.")),
  };
  const features: Record<string, string> = {};
  for (const key of ["nesting", "keyctl", "fuse"]) {
    if (kind === "lxc") container[key] = (v) => (features[key] = bool(v, key));
  }
  const rules = { ...shared, ...(kind === "qemu" ? qemu : container) };
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(rules, key)) wrong("That setting can't be changed here.");
    rules[key]?.(value);
  }
  if (Object.keys(features).length) {
    const merged = new Map(
      String(c.features ?? "")
        .split(",")
        .filter(Boolean)
        .map((p) => p.split("=") as [string, string]),
    );
    for (const [k, v] of Object.entries(features)) {
      if (v === "1") merged.set(k, "1");
      else merged.delete(k);
    }
    on("features", [...merged].map(([k, v]) => `${k}=${v}`).join(","));
  }
  if (remove.length) form.delete = remove.join(",");
  if (!Object.keys(form).length) wrong("Nothing changed.");
  return form;
}

interface RawPending {
  key: string;
  value?: string | number;
  pending?: string | number;
  delete?: number;
}
/** What's saved but won't take effect until the guest is next shut down and started. */
export function waitingChanges(raw: RawPending[]) {
  return raw.filter((p) => p.pending !== undefined || p.delete).map((p) => ({ key: p.key, next: p.delete ? "" : String(p.pending) }));
}
