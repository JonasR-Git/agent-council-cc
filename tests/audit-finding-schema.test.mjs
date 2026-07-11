import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

const good = {
  schemaVersion: 1,
  ruleId: "empty-catch",
  fingerprint: "fp1|src/a.mjs|correctness|empty-catch|a:handle",
  lens: "correctness",
  lifecycle: "confirmed",
  severity: "P1",
  likelihood: 3,
  blastRadius: 4,
  exploitability: 2,
  confidence: 0.8,
  risk: { raw: 56, calibrated: 47 },
  location: { path: "src/a.mjs", startLine: 12, endLine: 18 },
  failureScenario: "On a thrown parse error the catch swallows it, so the caller sees success with empty data.",
  standards: ["CWE-703"],
  scope: "localized",
  consensus: "consensus",
  fixDisposition: "localized"
};

test("a fully-specified finding validates against the audit-finding contract", () => {
  const r = validate(SCHEMAS.auditFinding, good);
  assert.ok(r.valid, r.errors.join("; "));
});

test("an observation (no location, no failureScenario) is rejected — it may not enter the gate/fix queue", () => {
  const obs = { ruleId: "x", lens: "correctness", lifecycle: "candidate", severity: "P2" };
  const r = validate(SCHEMAS.auditFinding, obs);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /location.*required/i.test(e)));
  assert.ok(r.errors.some((e) => /failureScenario.*required/i.test(e)));
});

test("unknown lens / lifecycle / severity enum values are rejected", () => {
  assert.equal(validate(SCHEMAS.auditFinding, { ...good, lens: "made_up_lens" }).valid, false);
  assert.equal(validate(SCHEMAS.auditFinding, { ...good, lifecycle: "totally_fixed" }).valid, false);
  assert.equal(validate(SCHEMAS.auditFinding, { ...good, severity: "P9" }).valid, false);
  assert.equal(validate(SCHEMAS.auditFinding, { ...good, likelihood: 7 }).valid, false, "L/B/E are 1..5");
  assert.equal(validate(SCHEMAS.auditFinding, { ...good, location: { path: "x" } }).valid, false, "startLine required");
});

test("identity + handling fields are required so a gate/fix consumer always has them", () => {
  for (const field of ["fingerprint", "scope", "fixDisposition", "schemaVersion"]) {
    const missing = { ...good };
    delete missing[field];
    assert.equal(validate(SCHEMAS.auditFinding, missing).valid, false, `${field} is required`);
  }
});
