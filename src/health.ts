/**
 * The health check (ADR 0017): every check BossMox can make, in plain words, the ones that pass included, so
 * someone new can see what healthy looks like. Each problem carries the fix BossMox already has. Pure: server.ts
 * gathers Proxmox's answers and passes them in.
 */
import type { HeartbeatState } from "./redundancy.js";
import { KIND_NAMES, type AlertsView } from "./alerts.js";
import type { NetCheck } from "./cluster-net.js";
import type { StorageMap } from "./storage-map.js";

/**
 * "off" is a check the person turned off: never counted as passed, and it says how to turn it back on. "tip" is best
 * practice, not a fault (ADR 0035): never a warning colour, never counted as worth a look, and the page lets it be dismissed.
 */
export type Status = "ok" | "warn" | "bad" | "off" | "tip";
export interface Fix {
  /** Which button the screen shows: each maps to something BossMox already does. */
  kind:
    | "channel"
    | "updates"
    | "protect"
    | "add-storage"
    | "open-storage"
    | "tasks"
    | "boot-on"
    | "open-vm"
    | "backups-elsewhere"
    | "bossmox-update"
    | "update-check"
    | "check-now"
    | "settings"
    | "move-network"
    | "ha-policy"
    | "leftover"
    | "ha-recover";
  label: string;
  node?: string;
  channel?: string;
  vmids?: number[];
  /** The leftover disks a Remove offers, each named so the person sees exactly what goes. */
  disks?: Leftover[];
}
export interface Leftover {
  vmid: number;
  guest: string;
  node: string;
  type: "qemu" | "lxc";
  slot: string;
  volume: string;
  sizeGb: number | null;
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
  /** A tie-breaker that's connected and giving its vote. */
  tieBreaker: boolean;
  /** A tie-breaker is set up but not connected, so it gives no vote (#51). */
  tieBreakerDown?: boolean;
  /** Whether moves share the heartbeat's only network (ADR 0028). */
  network?: NetCheck;
  /** Proxmox's HA shutdown policy and how many guests HA manages (ADR 0031). */
  ha?: { policy: string; guests: number };
  /** Whether the heartbeat has a backup link, or could (ADR 0035). */
  heartbeat?: HeartbeatState | null;
  /** Where Proxmox's own alerts go, if anywhere (ADR 0038). */
  alerts?: AlertsView | null;
  /** Why email alerts stopped, when Microsoft refused BossMox (ADR 0040). */
  emailFailed?: string | null;
  /** Nodes that don't have BossMox's CA yet, so their alerts can't reach it for email (ADR 0040). */
  linkMissing?: string[];
  /** Days left on BossMox's own certificate. */
  certDaysLeft?: number | null;
  /** Disks detached from their guests but still on storage (ADR 0031). */
  leftover?: Leftover[];
  channels: { node: string; ok: boolean; headline: string; note: string; offer: string | null }[];
  updates: { node: string; total: number }[];
  guests: { id: number; name: string; node: string; running: boolean; template: boolean; startsAtBoot: boolean; issues: { kind: string; title: string }[]; ha?: string | null; lock?: string | null }[];
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
  add(
    offline.length
      ? {
          id: "nodes-online",
          group: "Nodes",
          status: "bad",
          title: `${list(offline)} ${offline.length === 1 ? "is" : "are"} offline`,
          detail: "Proxmox can't reach it. Guests on it aren't running, and nothing there can be changed until it's back.",
        }
      : { id: "nodes-online", group: "Nodes", status: "ok", title: h.nodes.length === 1 ? "The node is online" : `All ${h.nodes.length} nodes are online`, detail: "" },
  );
  if (h.cluster) {
    const votes = h.votes.reduce((a, v) => a + v.votes, 0) + (h.tieBreaker ? 1 : 0);
    if (!h.cluster.quorate)
      add({
        id: "votes",
        group: "Nodes",
        status: "bad",
        title: "The cluster has lost its majority",
        detail: "Too few nodes can see each other, so Proxmox has stopped starting, stopping or changing guests until enough of them are back.",
      });
    else if (votes <= 2)
      add({
        id: "votes",
        group: "Nodes",
        status: "warn",
        title: h.tieBreakerDown ? "The tie-breaker isn't connected" : "One node going down would lock the other",
        detail: `The cluster has ${plural(votes, "vote")}. Proxmox needs more than half of them, so if either node goes down, the other can't start, stop or change guests until it's back. ${h.tieBreakerDown ? "A tie-breaker is set up, but it isn't connected, so its vote doesn't count. Check that the machine running it is on and reachable on port 5403." : "A small third machine as a tie-breaker fixes this, and it's set up in Settings."}`,
        ...(!h.tieBreakerDown && h.votes.length % 2 === 0 ? { fix: { kind: "settings" as const, label: "Open Settings" } } : {}),
      });
    else add({ id: "votes", group: "Nodes", status: "ok", title: "The cluster can lose a node and keep going", detail: `${plural(votes, "vote")}${h.tieBreaker ? ", including a tie-breaker" : ""}.` });
    const net = h.network;
    if (net?.known && net.shared) {
      const fix = net.others.length
        ? ` Every node is also on ${net.others[0]}. Fix this gives moves that network.`
        : " Giving moves a network of their own takes a second network card on each node. Until then, Fix this can limit how fast moves run.";
      add({
        id: "move-network",
        group: "Nodes",
        status: "warn",
        title: "VM moves and the cluster heartbeat share one network",
        detail: `Moves run on ${net.moveNet}, which is also the only network the nodes use to check on each other. A few big moves at once can fill it, the nodes lose touch, and HA restarts a node to protect its VMs. Until moves have their own network, BossMox moves one VM at a time.${fix}`,
        fix: { kind: "move-network", label: "Fix this" },
      });
    } else if (net?.known) {
      add({
        id: "move-network",
        group: "Nodes",
        status: "ok",
        title: "VM moves have a network of their own",
        detail: `Moves run on ${net.moveNet}, apart from the cluster heartbeat, so BossMox moves up to ${net.batch} VMs at a time.`,
      });
    }
    const ha = h.ha;
    if (ha && ha.guests > 0 && h.nodes.length >= 2) {
      const n = ha.guests === 1 ? "One guest is" : `${ha.guests} guests are`;
      const them = ha.guests === 1 ? "it" : "them";
      if (ha.policy !== "migrate")
        add({
          id: "ha-shutdown",
          group: "Nodes",
          status: "warn",
          title: "HA stops its guests when a node restarts outside BossMox",
          detail: `${n} managed by HA. When a node is restarted from Proxmox or by hand, Proxmox's default stops ${them} until that node is back. With Migrate, HA moves ${them} to another node first and back afterwards. BossMox's own restarts move guests first either way.`,
          fix: { kind: "ha-policy", label: "Fix this" },
        });
      else
        add({
          id: "ha-shutdown",
          group: "Nodes",
          status: "ok",
          title: "HA moves its guests before a node restarts",
          detail: `${n} managed by HA. When a node restarts, HA moves ${them} to another node first. Before shutting every node down at once, stop the HA guests first: otherwise HA can leave one half-moved and locked.`,
        });
    }
    // A guest HA gave up on (ADR 0036): it won't start again by itself.
    for (const g of h.guests.filter((x) => x.ha === "error")) {
      const lock = g.lock ? ` It's also locked (${g.lock})${g.lock === "migrate" ? ", which usually means a move was cut off, such as by every node shutting down at once" : ""}.` : "";
      add({
        id: `ha-error-${g.id}`,
        group: "Nodes",
        status: "bad",
        title: `HA gave up on ${g.name}`,
        detail: `HA couldn't start or move it, so it stopped trying. It won't come back by itself.${lock} Fix this ${g.lock ? "unlocks it, then " : ""}sets it to disabled under HA and starts it again.`,
        fix: { kind: "ha-recover", label: "Fix this", vmids: [g.id], node: g.node },
      });
    }
    // Best practice, not a fault: a backup network for the heartbeat (ADR 0035). Set up in Settings.
    const hb = h.heartbeat;
    const why =
      "The nodes check on each other over one network. If it has trouble, they lose touch, and HA can restart a node to protect its guests. A second network on its own port keeps them in touch.";
    if (hb?.state === "backed-up")
      add({ id: "heartbeat", group: "Nodes", status: "ok", title: "The heartbeat has a backup network", detail: `The nodes check on each other over ${hb.links} networks.` });
    else if (hb?.state === "offer")
      add({
        id: "heartbeat",
        group: "Nodes",
        status: "tip",
        title: "Best practice: give the heartbeat a backup network",
        detail: `${why} Every node has ${hb.network} on a second port, so it can be set up in Settings.`,
        fix: { kind: "settings", label: "Open Settings" },
      });
    else if (hb?.state === "no-port")
      add({
        id: "heartbeat",
        group: "Nodes",
        status: "tip",
        title: "Best practice: give the heartbeat a backup network",
        detail: `${why} That needs a second network port on every node, on a network of its own${hb.nodes.length ? `; ${list(hb.nodes)} ${hb.nodes.length === 1 ? "doesn't have one" : "don't have one"}` : ", shared by all of them"}.`,
      });
  }
  // Alerts and BossMox's own certificate matter on a single node as much as on a cluster.
  // Alerts (ADR 0038): best practice while Proxmox's alerts reach no one, a pass once a test was seen to arrive.
  const al = h.alerts;
  if (al) {
    const fix = { kind: "settings" as const, label: "Open Settings" };
    if (al.kind && al.confirmed)
      add({ id: "alerts", group: "Nodes", status: "ok", title: `Proxmox sends alerts to ${KIND_NAMES[al.kind]} when something fails`, detail: al.where ? `Through ${al.where}.` : "" });
    else if (al.kind)
      add({
        id: "alerts",
        group: "Nodes",
        status: "tip",
        title: "Best practice: check that alerts arrive",
        detail: `Alerts go to ${KIND_NAMES[al.kind]}, but no test has been seen to arrive yet. Send a test from Settings, and say whether it came.`,
        fix,
      });
    else if (al.others.length)
      add({ id: "alerts", group: "Nodes", status: "ok", title: "Proxmox sends alerts when something fails", detail: `Through ${al.others.join(", ")}, set up outside BossMox.` });
    else if (al.nothingDelivers)
      add({
        id: "alerts",
        group: "Nodes",
        status: "tip",
        title: "Best practice: get an alert when something fails",
        detail:
          "Right now a fenced node, a failed backup or a failed replication tells no one: Proxmox's built-in alert goes to root's email address, and none is set. Settings can send them to your phone (ntfy), Discord, Slack, Teams or Gotify.",
        fix,
      });
  }
  if (h.emailFailed) add({ id: "email", group: "Nodes", status: "warn", title: "Email alerts have stopped", detail: h.emailFailed, fix: { kind: "settings" as const, label: "Open Settings" } });
  if (h.linkMissing?.length)
    add({
      id: "email-nodes",
      group: "Nodes",
      status: "warn",
      title: "Some nodes can't send alerts to BossMox for email",
      detail: `${h.linkMissing.join(", ")} ${h.linkMissing.length === 1 ? "hasn't" : "haven't"} been given BossMox's certificate, so ${h.linkMissing.length === 1 ? "its" : "their"} alerts can't reach it. In Settings, choose Change under Alerts and save again as root@pam.`,
      fix: { kind: "settings" as const, label: "Open Settings" },
    });
  if (h.certDaysLeft !== undefined && h.certDaysLeft !== null && h.certDaysLeft < 30)
    add({
      id: "bossmox-cert",
      group: "Nodes",
      status: "warn",
      title: h.certDaysLeft < 0 ? "BossMox's certificate has run out" : `BossMox's certificate runs out in ${h.certDaysLeft} days`,
      detail: "BossMox renews it every day once under 60 days are left, so this means renewing failed. On the BossMox machine, run bossmox-cert renew as root and read what it says.",
    });
  const badChannels = h.channels.filter((c) => !c.ok);
  if (badChannels.length)
    for (const c of badChannels)
      add({
        id: `channel-${c.node}`,
        group: "Nodes",
        status: "bad",
        title: `${c.headline} on ${c.node}`,
        detail: c.note,
        ...(c.offer ? { fix: { kind: "channel", label: c.offer === "free" ? "Use the free channel" : "Use the enterprise channel", node: c.node, channel: c.offer } } : {}),
      });
  else if (h.channels.length) add({ id: "channels", group: "Nodes", status: "ok", title: "Updates download on every node", detail: "" });
  const waiting = h.updates.filter((u) => u.total > 0);
  if (waiting.length)
    for (const u of waiting)
      add({
        id: `updates-${u.node}`,
        group: "Nodes",
        status: "warn",
        title: `${plural(u.total, "update")} waiting on ${u.node}`,
        detail: "Updates fix security problems and bugs. BossMox can install them, moving guests out of the way first if a restart is needed.",
        fix: { kind: "updates", label: "See updates", node: u.node },
      });
  else if (h.updates.length) add({ id: "updates", group: "Nodes", status: "ok", title: "Every node is up to date", detail: "As of each node's last check for updates." });

