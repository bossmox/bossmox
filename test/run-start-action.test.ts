import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterActions } from "../src/actions/cluster.js";
import type { Session } from "../src/auth.js";

/** What run-start hands the run engine, with everything else stood in. */
function start(body: Record<string, unknown>) {
  const calls: { kind: string; server: string; confirmed: boolean; only: string }[] = [];
  const jobs = {
    startRun: async (_s: Session, kind: string, server: string, confirmed: boolean, _c: unknown, only = "") => {
      calls.push({ kind, server, confirmed, only });
      return "run:1";
    },
  };
  const action = clusterActions({ jobs } as never)["run-start"];
  assert.ok(action);
  const who = { username: "root@pam", ticket: "t" } as unknown as Session;
  return { calls, done: Promise.resolve().then(() => action("n1", who, body)) };
}

test("Upgrade this node is confirmed with the node's own name, not the cluster run's word (ADR 0044)", async () => {
  const named = start({ kind: "upgrade", only: "n2", confirm: "n2" });
  await named.done;
  assert.deepEqual(named.calls, [{ kind: "upgrade", server: "", confirmed: true, only: "n2" }]);

  const anyCase = start({ kind: "upgrade", only: "Node-2", confirm: "node-2" });
  await anyCase.done;
  assert.equal(anyCase.calls[0]?.confirmed, true, "the name confirms in any case, like other node actions");

  const word = start({ kind: "upgrade", only: "n2", confirm: "confirm" });
  await word.done;
  assert.equal(word.calls[0]?.confirmed, false, "the cluster run's word doesn't confirm one node");

  const cluster = start({ kind: "upgrade", confirm: "confirm" });
  await cluster.done;
  assert.deepEqual(cluster.calls, [{ kind: "upgrade", server: "", confirmed: true, only: "" }], "Upgrade all nodes is unchanged");
});

test("one node only for an upgrade, and only a valid node name", async () => {
  await assert.rejects(start({ kind: "update", only: "n2", confirm: "n2" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "restart", server: "n1", only: "n1", confirm: "n1" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "upgrade", only: "n2; reboot", confirm: "n2; reboot" }).done, /isn't valid/);
  await assert.rejects(start({ kind: "upgrade", only: "../n2", confirm: "../n2" }).done, /isn't valid/);
});
