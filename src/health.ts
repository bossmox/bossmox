/**
 * The health check (ADR 0017): every check BossMox can make, in plain words, the ones that pass included, so
 * someone new can see what healthy looks like. Each problem carries the fix BossMox already has. Pure: server.ts
 * gathers Proxmox's answers and passes them in.
 */
import type { NetCheck } from "./cluster-net.js";
import type { StorageMap } from "./storage-map.js";

/** "off" is a check the person turned off: never counted as passed, and it says how to turn it back on. */
export type Status = "ok" | "warn" | "bad" | "off";
export interface Fix {
  /** Which button the screen shows: each maps to something BossMox already does. */
  kind: "channel" | "updates" | "protect" | "add-storage" | "open-storage" | "tasks" | "boot-on" | "open-vm" | "backups-elsewhere" | "bossmox-update" | "update-check" | "check-now" | "settings";
  label: string;
  node?: string;
  channel?: string;
  vmids?: number[];
}
export interface Check {
  id: string;
  group: "Nodes" | "Backups" | "Storage" | "Guests" | "BossMox";
  status: Status;
  title: string;
  detail: string;
  fix?: Fix;
}

export interface HealthInput {
  nodes: { name: string; online: boolean }[];
  /** From /cluster/status: undefined on a single node that isn't in a cluster. */
  cluster?: { quorate: boolean };
  votes: { node: string; votes: number }[];
  tieBreaker: boolean;
  /** Whether moves share the heartbeat's only network (ADR 0028). */
  network?: NetCheck;
  channels: { node: string; ok: boolean; headline: string; note: string; offer: string | null }[];
  updates: { node: string; total: number }[];
  guests: { id: number; name: string; node: string; running: boolean; template: boolean; startsAtBoot: boolean; issues: { kind: string; title: string }[] }[];
  unscheduled: number[];
  /** The person said the guests are backed up another way, so schedules aren't checked (ADR 0018). */
  backupsElsewhere?: boolean;
  jobs: { id: string; storage: string; enabled: boolean }[];
  /** Backup tasks that ended badly lately, newest first. */
  failedBackups: { node: string; guest: string; at: number }[];
  maps: StorageMap[];
  /** True when BossMox's own address comes from DHCP, null when it can't tell (it isn't running in its VM). */
  ownDhcp: boolean | null;
  /** The check for a newer BossMox (ADR 0019); absent on a copy with no version, run from the repo. */
  update?: { on: boolean; checkedAt: number | null; available: { version: string } | null; failed: string | null; running: string };
}

