import assert from "node:assert/strict";
import test from "node:test";

import { assembleReport } from "../plugins/council/scripts/lib/audit-assemble.mjs";
import { toCanonicalFinding } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

const canon = (over) => toCanonicalFinding({ severity: "P1", category: "security", title: "t", detail: "d", file: "a.mjs", line: 5, agents: ["codex", "claude"], consensus: true, ...over }, { unit: "a.mjs" });

test("assembleReport produces a schema-valid report envelope", () => {
  const units = [
    { file: "a.mjs", lens: "security_secrets", state: "verified", mandatory: true },
    { file: "b.mjs", lens: "correctness", state: "reviewed", mandatory: false }
  ];
  const rep = assembleReport([canon()], units, { generatedAt: "2026-07-11T00:00:00Z", confirmedCount: 5, refutedFp: 1 });
  const v = validate(SCHEMAS.auditReport, rep);
  assert.ok(v.valid, v.errors.join("; "));
  assert.equal(rep.coverage.total, 2);
  assert.ok(rep.falsePositiveRate && rep.falsePositiveRate.n === 6);
});

test("gate fails on a new confirmed P0/P1 once the mandatory surface is complete", () => {
  const units = [{ file: "a.mjs", lens: "security_secrets", state: "verified", mandatory: true }];
  const rep = assembleReport([canon({ severity: "P0" })], units, {});
  assert.equal(rep.gate.status, "fail", "new confirmed P0 fails the gate");
  assert.equal(rep.gate.newHighSeverity, 1);
});

test("gate is indeterminate when the mandatory surface is incomplete, regardless of findings", () => {
  const units = [{ file: "a.mjs", lens: "security_secrets", state: "mapped", mandatory: true }];
  const rep = assembleReport([canon({ severity: "P0" })], units, {});
  assert.equal(rep.gate.status, "indeterminate", "incomplete surface can never be a fail/pass verdict");
});

test("a baselined high finding does not fail the gate; propose-only items split out", () => {
  const units = [{ file: "a.mjs", lens: "security_secrets", state: "verified", mandatory: true }];
  const baselined = canon({ severity: "P0" });
  baselined.baseline = "baselined";
  const ssot = toCanonicalFinding({ severity: "P1", category: "ssot", title: "dup", file: "a.mjs", line: 1, agents: ["codex"] }, { unit: "a.mjs" });
  const rep = assembleReport([baselined, ssot], units, {});
  assert.equal(rep.gate.status, "pass", "an accepted baseline P0 does not fail the gate");
  assert.ok(rep.proposals.some((p) => p.lens === "architecture_ssot"), "SSOT is surfaced as a proposal");
});