  // Backups
  const guests = h.guests.filter((g) => !g.template);
  const unscheduled = guests.filter((g) => h.unscheduled.includes(g.id)).map((g) => g.name);
  if (h.backupsElsewhere) {
    add({
      id: "scheduled",
      group: "Backups",
      status: "off",
      title: "Backup schedules aren't being checked",
      detail:
        "You told BossMox your guests are backed up another way, so it doesn't warn about guests without a Proxmox backup schedule. Failed Proxmox backups are still reported. To have it check again, use Check schedules again.",
      fix: { kind: "backups-elsewhere", label: "Check schedules again" },
    });
  } else {
    add(
      unscheduled.length
        ? {
            id: "scheduled",
            group: "Backups",
            status: "warn",
            title: `${plural(unscheduled.length, "guest")} ${unscheduled.length === 1 ? "isn't" : "aren't"} on a backup schedule`,
            detail: `${list(unscheduled)}. Nothing is keeping a copy current, so a mistake or a failed drive could lose ${unscheduled.length === 1 ? "it" : "them"}.`,
            fix: { kind: "protect", label: "Protect everything" },
          }
        : { id: "scheduled", group: "Backups", status: "ok", title: guests.length ? "Every guest is on a backup schedule" : "No guests to back up yet", detail: "" },
    );
  }
  const shared = new Set(h.maps.flatMap((m) => m.network.map((p) => p.id)));
  const local = h.jobs.filter((j) => j.enabled && !shared.has(j.storage));
  if (local.length)
    add({
      id: "backup-place",
      group: "Backups",
      status: "warn",
      title: `Backups are saved on the same computer as the guests`,
      detail: `The schedule saving to ${list([...new Set(local.map((j) => j.storage))])} keeps backups on a node's own drives. If that computer fails or is stolen, the backups go with it. A NAS is safer.`,
      fix: { kind: "add-storage", label: "Add a NAS" },
    });
  else if (h.jobs.some((j) => j.enabled)) add({ id: "backup-place", group: "Backups", status: "ok", title: "Backups are saved off the nodes", detail: "" });
  if (h.failedBackups.length) {
    const last = h.failedBackups[0]!;
    add({
      id: "backup-failed",
      group: "Backups",
      status: "bad",
      title: `${plural(h.failedBackups.length, "backup")} failed in the last week`,
      detail: `The latest was ${last.guest ? `${last.guest} ` : ""}on ${last.node}. A schedule that fails quietly is the same as no backup.`,
      fix: { kind: "tasks", label: "See what happened", node: last.node },
    });
  } else if (h.jobs.length) add({ id: "backup-failed", group: "Backups", status: "ok", title: "No backups failed in the last week", detail: "" });

