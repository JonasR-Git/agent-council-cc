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

test("rejects a vacuous test that captures no observable output (asserts nothing)", async () => {
  const r = await acceptCharTest(harness({ runs: async (n) => Array(n).fill("") }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /vacuous/);
});

test("rejects an environment-dependent target (perturbed clock/locale/seed differs)", async () => {
  const r = await acceptCharTest(harness({ perturbedRun: async () => "DIFFERENT" }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /environment-dependent/);
});

test("a thrown harness dep fails CLOSED (accept:false), never escapes", async () => {
  const r = await acceptCharTest(harness({ passesOnUnmodified: async () => { throw new Error("runner died"); } }));
  assert.equal(r.accept, false);
  assert.match(r.reason, /harness fault/);
});

test("mutationGate: severity-aware threshold, caller-scored, range-checked", async () => {
  // callers are threaded into the score fn (§5: changed lines AND callers)
  let seen;
  await mutationGate({ mutationScore: async (a) => { seen = a; return 0.9; } }, { file: "a.mjs", lines: [1], callers: ["b.mjs"] });
  assert.deepEqual(seen.callers, ["b.mjs"]);
  // P0 gets a higher bar (0.8): 0.75 fails, 0.85 passes
  assert.equal((await mutationGate({ mutationScore: async () => 0.75 }, { severity: "P0" })).pass, false);
  assert.equal((await mutationGate({ mutationScore: async () => 0.85 }, { severity: "P0" })).pass, true);
  assert.equal((await mutationGate({ mutationScore: async () => 0.8 }, { threshold: 0.6 })).pass, true);
  assert.equal((await mutationGate({ mutationScore: async () => 1.5 }, { threshold: 0.6 })).pass, false, "out-of-range score fails closed");
  assert.equal((await mutationGate({}, {})).pass, false);
  assert.equal((await mutationGate({ mutationScore: async () => { throw new Error("boom"); } }, {})).pass, false);
});
