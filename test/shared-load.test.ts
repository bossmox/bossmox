import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedLoad } from "../src/shared-load.js";

test("a burst of requests shares one load, a minute later it loads again, and a failure isn't kept (#59)", async () => {
  let clock = 0;
  let loads = 0;
  let fail = false;
  const get = sharedLoad(60_000, async () => {
    loads += 1;
    if (fail) throw new Error("down");
    return loads;
  }, () => clock);
  assert.deepEqual(await Promise.all([get(), get(), get(), get(), get()]), [1, 1, 1, 1, 1]);
  assert.equal(loads, 1, "five at once, one load");
  clock = 61_000;
  fail = true;
  await assert.rejects(get(), /down/);
  fail = false;
  assert.equal(await get(), 3, "the failed load wasn't kept, so the next one tries again");
});