  // Storage
  const pools = h.maps.flatMap((m) => [...m.groups.flatMap((g) => g.pools), ...m.unplaced].map((p) => ({ p, node: m.node }))).concat(h.maps[0] ? h.maps[0].network.map((p) => ({ p, node: "" })) : []);
  const issues: Check[] = [];
  for (const { p, node } of pools) {
    const where = node ? ` on ${node}` : "";
    if (!p.active) {
      issues.push({
        id: `reach-${node}-${p.id}`,
        group: "Storage",
        status: "bad",
        title: `${p.id} can't be reached${where}`,
        detail: "Anything kept there, guests' disks or backups, can't be used until it's back. Check that it's switched on and connected.",
        fix: { kind: "open-storage", label: "Open Storage", ...(node ? { node } : {}) },
      });
      continue;
    }
    const pct = p.totalGb ? Math.round((p.usedGb / p.totalGb) * 100) : 0;
    if (pct >= 90)
      issues.push({
        id: `full-${node}-${p.id}`,
        group: "Storage",
        status: pct >= 95 ? "bad" : "warn",
        title: `${p.id} is ${pct}% full${where}`,
        detail: `${p.freeGb} GB left. When it fills, guests on it stop and backups to it fail.`,
        fix: { kind: "open-storage", label: "See what's on it", ...(node ? { node } : {}) },
      });
    if (p.overGivenGb)
      issues.push({
        id: `over-${node}-${p.id}`,
        group: "Storage",
        status: "warn",
        title: `${p.id} has promised more space than it has${where}`,
        detail: `Its disks add up to ${p.overGivenGb} GB, but it holds ${p.totalGb} GB. That's fine while they're mostly empty; if they all fill up, the guests on it stop.`,
        fix: { kind: "open-storage", label: "Open Storage", ...(node ? { node } : {}) },
      });
  }
  for (const m of h.maps) {
    for (const d of [...m.groups.flatMap((g) => g.disks), ...m.empty, ...m.otherDisks]) {
      if (d.failing)
        issues.push({
          id: `disk-${m.node}-${d.path}`,
          group: "Storage",
          status: "bad",
          title: `${d.model || d.path} on ${m.node} is failing`,
          detail: "The drive itself reports a problem. Copy anything important off it and replace it soon.",
          fix: { kind: "open-storage", label: "Open Storage", node: m.node },
        });
      else if (d.wearLeft !== null && d.wearLeft <= 10)
        issues.push({
          id: `wear-${m.node}-${d.path}`,
          group: "Storage",
          status: "warn",
          title: `${d.model || d.path} on ${m.node} is nearly worn out`,
          detail: `${d.wearLeft}% of its life is left. Plan to replace it.`,
          fix: { kind: "open-storage", label: "Open Storage", node: m.node },
        });
    }
  }
  if (issues.length) out.push(...issues);
  else add({ id: "storage", group: "Storage", status: "ok", title: "Storage and drives look healthy", detail: "Nothing nearly full or unreachable, and no drive reports a problem." });

