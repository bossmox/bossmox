import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readJsonBody } from "../src/body.js";

// autoDestroy off: a real request isn't destroyed just because its body was read, and only the timer may cut it.
const request = () => new PassThrough({ autoDestroy: false }) as unknown as IncomingMessage & PassThrough;

test("a body that never finishes arriving is dropped, and one that arrives in time keeps its connection (#59)", async () => {
  const stalled = request();
  stalled.write('{"a":');
  await assert.rejects(readJsonBody(stalled, { maxBytes: 1024, waitMs: 50 }), (e: Error & { status?: number }) => e.status === 408);
  assert.equal(stalled.destroyed, true);

  const fine = request();
  let cut = 0;
  const destroy = fine.destroy.bind(fine);
  fine.destroy = (err?: Error) => {
    cut += 1;
    return destroy(err);
  };
  const read = readJsonBody(fine, { maxBytes: 1024, waitMs: 50 });
  fine.end('{"a":1}');
  assert.deepEqual(await read, { a: 1 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(cut, 0, "the timer was cleared: a long action after it keeps its connection");
});

test("a body over the limit is refused (#59)", async () => {
  const big = request();
  const read = readJsonBody(big, { maxBytes: 8, waitMs: 1000 });
  big.write("0123456789");
  await assert.rejects(read, (e: Error & { status?: number }) => e.status === 413);
});