const list = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildHealth(h: HealthInput): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // Nodes
  const offline = h.nodes.filter((n) => !n.online).map((n) => n.name);
  add(offline.length
    ? { id: "nodes-online", group: "Nodes", status: "bad", title: `${list(offline)} ${offline.length === 1 ? "is" : "are"} offline`, detail: "Proxmox can't reach it. Guests on it aren't running, and nothing there can be changed until it's back." }
    : { id: "nodes-online", group: "Nodes", status: "ok", title: h.nodes.length === 1 ? "The node is online" : `All ${h.nodes.length} nodes are online`, detail: "" });
  if (h.cluster) {
    const votes = h.votes.reduce((a, v) => a + v.votes, 0) + (h.tieBreaker ? 1 : 0);
    if (!h.cluster.quorate) add({ id: "votes", group: "Nodes", status: "bad", title: "The cluster has lost its majority", detail: "Too few nodes can see each other, so Proxmox has stopped starting, stopping or changing guests until enough of them are back." });
    else if (votes <= 2) add({ id: "votes", group: "Nodes", status: "warn", title: "One node going down would lock the other", detail: `The cluster has ${plural(votes, "vote")}. Proxmox needs more than half of them, so if either node goes down, the other can't start, stop or change guests until it's back. A small third machine as a tie-breaker fixes this. Setting one up is coming in a later release.` });
    else add({ id: "votes", group: "Nodes", status: "ok", title: "The cluster can lose a node and keep going", detail: `${plural(votes, "vote")}${h.tieBreaker ? ", including a tie-breaker" : ""}.` });
    const net = h.network;
    if (net?.known && net.shared) {
      const fix = net.others.length
        ? ` Every node is also on ${net.others[0]}. Settings can give moves that network with one switch.`
        : " Giving moves a network of their own takes a second network card on each node. Until then, Settings can limit how fast moves run.";
      add({ id: "move-network", group: "Nodes", status: "warn", title: "VM moves and the cluster heartbeat share one network", detail: `Moves run on ${net.moveNet}, which is also the only network the nodes use to check on each other. A few big moves at once can fill it, the nodes lose touch, and HA restarts a node to protect its VMs. Until moves have their own network, BossMox moves one VM at a time.${fix}`, fix: { kind: "settings", label: "Open Settings" } });
    } else if (net?.known) {
      add({ id: "move-network", group: "Nodes", status: "ok", title: "VM moves have a network of their own", detail: `Moves run on ${net.moveNet}, apart from the cluster heartbeat, so BossMox moves up to ${net.batch} VMs at a time.` });
    }
  }
  const badChannels = h.channels.filter((c) => !c.ok);
  if (badChannels.length) for (const c of badChannels) add({ id: `channel-${c.node}`, group: "Nodes", status: "bad", title: `${c.headline} on ${c.node}`, detail: c.note, ...(c.offer ? { fix: { kind: "channel", label: c.offer === "free" ? "Use the free channel" : "Use the enterprise channel", node: c.node, channel: c.offer } } : {}) });
  else if (h.channels.length) add({ id: "channels", group: "Nodes", status: "ok", title: "Updates download on every node", detail: "" });
  const waiting = h.updates.filter((u) => u.total > 0);
  if (waiting.length) for (const u of waiting) add({ id: `updates-${u.node}`, group: "Nodes", status: "warn", title: `${plural(u.total, "update")} waiting on ${u.node}`, detail: "Updates fix security problems and bugs. BossMox can install them, moving guests out of the way first if a restart is needed.", fix: { kind: "updates", label: "See updates", node: u.node } });
  else if (h.updates.length) add({ id: "updates", group: "Nodes", status: "ok", title: "Every node is up to date", detail: "As of each node's last check for updates." });

  // Backups
  const guests = h.guests.filter((g) => !g.template);
  const unscheduled = guests.filter((g) => h.unscheduled.includes(g.id)).map((g) => g.name);
  if (h.backupsElsewhere) {
    add({ id: "scheduled", group: "Backups", status: "off", title: "Backup schedules aren't being checked", detail: "You told BossMox your guests are backed up another way, so it doesn't warn about guests without a Proxmox backup schedule. Failed Proxmox backups are still reported. To have it check again, use Check schedules again.", fix: { kind: "backups-elsewhere", label: "Check schedules again" } });
  } else {
    add(unscheduled.length
      ? { id: "scheduled", group: "Backups", status: "warn", title: `${plural(unscheduled.length, "guest")} ${unscheduled.length === 1 ? "isn't" : "aren't"} on a backup schedule`, detail: `${list(unscheduled)}. Nothing is keeping a copy current, so a mistake or a failed drive could lose ${unscheduled.length === 1 ? "it" : "them"}.`, fix: { kind: "protect", label: "Protect everything" } }
      : { id: "scheduled", group: "Backups", status: "ok", title: guests.length ? "Every guest is on a backup schedule" : "No guests to back up yet", detail: "" });
  }
  const shared = new Set(h.maps.flatMap((m) => m.network.map((p) => p.id)));
  const local = h.jobs.filter((j) => j.enabled && !shared.has(j.storage));
  if (local.length) add({ id: "backup-place", group: "Backups", status: "warn", title: `Backups are saved on the same computer as the guests`, detail: `The schedule saving to ${list([...new Set(local.map((j) => j.storage))])} keeps backups on a node's own drives. If that computer fails or is stolen, the backups go with it. A NAS is safer.`, fix: { kind: "add-storage", label: "Add a NAS" } });
  else if (h.jobs.some((j) => j.enabled)) add({ id: "backup-place", group: "Backups", status: "ok", title: "Backups are saved off the nodes", detail: "" });
  if (h.failedBackups.length) {
    const last = h.failedBackups[0]!;
    add({ id: "backup-failed", group: "Backups", status: "bad", title: `${plural(h.failedBackups.length, "backup")} failed in the last week`, detail: `The latest was ${last.guest ? `${last.guest} ` : ""}on ${last.node}. A schedule that fails quietly is the same as no backup.`, fix: { kind: "tasks", label: "See what happened", node: last.node } });
  } else if (h.jobs.length) add({ id: "backup-failed", group: "Backups", status: "ok", title: "No backups failed in the last week", detail: "" });

  // Storage
  const pools = h.maps.flatMap((m) => [...m.groups.flatMap((g) => g.pools), ...m.unplaced].map((p) => ({ p, node: m.node }))).concat(h.maps[0] ? h.maps[0].network.map((p) => ({ p, node: "" })) : []);
  const issues: Check[] = [];
  for (const { p, node } of pools) {
    const where = node ? ` on ${node}` : "";
    if (!p.active) { issues.push({ id: `reach-${node}-${p.id}`, group: "Storage", status: "bad", title: `${p.id} can't be reached${where}`, detail: "Anything kept there, guests' disks or backups, can't be used until it's back. Check that it's switched on and connected.", fix: { kind: "open-storage", label: "Open Storage", ...(node ? { node } : {}) } }); continue; }
    const pct = p.totalGb ? Math.round((p.usedGb / p.totalGb) * 100) : 0;
    if (pct >= 90) issues.push({ id: `full-${node}-${p.id}`, group: "Storage", status: pct >= 95 ? "bad" : "warn", title: `${p.id} is ${pct}% full${where}`, detail: `${p.freeGb} GB left. When it fills, guests on it stop and backups to it fail.`, fix: { kind: "open-storage", label: "See what's on it", ...(node ? { node } : {}) } });
    if (p.overGivenGb) issues.push({ id: `over-${node}-${p.id}`, group: "Storage", status: "warn", title: `${p.id} has promised more space than it has${where}`, detail: `Its disks add up to ${p.overGivenGb} GB, but it holds ${p.totalGb} GB. That's fine while they're mostly empty; if they all fill up, the guests on it stop.`, fix: { kind: "open-storage", label: "Open Storage", ...(node ? { node } : {}) } });
  }
  for (const m of h.maps) {
    for (const d of [...m.groups.flatMap((g) => g.disks), ...m.empty, ...m.otherDisks]) {
      if (d.failing) issues.push({ id: `disk-${m.node}-${d.path}`, group: "Storage", status: "bad", title: `${d.model || d.path} on ${m.node} is failing`, detail: "The drive itself reports a problem. Copy anything important off it and replace it soon.", fix: { kind: "open-storage", label: "Open Storage", node: m.node } });
      else if (d.wearLeft !== null && d.wearLeft <= 10) issues.push({ id: `wear-${m.node}-${d.path}`, group: "Storage", status: "warn", title: `${d.model || d.path} on ${m.node} is nearly worn out`, detail: `${d.wearLeft}% of its life is left. Plan to replace it.`, fix: { kind: "open-storage", label: "Open Storage", node: m.node } });
    }
  }
  if (issues.length) out.push(...issues);
  else add({ id: "storage", group: "Storage", status: "ok", title: "Storage and drives look healthy", detail: "Nothing nearly full or unreachable, and no drive reports a problem." });

  // Guests
  const noBoot = guests.filter((g) => g.running && !g.startsAtBoot);
  add(noBoot.length
    ? { id: "boot", group: "Guests", status: "warn", title: `${plural(noBoot.length, "running guest")} won't start again after a node restart`, detail: `${list(noBoot.map((g) => g.name))}. After a power cut or an update restart, ${noBoot.length === 1 ? "it stays" : "they stay"} off until someone notices.`, fix: { kind: "boot-on", label: noBoot.length === 1 ? "Start it at boot" : "Start them at boot", vmids: noBoot.map((g) => g.id) } }
    : { id: "boot", group: "Guests", status: "ok", title: "Running guests start again after a restart", detail: "" });
  const slow = guests.filter((g) => g.issues.some((i) => i.kind === "disk-controller" || i.kind === "network-card"));
  add(slow.length
    ? { id: "slow", group: "Guests", status: "warn", title: `${plural(slow.length, "guest")} could run faster`, detail: `${list(slow.map((g) => g.name))} ${slow.length === 1 ? "uses" : "use"} an older disk or network setting. Each one's page says which, and how to change it.`, fix: { kind: "open-vm", label: "Open the first one", vmids: slow.map((g) => g.id) } }
    : { id: "slow", group: "Guests", status: "ok", title: "Guests use the fast disk and network settings", detail: "" });

  // BossMox itself
  if (h.ownDhcp === true) add({ id: "own-address", group: "BossMox", status: "warn", title: "BossMox's address could change", detail: "Its VM gets its address from your router, which can hand it a different one after a restart. Your bookmark would stop working until you found the new one on the VM's console. The simplest fix is to reserve its address in your router's DHCP settings. Keeping it fixed from here is coming in a later release." });
  else if (h.ownDhcp === false) add({ id: "own-address", group: "BossMox", status: "ok", title: "BossMox keeps the same address", detail: "" });
  const u = h.update;
  if (u && !u.on) add({ id: "bossmox-version", group: "BossMox", status: "off", title: "BossMox isn't checking for updates", detail: `You turned the check off, so BossMox won't tell you when a new version is out. This is ${u.running}. To have it check again, use Check for updates.`, fix: { kind: "update-check", label: "Check for updates" } });
  else if (u?.available) add({ id: "bossmox-version", group: "BossMox", status: "warn", title: `BossMox ${u.available.version} is available`, detail: `This is ${u.running}. Updating takes one command on a Proxmox node, and your settings stay.`, fix: { kind: "bossmox-update", label: "How to update" } });
  else if (u?.failed) add({ id: "bossmox-version", group: "BossMox", status: "warn", title: "BossMox couldn't check for updates", detail: `${u.failed}. It tries again every 6 hours, or use Check now. If this BossMox can't reach the internet on purpose, turn the check off.`, fix: { kind: "update-check", label: "Turn the check off" } });
  else if (u?.checkedAt) add({ id: "bossmox-version", group: "BossMox", status: "ok", title: "BossMox is up to date", detail: `This is ${u.running}. It checks for a new version every 6 hours, or now with Check now.`, fix: { kind: "check-now", label: "Check now" } });
  else if (u) add({ id: "bossmox-version", group: "BossMox", status: "ok", title: "BossMox hasn't checked for updates yet", detail: `This is ${u.running}. It checks a minute after it starts, then every 6 hours.`, fix: { kind: "check-now", label: "Check now" } });
  return out;
}
