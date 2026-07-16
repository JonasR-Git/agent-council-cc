// Facade detection: formatConsentUseDisclosure turns "did the consented gate ACTUALLY fire?" into a
// run-end fact. Motivated by a real bug (9ce65a7): --structure-auto-apply was consented, wired, reachable
// and green-tested, yet its transform ran 0× across 17 live passes over 907 structural findings because an
// upstream filter removed its inputs. A fail-closed path that is never reached logs nothing, so no test and
// no error could surface it — only a runtime count could. These pin the verdict logic, ESPECIALLY the
// no-crying-wolf cases: a healthy 0 must never warn, or the real signal gets tuned out.

import test from "node:test";
import assert from "node:assert/strict";

import { CONSENT_USE_COUNTER, formatConsentUseDisclosure } from "../plugins/council/scripts/lib/consent.mjs";

const res = (structure, sensitive) => ({ structureAutoApply: structure, sensitiveAutoApply: sensitive });

test("counter keys are the ones audit-fix.mjs actually increments", () => {
  // If these drift from the reporter.counter(...) call sites, the disclosure silently reads undefined and
  // reports a permanent false FACADE — the exact crying-wolf failure this module exists to avoid.
  assert.deepEqual(CONSENT_USE_COUNTER, { structure: "structureAttempts", sensitive: "sensitiveGates" });
});

test("THE BUG: consented + candidates existed + gate ran 0× → loud facade warning", () => {
  const lines = formatConsentUseDisclosure(res(true, false), { counters: {}, candidates: { structure: 907 } });
  assert.equal(lines.length, 1, "only the consented knob is disclosed");
  assert.match(lines[0], /^⚠/);
  assert.match(lines[0], /structure_auto_apply=true but its gate ran 0×/);
  assert.match(lines[0], /907 finding\(s\)/);
  assert.match(lines[0], /BUG, not a refusal/);
});

test("NO CRYING WOLF: consented + zero candidates + 0 runs → correct silence, never a warning", () => {
  const lines = formatConsentUseDisclosure(res(false, true), { counters: {}, candidates: { sensitive: 0 } });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /⚠/, "a healthy 0 must not warn — a warned-at healthy run trains the reader to ignore the real one");
  assert.match(lines[0], /correct silence/);
});

test("a firing gate reports its count and never warns (refusing is the gate's job, not a fault)", () => {
  const lines = formatConsentUseDisclosure(res(true, true), {
    counters: { structureAttempts: 3, sensitiveGates: 12 },
    candidates: { structure: 907, sensitive: 88 }
  });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.startsWith("⚠")));
  assert.match(lines[0], /structure_auto_apply=true — its gate ran 3×/);
  assert.match(lines[1], /sensitive_auto_apply=true — its gate ran 12×/);
});

test("an un-consented knob is never disclosed (its gate SHOULD be silent)", () => {
  assert.deepEqual(formatConsentUseDisclosure(res(false, false), { counters: {}, candidates: { structure: 907 } }), []);
});

test("unknown candidate count → states the fact without warning (fail-soft, no false alarm)", () => {
  const lines = formatConsentUseDisclosure(res(true, false), { counters: {} }); // no candidates key at all
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /⚠/, "unknown is not evidence of a facade");
  assert.match(lines[0], /no candidate count available/);
});

test("garbage counters/candidates degrade to 0 without throwing", () => {
  const lines = formatConsentUseDisclosure(res(true, true), {
    counters: { structureAttempts: NaN, sensitiveGates: -3 },
    candidates: { structure: "x", sensitive: null }
  });
  assert.equal(lines.length, 2);
  // "x"/null are not positive counts → treated as 0 candidates → correct silence, not a warning.
  assert.ok(lines.every((l) => !l.startsWith("⚠")));
});

test("tolerates a missing resolution / options entirely", () => {
  assert.deepEqual(formatConsentUseDisclosure(undefined), []);
  assert.deepEqual(formatConsentUseDisclosure(null, {}), []);
});
