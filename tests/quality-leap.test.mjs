import test from "node:test";
import assert from "node:assert/strict";

import { buildOverview, topRecurring } from "../plugins/council/scripts/lib/overview.mjs";
import { annotateScopes, classifyScope, deliverableFor } from "../plugins/council/scripts/lib/scope.mjs";
import { parseRefutation } from "../plugins/council/scripts/lib/verify.mjs";

// --- Overview / category calibration (model-agnostic) ---

test("buildOverview computes per-category calibration from resolved outcomes", () => {
  const entries = [
    { category: "security", status: "fixed", timesSeen: 2, consensusSeen: 1 },
    { category: "security", status: "dismissed", timesSeen: 1, consensusSeen: 0 },
    { category: "security", status: "ignored", timesSeen: 1, consensusSeen: 0 },
    { category: "security", status: "open", timesSeen: 3, consensusSeen: 2 },
    { category: "performance", status: "open", timesSeen: 1, consensusSeen: 0 }
  ];
  const ov = buildOverview(entries);
  assert.equal(ov.totalFindings, 5);
  const sec = ov.categories.security;
  // 2 true positives (fixed + ignored), 1 false positive (dismissed) -> 67%.
  assert.equal(sec.calibration, 67);
  assert.equal(sec.resolved, 3);
  assert.equal(sec.open, 1);
  assert.equal(sec.recurring, 2); // two entries with timesSeen>1
  // performance has no resolved outcomes -> calibration null (no false claim).
  assert.equal(ov.categories.performance.calibration, null);
});

test("topRecurring surfaces the most-repeated findings", () => {
  const entries = [
    { title: "a", timesSeen: 5 },
    { title: "b", timesSeen: 1 },
    { title: "c", timesSeen: 3 }
  ];
  const top = topRecurring(entries, 10).map((e) => e.title);
  assert.deepEqual(top, ["a", "c"]); // b (seen once) excluded
});

// --- Scope classification (localized vs cross-cutting) ---

test("classifyScope: precise single-location + no architectural language = localized", () => {
  assert.equal(classifyScope({ file: "a.mjs", line: 12, title: "Missing null check", detail: "add ?? guard" }), "localized");
});

test("classifyScope: architectural language or no location = cross-cutting", () => {
  assert.equal(classifyScope({ file: "a.mjs", line: 12, title: "Inconsistent error handling pattern across modules" }), "cross-cutting");
  assert.equal(classifyScope({ file: null, line: null, title: "No tests" }), "cross-cutting");
});

test("classifyScope: explicit agent scope wins", () => {
  assert.equal(classifyScope({ file: "a.mjs", line: 1, title: "x", scope: "cross-cutting" }), "cross-cutting");
  assert.equal(deliverableFor("localized"), "fix-diff");
  assert.equal(deliverableFor("cross-cutting"), "documented-approach");
});

test("annotateScopes tags every finding with scope + deliverable and rebuilds buckets", () => {
  const merged = {
    all: [
      { severity: "P1", title: "Missing await", file: "a.mjs", line: 5, consensus: true },
      { severity: "P2", title: "Refactor the whole auth layer", file: "b.mjs", line: 9, consensus: false }
    ]
  };
  const out = annotateScopes(merged);
  assert.equal(out.all[0].scope, "localized");
  assert.equal(out.all[0].deliverable, "fix-diff");
  assert.equal(out.all[1].scope, "cross-cutting");
  assert.equal(out.consensus.length, 1);
  assert.equal(out.unique.length, 1);
});

// --- Verification (adversarial refutation parse) ---

test("parseRefutation reads the refuted boolean + reason, rejects malformed", () => {
  assert.deepEqual(parseRefutation('{"id":"x","refuted":true,"reason":"not reachable"}'), {
    refuted: true,
    reason: "not reachable"
  });
  assert.deepEqual(parseRefutation('prose {"refuted": false, "reason": "real"}'), { refuted: false, reason: "real" });
  assert.equal(parseRefutation('{"reason":"no bool"}'), null);
  assert.equal(parseRefutation("garbage"), null);
});