  const left = h.leftover ?? [];
  if (left.length) {
    const sized = left.filter((d) => d.sizeGb !== null);
    const total = Math.round(sized.reduce((a, d) => a + (d.sizeGb ?? 0), 0));
    add({
      id: "leftover",
      group: "Storage",
      status: "warn",
      title: `${plural(left.length, "leftover disk")} ${left.length === 1 ? "is" : "are"} taking up space`,
      detail: `${list(
        left.map((d) => `${d.guest}: ${d.volume}${d.sizeGb !== null ? ` (${Math.round(d.sizeGb)} GB)` : ""}`),
        3,
      )}. ${left.length === 1 ? "It's" : "They're"} detached from ${left.length === 1 ? "its guest" : "their guests"} and nothing uses ${left.length === 1 ? "it" : "them"}, often left behind by an import or a disk move.${sized.length ? ` Removing ${left.length === 1 ? "it" : "them"} frees ${sized.length < left.length ? "at least " : ""}${total} GB.` : ""}`,
      fix: { kind: "leftover", label: "Review and remove", disks: left },
    });
  }
  // Guests
  const noBoot = guests.filter((g) => g.running && !g.startsAtBoot);
  add(
    noBoot.length
      ? {
          id: "boot",
          group: "Guests",
          status: "warn",
          title: `${plural(noBoot.length, "running guest")} won't start again after a node restart`,
          detail: `${list(noBoot.map((g) => g.name))}. After a power cut or an update restart, ${noBoot.length === 1 ? "it stays" : "they stay"} off until someone notices.`,
          fix: { kind: "boot-on", label: noBoot.length === 1 ? "Start it at boot" : "Start them at boot", vmids: noBoot.map((g) => g.id) },
        }
      : { id: "boot", group: "Guests", status: "ok", title: "Running guests start again after a restart", detail: "" },
  );
  const slow = guests.filter((g) => g.issues.some((i) => i.kind === "disk-controller" || i.kind === "network-card"));
  add(
    slow.length
      ? {
          id: "slow",
          group: "Guests",
          status: "warn",
          title: `${plural(slow.length, "guest")} could run faster`,
          detail: `${list(slow.map((g) => g.name))} ${slow.length === 1 ? "uses" : "use"} an older disk or network setting. Each one's page says which, and how to change it.`,
          fix: { kind: "open-vm", label: "Open the first one", vmids: slow.map((g) => g.id) },
        }
      : { id: "slow", group: "Guests", status: "ok", title: "Guests use the fast disk and network settings", detail: "" },
  );

