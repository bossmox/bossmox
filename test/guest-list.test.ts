import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Tests run from dist/test; the page's files are in public/.
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const read = (f: string) => readFileSync(path.join(PUBLIC, f), "utf8");

interface Guest {
  id: number;
  name: string;
  node: string;
  type: string;
  running: boolean;
  os?: string;
  issues: string[];
}
interface Filter {
  q?: string;
  node?: string;
  state?: string;
  type?: string;
  sort?: string;
}
// Run it the way the browser does: a plain script in its own scope, no module system.
const page = vm.runInNewContext(`${read("guest-list.js")}\n;({ guestList, guestTypeWord, guestListPrefs, GUEST_TYPES, GUEST_SORTS })`) as {
  guestList: (vms: Guest[], f: Filter) => Guest[];
  guestTypeWord: (v: { type: string }) => string;
  guestListPrefs: (saved: unknown) => { type: string; sort: string };
  GUEST_TYPES: [string, string][];
  GUEST_SORTS: [string, string][];
};
const names = (list: Guest[]) => list.map((v) => v.name);
const g = (id: number, name: string, type: string, node: string, running = true, issues: string[] = []): Guest => ({ id, name, type, node, running, os: "l26", issues });
const GUESTS = [
  g(101, "web", "qemu", "node2"),
  g(103, "cache", "lxc", "node1", false),
  g(102, "db", "qemu", "node1", true, ["no backup"]),
  g(104, "dns", "lxc", "node2"),
  g(105, "web10", "qemu", "node1"),
  g(106, "web9", "qemu", "node2", false),
];

test("the list filters by type: VMs only, containers only, or both (#107)", () => {
  assert.deepEqual(names(page.guestList(GUESTS, { type: "lxc" })), ["cache", "dns"]);
  assert.deepEqual(names(page.guestList(GUESTS, { type: "qemu" })), ["db", "web", "web9", "web10"]);
  assert.equal(page.guestList(GUESTS, { type: "all" }).length, GUESTS.length);
});

test("the type filter works with the node, Running, Needs a look and search filters, not instead of them (#107)", () => {
  assert.deepEqual(names(page.guestList(GUESTS, { type: "lxc", node: "node2" })), ["dns"]);
  assert.deepEqual(names(page.guestList(GUESTS, { type: "lxc", state: "running" })), ["dns"]);
  assert.deepEqual(names(page.guestList(GUESTS, { type: "qemu", state: "look" })), ["db"]);
  assert.deepEqual(names(page.guestList(GUESTS, { type: "qemu", q: "WEB" })), ["web", "web9", "web10"]);
  assert.deepEqual(names(page.guestList(GUESTS, { type: "lxc", q: "web" })), []);
});

test("sorting by type puts VMs first, then containers, each by name; by node groups each node's guests by name (#107)", () => {
  assert.deepEqual(names(page.guestList(GUESTS, { sort: "type" })), ["db", "web", "web9", "web10", "cache", "dns"]);
  assert.deepEqual(names(page.guestList(GUESTS, { sort: "node" })), ["cache", "db", "web10", "dns", "web", "web9"]);
});

test("sorting by name counts numbers as numbers (web9 before web10), and is the default (#107)", () => {
  assert.deepEqual(names(page.guestList(GUESTS, {})), ["cache", "db", "dns", "web", "web9", "web10"]);
  assert.deepEqual(names(page.guestList(GUESTS, { sort: "something-old" })), names(page.guestList(GUESTS, {})));
});

test("the list never reorders the guests it was given: the page's own data stays as Proxmox sent it", () => {
  const before = names(GUESTS);
  page.guestList(GUESTS, { sort: "type" });
  assert.deepEqual(names(GUESTS), before);
});

test("each guest's type is in plain words, not Proxmox's qemu and lxc (#107)", () => {
  assert.equal(page.guestTypeWord({ type: "qemu" }), "Virtual machine");
  assert.equal(page.guestTypeWord({ type: "lxc" }), "Container");
});

test("a remembered filter or sort is only used if the list still offers it; anything else is the default (#107)", () => {
  // Its objects come from the script's own context, so compare plain copies.
  const prefs = (saved: unknown) => ({ ...page.guestListPrefs(saved) });
  assert.deepEqual(prefs({ type: "lxc", sort: "node" }), { type: "lxc", sort: "node" });
  assert.deepEqual(prefs({ type: "<img src=x>", sort: 7 }), { type: "all", sort: "name" });
  assert.deepEqual(prefs(null), { type: "all", sort: "name" });
  assert.deepEqual(prefs("lxc"), { type: "all", sort: "name" });
  assert.equal(page.GUEST_TYPES[0]?.[0], "all", "the default shows everything");
  assert.equal(page.GUEST_SORTS[0]?.[0], "name", "the default sort is the order the list always had");
});

test("the page loads the list script before app.js, and the server serves it (#107)", () => {
  const html = read("index.html");
  const at = html.indexOf('<script src="guest-list.js"></script>');
  assert.ok(at > 0, "index.html loads guest-list.js");
  assert.ok(at < html.indexOf('<script src="app.js"></script>'), "before app.js, which uses it");
  const server = readFileSync(path.join(PUBLIC, "..", "src", "server.ts"), "utf8");
  assert.match(server, /"\/guest-list\.js": \["guest-list\.js", "text\/javascript; charset=utf-8"\]/);
});

test("the home screen names containers: VMs and Containers, and Create (#107)", () => {
  const app = read("app.js");
  assert.match(app, /vms: \{ title: "VMs and Containers"/);
  assert.match(app, /create: \{ title: "Create"/);
  assert.doesNotMatch(app, /title: "Virtual Machines"|title: "Create a VM"/);
  assert.match(app, /guestList\(S\.data\.vms,/, "the list uses the tested filter and sort, not its own copy");
});
