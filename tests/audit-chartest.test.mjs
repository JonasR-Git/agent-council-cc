import assert from "node:assert/strict";
import test from "node:test";

import { acceptCharTest, mutationGate } from "../plugins/council/scripts/lib/audit-chartest.mjs";

const harness = (over = {}) => ({
  passesOnUnmodified: async () => true,
  runs: async (n) => Array(n).fill("OUT"),
  executesTarget: async () => true,
  ...over
});

test("acceptCharTest accepts a test that pins deterministic observed behaviour of the target", async () => {
  const r = await acceptCharTest(harness());
  assert.equal(r.accept, true);
});

test("rejects a test that does not pass on the unmodified code (a guess, not a pin)", async () => {
  const r = await acceptCharTest(harness({ passesOnUnmodified: async () => false }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /unmodified/);
});

test("rejects a non-deterministic target (captured output differs across runs)", async () => {
  let i = 0;
  const r = await acceptCharTest(harness({ runs: async (n) => Array.from({ length: n }, () => `run${i++}`) }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /non-deterministic/);
});

test("rejects a test that does not execute the target symbol", async () => {
  const r = await acceptCharTest(harness({ executesTarget: async () => false }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /execute the target/);
});

test("rejects an incomplete harness (fail-closed)", async () => {
  const r = await acceptCharTest({ passesOnUnmodified: async () => true });
  assert.equal(r.accept, false);
  assert.match(r.reason, /harness incomplete/);
});

test("mutationGate passes above threshold, fails below, fails-closed when unavailable", async () => {
  assert.equal((await mutationGate({ mutationScore: async () => 0.8 }, { threshold: 0.6 })).pass, true);
  assert.equal((await mutationGate({ mutationScore: async () => 0.4 }, { threshold: 0.6 })).pass, false);
  assert.equal((await mutationGate({}, {})).pass, false);
  assert.equal((await mutationGate({ mutationScore: async () => { throw new Error("boom"); } }, {})).pass, false);
});
