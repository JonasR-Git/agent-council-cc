import assert from "node:assert/strict";
import test from "node:test";

import { makeCoverageMatrix } from "../plugins/council/scripts/lib/audit-cell-scheduler.mjs";
import {
  assessCompleteness,
  buildCompletenessPrompt,
  parseCompleteness,
  structuralGaps
} from "../plugins/council/scripts/lib/completeness-critic.mjs";

const MODELS = ["codex", "grok", "claude"];

test("structuralGaps reports triples no model completed", () => {
  const m = makeCoverageMatrix(MODELS);
  const triples = [{ groupId: "g1", file: "a.mjs", chunk: 0 }, { groupId: "g2", file: "a.mjs", chunk: 0 }];
  for (const model of MODELS) m.markDone({ model, ...triples[0] }); // g1 fully covered
  m.markDone({ model: "codex", ...triples[1] }); // g2 only 1/3
  const gaps = structuralGaps({ matrix: m, triples });
  assert.equal(gaps.ok, false);
  assert.equal(gaps.incompleteTriples.length, 1);
  assert.equal(gaps.incompleteTriples[0].groupId, "g2");
});

test("structuralGaps reports un-scheduled groups and files (a whole class never hunted)", () => {
  const gaps = structuralGaps({
    expectedGroups: [{ id: "security-injection" }, { id: "concurrency-races" }, { id: "perf-memory" }],
    expectedFiles: ["a.mjs", "b.mjs", "c.mjs"],
    scheduledGroupIds: ["security-injection", "concurrency-races"],
    scheduledFiles: ["a.mjs", "b.mjs"]
  });
  assert.deepEqual(gaps.missingGroups, ["perf-memory"]);
  assert.deepEqual(gaps.missingFiles, ["c.mjs"]);
  assert.equal(gaps.ok, false);
});

test("structuralGaps fails closed when an EXPECTED scope is given without the SCHEDULED set (council codex P1)", () => {
  // caller stated the intended groups but forgot to pass what was actually scheduled → UNKNOWN, not ok
  const g = structuralGaps({ expectedGroups: [{ id: "security-injection" }] });
  assert.equal(g.checkIncomplete, true);
  assert.equal(g.ok, false, "can't confirm coverage of un-scheduled-checked groups → not ok");
  const f = structuralGaps({ expectedFiles: ["a.mjs"] });
  assert.equal(f.ok, false);
});

test("structuralGaps ok when everything scheduled + complete", () => {
  const m = makeCoverageMatrix(["codex"]);
  const t = { groupId: "g", file: "a.mjs", chunk: 0 };
  m.markDone({ model: "codex", ...t });
  const gaps = structuralGaps({ matrix: m, triples: [t], expectedGroups: [{ id: "g" }], expectedFiles: ["a.mjs"], scheduledGroupIds: ["g"], scheduledFiles: ["a.mjs"] });
  assert.equal(gaps.ok, true);
});

test("buildCompletenessPrompt nonce-fences the untrusted findings + coverage and asks what's MISSING", () => {
  const p = buildCompletenessPrompt([{ severity: "P1", lens: "correctness", title: "SENTINEL_FINDING", file: "a.mjs" }], "8 files, 30 groups, security had 0 findings");
  assert.match(p, /COMPLETENESS CRITIC/);
  assert.match(p, /what is likely MISSING/);
  assert.match(p, /BEGIN FINDINGS [0-9A-F]{6,}/);
  assert.match(p, /BEGIN COVERAGE [0-9A-F]{6,}/);
  assert.ok(p.includes("SENTINEL_FINDING"), "the findings summary is included");
  assert.ok(p.includes("security had 0 findings"), "the coverage summary is included");
});

test("parseCompleteness reads {complete,gaps}; a gap overrides complete:true", () => {
  assert.deepEqual(parseCompleteness('{"complete": true, "gaps": []}'), { complete: true, gaps: [], parseOk: true });
  const withGap = parseCompleteness('{"complete": true, "gaps": [{"class":"concurrency","where":"pool.mjs","why":"no race findings across 40 async fns"}]}');
  assert.equal(withGap.complete, false, "an explicit gap forces incomplete even if complete:true was claimed");
  assert.equal(withGap.gaps[0].class, "concurrency");
});

