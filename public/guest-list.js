/* VMs and Containers: which guests the list shows, in what order, and the word for each type (ADR 0043).
   A plain script loaded before app.js, so it shares the page's scope; the tests run it the same way. */

/** What the list can be narrowed and sorted by. The first entry of each is the default. */
const GUEST_TYPES = [
  ["all", "All types"],
  ["qemu", "VMs only"],
  ["lxc", "Containers only"],
];
const GUEST_SORTS = [
  // "By", so the sort never reads as a second type filter beside it.
  ["name", "By name"],
  ["type", "By type"],
  ["node", "By node"],
];

/** Proxmox calls a VM "qemu" and a container "lxc"; people call them a virtual machine and a container. */
function guestTypeWord(v) {
  return v.type === "lxc" ? "Container" : "Virtual machine";
}

/** A stored choice is only trusted if it's one the list offers: anything else (an old or hand-edited value) is the default. */
function guestListPrefs(saved) {
  const pick = (list, value) => (list.some(([k]) => k === value) ? value : list[0][0]);
  const s = saved && typeof saved === "object" ? saved : {};
  return { type: pick(GUEST_TYPES, s.type), sort: pick(GUEST_SORTS, s.sort) };
}

/**
 * The guests to show. f: { q, node, state ("all" | "running" | "look"), type ("all" | "qemu" | "lxc"), sort ("name" | "type" | "node") }.
 * Name order breaks every tie, so the list never shuffles between refreshes.
 */
function guestList(vms, f) {
  const q = (f.q ?? "").toLowerCase();
  const type = f.type ?? "all";
  const state = f.state ?? "all";
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const orders = {
    name: byName,
    // VMs first, then containers; a type Proxmox adds later goes last rather than breaking the sort.
    type: (a, b) => typeRank(a) - typeRank(b) || byName(a, b),
    node: (a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }) || byName(a, b),
  };
  // Own keys only: "toString" or "constructor" would otherwise come back from the object's prototype (review 2026-11-18).
  const order = Object.hasOwn(orders, f.sort) ? orders[f.sort] : byName;
  return vms
    .filter(
      (v) =>
        (!f.node || v.node === f.node) &&
        (type === "all" || v.type === type) &&
        (state === "all" || (state === "running" && v.running) || (state === "look" && v.issues.length > 0)) &&
        `${v.name}${v.os ?? ""}`.toLowerCase().includes(q),
    )
    .sort(order);
}
/**
 * Which guest the detail pane should show: the one picked, while the list still shows it; otherwise the first one the
 * list shows, or none. The pane and its buttons never belong to a guest the list has hidden (review 2026-11-18).
 */
function shownGuest(list, sel) {
  return list.some((v) => v.id === sel) ? sel : (list[0]?.id ?? null);
}
function typeRank(v) {
  return v.type === "qemu" ? 0 : v.type === "lxc" ? 1 : 2;
}
