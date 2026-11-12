import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecommended, optionsForm, props, type RecommendedInput } from "../src/recommended.js";

/** A three-node cluster laid out like the production one on 2026-11-10: moves on the heartbeat's only network. */
const shared = { known: true, shared: true, moveNet: "10.0.0.0/24", others: ["10.0.100.0/24"], batch: 1, current: null };
const base = (): RecommendedInput => ({ nodes: 3, net: shared, moveLimit: null, haPolicy: "conditional", haGuests: 8, noBoot: [], canChange: true });
const by = (list: ReturnType<typeof buildRecommended>, id: string) => list.find((s) => s.id === id)!;

test("moves on the heartbeat's only network: the switch is off, recommended on, and offers the other network", () => {
  const list = buildRecommended(base());
  const move = by(list, "move-network");
  assert.equal(move.on, false);
  assert.equal(move.recommend, true);
  assert.equal(move.can, true);
  assert.deepEqual(move.choices, [{ value: "10.0.100.0/24", label: "10.0.100.0/24" }]);
  assert.match(move.detail, /one VM at a time/);
  const limit = by(list, "move-limit");
  assert.equal(limit.recommend, true, "a speed limit helps while moves share the heartbeat's network");
  assert.equal(limit.choice, "50");
  assert.equal(by(list, "ha-shutdown").recommend, true, "HA guests exist");
  assert.match(by(list, "ha-shutdown").detail, /8 guests are managed by HA/);
  assert.match(by(buildRecommended({ ...base(), haGuests: 1 }), "ha-shutdown").detail, /One guest is managed by HA\..*stops it and leaves it waiting/);
});

test("no second network: the move switch can't be flipped and says what's missing", () => {
  const move = by(buildRecommended({ ...base(), net: { ...shared, others: [] } }), "move-network");
  assert.equal(move.can, false);
  assert.match(move.why!, /second network/);
});

test("moves on their own network: on, can be turned off, and a speed limit isn't recommended", () => {
  const own = { known: true, shared: false, moveNet: "10.0.100.0/24", others: ["10.0.0.0/24"], batch: 3, current: "10.0.100.0/24", heartbeat: ["10.0.0.0/24"] };
  const list = buildRecommended({ ...base(), net: own, moveLimit: 51200, haPolicy: "migrate" });
  const move = by(list, "move-network");
  assert.equal(move.on, true);
  assert.equal(move.can, true);
  assert.equal(move.choice, "10.0.100.0/24");
  assert.deepEqual(move.choices!.map((c) => c.value), ["10.0.100.0/24"], "the heartbeat's network is never offered for moves");
  assert.throws(() => optionsForm("move-network", true, "10.0.0.0/24", {}, own), /Pick one of the networks/);
  assert.match(by(list, "ha-shutdown").detail, /moves those guests to another node first and brings them back/);
  assert.equal(by(list, "move-limit").on, true);
  assert.equal(by(list, "move-limit").recommend, false);
  assert.equal(by(list, "ha-shutdown").on, true);
});

test("an account without Sys.Modify sees every cluster switch locked, with the reason", () => {
  const list = buildRecommended({ ...base(), canChange: false });
  for (const id of ["move-network", "move-limit", "ha-shutdown"]) {
    assert.equal(by(list, id).can, false, id);
    assert.match(by(list, id).why!, /Sys\.Modify/);
  }
});

test("a single node gets only the boot switch, which turns on only", () => {
  const list = buildRecommended({ ...base(), nodes: 1, noBoot: [{ id: 100, name: "HomeAssistant" }] });
  assert.deepEqual(list.map((s) => s.id), ["boot"]);
  assert.equal(list[0]!.on, false);
  assert.equal(list[0]!.can, true);
  assert.deepEqual(list[0]!.guests, [100]);
  assert.match(list[0]!.detail, /HomeAssistant won't start by itself/);
  const on = buildRecommended({ ...base(), nodes: 1 })[0]!;
  assert.equal(on.on, true);
  assert.equal(on.can, false, "turning it off is done per guest");
});

test("Proxmox's property strings are read whether they come as text or split up", () => {
  assert.deepEqual(props("clone=100,migration=51200"), { clone: "100", migration: "51200" });
  assert.deepEqual(props({ shutdown_policy: "migrate" }), { shutdown_policy: "migrate" });
  assert.deepEqual(props(undefined), {});
});

test("each switch changes only its own part of Proxmox's cluster options", () => {
  // The move network keeps the move type, and clearing it goes back to Proxmox's default.
  assert.deepEqual(optionsForm("move-network", true, "10.0.100.0/24", { migration: { type: "insecure" } }, shared), { migration: "type=insecure,network=10.0.100.0/24" });
  assert.deepEqual(optionsForm("move-network", true, "10.0.100.0/24", {}, shared), { migration: "type=secure,network=10.0.100.0/24" });
  assert.throws(() => optionsForm("move-network", true, "192.168.9.0/24", {}, shared), /Pick one of the networks/);
  assert.deepEqual(optionsForm("move-network", false, "", { migration: { type: "secure", network: "10.0.100.0/24" } }, shared), { delete: "migration" });
  assert.deepEqual(optionsForm("move-network", false, "", { migration: "type=insecure,network=10.0.100.0/24" }, shared), { migration: "type=insecure" });
  // The speed limit keeps other limits (restore, clone) and is given to Proxmox in KiB/s.
  assert.deepEqual(optionsForm("move-limit", true, "50", { bwlimit: { restore: "20000" } }, shared), { bwlimit: "restore=20000,migration=51200" });
  assert.deepEqual(optionsForm("move-limit", false, "", { bwlimit: { restore: "20000", migration: "51200" } }, shared), { bwlimit: "restore=20000" });
  assert.deepEqual(optionsForm("move-limit", false, "", { bwlimit: { migration: "51200" } }, shared), { delete: "bwlimit" });
  assert.throws(() => optionsForm("move-limit", true, "fast", {}, shared), /Pick one of the speeds/);
  assert.deepEqual(optionsForm("ha-shutdown", true, "", {}, shared), { ha: "shutdown_policy=migrate" });
  assert.deepEqual(optionsForm("ha-shutdown", false, "", { ha: { shutdown_policy: "migrate" } }, shared), { delete: "ha" });
});