test("parseCompleteness fails CLOSED (incomplete) on a malformed reply so the loop keeps going", () => {
  assert.deepEqual(parseCompleteness("not json"), { complete: false, gaps: [], parseOk: false });
  // council grok/codex P1: a non-array gaps, OR an array of non-object items (bare strings — a very
  // plausible model output), is malformed → must NOT honor complete:true (would silently drop gaps)
  for (const bad of ['{"complete": true, "gaps": "nope"}', '{"complete": true, "gaps": null}', '{"complete": true}', '{"complete": true, "gaps": {}}', '{"complete": true, "gaps": ["under-tested area"]}']) {
    const r = parseCompleteness(bad);
    assert.equal(r.parseOk, false, `malformed gaps: ${bad}`);
    assert.equal(r.complete, false, `a garbled gaps field cannot hide gaps: ${bad}`);
  }
  // a mixed reply still surfaces the well-formed object gaps for scheduling, but fails closed
  const mixed = parseCompleteness('{"complete": true, "gaps": [{"class":"concurrency"}, "loose string"]}');
  assert.equal(mixed.parseOk, false);
  assert.equal(mixed.complete, false);
  assert.equal(mixed.gaps[0].class, "concurrency", "valid gaps are still surfaced as next targets");
});

test("assessCompleteness is complete ONLY when structural + critic + dry all hold", () => {
  const good = { structural: { ok: true, missingGroups: [], incompleteTriples: [] }, critic: { complete: true, gaps: [] }, dryStreak: 2, dryStop: 2 };
  assert.equal(assessCompleteness(good).complete, true);
  // any one failing → not complete
  assert.equal(assessCompleteness({ ...good, structural: { ok: false, missingGroups: ["perf-memory"], incompleteTriples: [] } }).complete, false);
  assert.equal(assessCompleteness({ ...good, critic: { complete: false, gaps: [{ class: "security-authz" }] } }).complete, false);
  assert.equal(assessCompleteness({ ...good, dryStreak: 1 }).complete, false);
});

test("assessCompleteness is FAIL-CLOSED when structural or critic is missing (council grok P1)", () => {
  // a caller that never ran the critic (or dropped structural) must NOT get a false complete
  assert.equal(assessCompleteness({ dryStreak: 5, dryStop: 2 }).complete, false, "no structural + no critic → not complete");
  assert.equal(assessCompleteness({ structural: { ok: true }, dryStreak: 5, dryStop: 2 }).complete, false, "critic missing → not complete");
  assert.equal(assessCompleteness({ critic: { complete: true }, dryStreak: 5, dryStop: 2 }).complete, false, "structural missing → not complete");
});

test("assessCompleteness separates coverageComplete (no dry) from complete (council grok P1: avoids B5 dry deadlock)", () => {
  // structural + critic thorough but the streak hasn't held yet: coverageComplete is TRUE (feed to
  // coverage.complete so the dry streak CAN rise), while the full stop verdict is still false.
  const r = assessCompleteness({ structural: { ok: true }, critic: { complete: true }, dryStreak: 0, dryStop: 2 });
  assert.equal(r.coverageComplete, true, "coverage.complete signal excludes the dry gate → no deadlock");
  assert.equal(r.complete, false, "the full stop verdict still needs the dry streak");
});

test("assessCompleteness nextTargets includes missing FILES, not just groups (council grok P2)", () => {
  const out = assessCompleteness({ structural: { ok: false, missingGroups: ["g"], missingFiles: ["untouched.mjs"], incompleteTriples: [] }, critic: { complete: false, gaps: [] }, dryStreak: 0, dryStop: 2 });
  assert.ok(out.nextTargets.includes("untouched.mjs"), "a never-scheduled file is actionable next scope");
  assert.ok(out.nextTargets.includes("g"));
});

test("buildCompletenessPrompt discloses a >cap truncation instead of silently dropping findings", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ severity: "P2", title: `f${i}`, file: "a.mjs" }));
  const p = buildCompletenessPrompt(many, "cov");
  assert.match(p, /showing first 200 of 250 findings/);
});

test("assessCompleteness surfaces concrete nextTargets from gaps + missing groups (loop can act, not spin)", () => {
  const out = assessCompleteness({
    structural: { ok: false, missingGroups: ["perf-memory"], incompleteTriples: [{ groupId: "g2", file: "a.mjs", chunk: 1 }] },
    critic: { complete: false, gaps: [{ class: "security-authz", where: "auth.mjs" }] },
    dryStreak: 0,
    dryStop: 2
  });
  assert.equal(out.complete, false);
  assert.ok(out.nextTargets.includes("perf-memory"));
  assert.ok(out.nextTargets.includes("security-authz"));
  assert.ok(out.nextTargets.some((t) => t.includes("g2")));
});
