import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, mergeOptionsWithPolicy } from "../plugins/council/scripts/lib/policy.mjs";

test("new policy defaults: severities, r2 effort, debate, writer", () => {
  const merged = mergeOptionsWithPolicy({}, { ...DEFAULT_POLICY, _source: null });
  assert.deepEqual(merged.peerCritiqueSeverities, ["P0", "P1"]);
  assert.equal(merged.r2Effort, "medium");
  assert.equal(merged.debateRounds, 0);
  assert.equal(merged.solveWriter, "claude");
});

test("peer severities accept comma-separated flag strings and drop junk", () => {
  const merged = mergeOptionsWithPolicy(
    { peerCritiqueSeverities: "p2, NIT, bogus" },
    { ...DEFAULT_POLICY, _source: null }
  );
  assert.deepEqual(merged.peerCritiqueSeverities, ["P2", "nit"]);
});

test("all-junk severity list falls back to P0,P1", () => {
  const merged = mergeOptionsWithPolicy(
    { peerCritiqueSeverities: "bogus,unknown" },
    { ...DEFAULT_POLICY, _source: null }
  );
  assert.deepEqual(merged.peerCritiqueSeverities, ["P0", "P1"]);
});

test("debate rounds are clamped to 0..2", () => {
  const base = { ...DEFAULT_POLICY, _source: null };
  assert.equal(mergeOptionsWithPolicy({ debateRounds: 5 }, base).debateRounds, 2);
  assert.equal(mergeOptionsWithPolicy({ debateRounds: -1 }, base).debateRounds, 0);
  assert.equal(mergeOptionsWithPolicy({ debateRounds: 1 }, base).debateRounds, 1);
  assert.equal(mergeOptionsWithPolicy({}, { ...base, debate_rounds: 2 }).debateRounds, 2);
});
