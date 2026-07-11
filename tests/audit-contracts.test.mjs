import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

test("audit-policy validates a good config and rejects unknown enums", () => {
  const ok = {
    schemaVersion: 1,
    lenses: ["security_secrets", "correctness"],
    criticalGlobs: ["payments/**"],
    highFanIn: 8,
    budget: 40,
    maxPasses: 6,
    gate: { failOn: ["P0", "P1"], waivableSeverities: ["P2", "nit"] },
    tools: [{ id: "npm-audit", argv: ["npm", "audit", "--json"], timeoutMs: 60000, network: false, required: false }],
    standardsProfiles: ["OWASP", "CWE"]
  };
  assert.ok(validate(SCHEMAS.auditPolicy, ok).valid, validate(SCHEMAS.auditPolicy, ok).errors.join("; "));
  assert.equal(validate(SCHEMAS.auditPolicy, { ...ok, lenses: ["not_a_lens"] }).valid, false);
  assert.equal(validate(SCHEMAS.auditPolicy, { ...ok, gate: { failOn: ["P9"] } }).valid, false);
  assert.equal(validate(SCHEMAS.auditPolicy, { ...ok, tools: [{ id: "x" }] }).valid, false, "a tool needs argv");
  assert.equal(validate(SCHEMAS.auditPolicy, {}).valid, false, "schemaVersion required");
});

test("audit-report validates the envelope and constrains the gate status", () => {
  const rep = {
    schemaVersion: 1,
    generatedAt: "2026-07-11T00:00:00Z",
    gate: { status: "indeterminate", reason: "mandatory surface incomplete", newHighSeverity: 0 },
    register: [{ ruleId: "x", lens: "correctness", severity: "P1" }],
    coverage: { total: 10, byState: { verified: 3 }, mandatory: { total: 5, done: 3, complete: false }, uncovered: [{ file: "a.mjs" }] },
    falsePositiveRate: null,
    provenance: { models: { codex: "gpt-5.6" } }
  };
  assert.ok(validate(SCHEMAS.auditReport, rep).valid, validate(SCHEMAS.auditReport, rep).errors.join("; "));
  assert.equal(validate(SCHEMAS.auditReport, { ...rep, gate: { status: "green" } }).valid, false, "gate status is pass|fail|indeterminate");
  assert.equal(validate(SCHEMAS.auditReport, { schemaVersion: 1 }).valid, false, "gate/register/coverage required");
  // the review's holes: empty register items and mandatory-less coverage must NOT validate
  assert.equal(validate(SCHEMAS.auditReport, { ...rep, register: [{}] }).valid, false, "a register item needs ruleId/lens/severity");
  assert.equal(validate(SCHEMAS.auditReport, { ...rep, coverage: {} }).valid, false, "coverage needs total + mandatory{total,done,complete}");
});
