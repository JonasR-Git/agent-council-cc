import assert from "node:assert/strict";
import test from "node:test";

import { gateStatus, summarizeCoverage, tailScore } from "../plugins/council/scripts/lib/audit-coverage.mjs";

test("tailScore floors zero factors and ranks hotter units higher", () => {
  const cold = tailScore({ complexity: 0, churn: 0, blastRadius: 0, smell: 0 });
  const hot = tailScore({ complexity: 1, churn: 1, blastRadius: 1, smell: 1 });
  assert.ok(cold > 0, "e floor keeps a zero factor from zeroing the score");
  assert.equal(hot, 100);
  assert.ok(hot > cold);
  assert.ok(tailScore({ complexity: 1, churn: 1, blastRadius: 0, smell: 0 }) > cold, "one hot signal still lifts the score");
});

test("summarizeCoverage: mapped is NOT reviewed, and mandatory completion needs verify", () => {
  const s = summarizeCoverage([
    { file: "a.mjs", lens: "correctness", state: "mapped", mandatory: true },
    { file: "b.mjs", lens: "security_secrets", state: "verified", mandatory: true },
    { file: "c.mjs", lens: "docs_maintainability", state: "reviewed", mandatory: true, requiresVerification: false },
    { file: "d.mjs", lens: "correctness", state: "uncovered" }
  ]);
  assert.equal(s.byState.mapped, 1);
  assert.equal(s.byState.verified, 1);
  assert.equal(s.mandatory.total, 3);
  assert.equal(s.mandatory.done, 2, "mapped mandatory unit is not done; verified + reviewed-no-verify are");
  assert.equal(s.mandatory.complete, false);
  assert.ok(s.uncovered.some((u) => u.file === "a.mjs"), "mapped-but-unreviewed surfaces as uncovered");
  assert.ok(s.uncovered.some((u) => u.file === "d.mjs"));
});

test("gateStatus: indeterminate over false-pass, fail on new P0/P1", () => {
  const complete = { complete: true };
  assert.equal(gateStatus({ mandatory: complete, newHighSeverity: 0, verificationComplete: true }), "pass");
  assert.equal(gateStatus({ mandatory: complete, newHighSeverity: 2, verificationComplete: true }), "fail");
  assert.equal(gateStatus({ mandatory: { complete: false }, newHighSeverity: 0 }), "indeterminate", "incomplete surface is never a pass");
  assert.equal(gateStatus({ mandatory: complete, newHighSeverity: 0, verificationComplete: false }), "indeterminate");
});
