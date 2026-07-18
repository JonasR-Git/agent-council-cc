// The shared flake-attribution verdict is SECURITY-critical: it decides whether a RED suite after a change
// is a pre-existing flake (KEEP the change) or a real regression (REVERT). Both write paths depend on it —
// the single-file fixer and the M9 structure transform — so its decision table is pinned exhaustively here.
// The invariant that matters: every uncertainty resolves to REVERT (fail-safe); only a strictly-not-worse
// count over an already-red baseline is kept.

import test from "node:test";
import assert from "node:assert/strict";

import { attributeRedSuite } from "../plugins/council/scripts/lib/flake-attribution.mjs";

test("KEEP only when baseline is ALSO red and the change adds no new failing file (count not increased)", () => {
  const equal = attributeRedSuite({ restored: true, baseGreen: false, postFails: 2, baseFails: 2 });
  assert.deepEqual([equal.ok, equal.attributedFlake], [true, true]);
  const fewer = attributeRedSuite({ restored: true, baseGreen: false, postFails: 1, baseFails: 2 });
  assert.deepEqual([fewer.ok, fewer.attributedFlake], [true, true], "the change even FIXED a flaky file");
});

test("REVERT when the change INCREASES the failing-file count (a real regression)", () => {
  const worse = attributeRedSuite({ restored: true, baseGreen: false, postFails: 3, baseFails: 2 });
  assert.deepEqual([worse.ok, worse.attributedFlake], [false, false]);
  assert.match(worse.reason, /regression/);
});

test("REVERT when the baseline is GREEN — the change itself caused the red", () => {
  const v = attributeRedSuite({ restored: true, baseGreen: true, postFails: 1, baseFails: 0 });
  assert.deepEqual([v.ok, v.attributedFlake], [false, false]);
  assert.match(v.reason, /GREEN/);
});

test("FAIL-SAFE: an unrestored tree never keeps the change (revert regardless of counts)", () => {
  const v = attributeRedSuite({ restored: false, baseGreen: false, postFails: 1, baseFails: 9 });
  assert.deepEqual([v.ok, v.attributedFlake], [false, false]);
  assert.match(v.reason, /restore/);
});

test("FAIL-SAFE: unparseable counts (null) never attribute a flake", () => {
  assert.equal(attributeRedSuite({ restored: true, baseGreen: false, postFails: null, baseFails: 2 }).ok, false);
  assert.equal(attributeRedSuite({ restored: true, baseGreen: false, postFails: 2, baseFails: null }).ok, false);
  assert.equal(attributeRedSuite({ restored: true, baseGreen: false, postFails: null, baseFails: null }).ok, false);
});

test("a kept flake is explicitly NOT verified-green (the reason says so, for an honest verified:false record)", () => {
  const v = attributeRedSuite({ restored: true, baseGreen: false, postFails: 0, baseFails: 3 });
  assert.equal(v.ok, true);
  assert.match(v.reason, /NOT verified-green|pre-existing flake/);
});