  // BossMox itself
  if (h.ownDhcp === true)
    add({
      id: "own-address",
      group: "BossMox",
      status: "warn",
      title: "BossMox's address could change",
      detail:
        "Its VM gets its address from your router, which can hand it a different one after a restart. Your bookmark would stop working until you found the new one on the VM's console. The simplest fix is to reserve its address in your router's DHCP settings. Keeping it fixed from here is coming in a later release.",
    });
  else if (h.ownDhcp === false) add({ id: "own-address", group: "BossMox", status: "ok", title: "BossMox keeps the same address", detail: "" });
  const u = h.update;
  if (u && !u.on)
    add({
      id: "bossmox-version",
      group: "BossMox",
      status: "off",
      title: "BossMox isn't checking for updates",
      detail: `You turned the check off, so BossMox won't tell you when a new version is out. This is ${u.running}. To have it check again, use Check for updates.`,
      fix: { kind: "update-check", label: "Check for updates" },
    });
  else if (u?.available)
    add({
      id: "bossmox-version",
      group: "BossMox",
      status: "warn",
      title: `BossMox ${u.available.version} is available`,
      detail: `This is ${u.running}. Updating takes one command on a Proxmox node, and your settings stay.`,
      fix: { kind: "bossmox-update", label: "How to update" },
    });
  else if (u?.failed)
    add({
      id: "bossmox-version",
      group: "BossMox",
      status: "warn",
      title: "BossMox couldn't check for updates",
      detail: `${u.failed}. It tries again every 6 hours, or use Check now. If this BossMox can't reach the internet on purpose, turn the check off.`,
      fix: { kind: "update-check", label: "Turn the check off" },
    });
  else if (u?.checkedAt)
    add({
      id: "bossmox-version",
      group: "BossMox",
      status: "ok",
      title: "BossMox is up to date",
      detail: `This is ${u.running}. It checks for a new version every 6 hours, or now with Check now.`,
      fix: { kind: "check-now", label: "Check now" },
    });
  else if (u)
    add({
      id: "bossmox-version",
      group: "BossMox",
      status: "ok",
      title: "BossMox hasn't checked for updates yet",
      detail: `This is ${u.running}. It checks a minute after it starts, then every 6 hours.`,
      fix: { kind: "check-now", label: "Check now" },
    });
  return out;
}
