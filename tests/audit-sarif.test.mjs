import assert from "node:assert/strict";
import test from "node:test";

import { toSarif } from "../plugins/council/scripts/lib/audit-sarif.mjs";

const finding = (over = {}) => ({
  ruleId: "sql-injection",
  lens: "security_secrets",
  severity: "P1",
  failureScenario: "user input concatenated into SQL",
  location: { path: "src/db.mjs", startLine: 42 },
  fingerprint: "fp1|src/db.mjs|security_secrets|sql-injection|a:runQuery",
  risk: { calibrated: 80 },
  confidence: 0.85,
  scope: "localized",
  standards: ["OWASP-A03"],
  ...over
});

test("toSarif emits a valid 2.1.0 log with rules, results and locations", () => {
  const log = toSarif([finding()], { toolVersion: "2.1.0" });
  assert.equal(log.version, "2.1.0");
  assert.match(log.$schema, /sarif-2\.1\.0/);
  const run = log.runs[0];
  assert.equal(run.tool.driver.name, "council-audit");
  assert.equal(run.tool.driver.rules.length, 1);
  const res = run.results[0];
  assert.equal(res.ruleId, "sql-injection");
  assert.equal(res.level, "error", "P1 -> error");
  assert.equal(res.locations[0].physicalLocation.artifactLocation.uri, "src/db.mjs");
  assert.equal(res.locations[0].physicalLocation.region.startLine, 42);
  assert.equal(res.partialFingerprints.auditFingerprint, finding().fingerprint);
  assert.equal(res.properties.risk, 80);
});

test("severity maps to SARIF levels", () => {
  const levels = ["P0", "P1", "P2", "nit"].map((s) => toSarif([finding({ severity: s })]).runs[0].results[0].level);
  assert.deepEqual(levels, ["error", "error", "warning", "note"]);
});

test("rules are deduped and waived findings carry a suppression", () => {
  const log = toSarif([finding(), finding({ location: { path: "src/db.mjs", startLine: 99 } }), finding({ baseline: "waived" })]);
  assert.equal(log.runs[0].tool.driver.rules.length, 1, "one rule for repeated ruleId");
  assert.equal(log.runs[0].results.length, 3);
  const waived = log.runs[0].results[2];
  assert.ok(Array.isArray(waived.suppressions) && waived.suppressions[0].status === "accepted", "waived -> accepted suppression, not dropped");
  assert.equal(log.runs[0].results[0].suppressions, undefined, "an active finding is not suppressed");
});
