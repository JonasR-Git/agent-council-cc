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
  assert.equal(parseCompleteness('{"gaps": "not an array"}').complete, false);
});

test("assessCompleteness is complete ONLY when structural + critic + dry all hold", () => {
  const good = { structural: { ok: true, missingGroups: [], incompleteTriples: [] }, critic: { complete: true, gaps: [] }, dryStreak: 2, dryStop: 2 };
  assert.equal(assessCompleteness(good).complete, true);
  // any one failing → not complete
  assert.equal(assessCompleteness({ ...good, structural: { ok: false, missingGroups: ["perf-memory"], incompleteTriples: [] } }).complete, false);
  assert.equal(assessCompleteness({ ...good, critic: { complete: false, gaps: [{ class: "security-authz" }] } }).complete, false);
  assert.equal(assessCompleteness({ ...good, dryStreak: 1 }).complete, false);
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
