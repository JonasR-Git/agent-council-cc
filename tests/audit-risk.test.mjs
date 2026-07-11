import assert from "node:assert/strict";
import test from "node:test";

import { deriveConfidence, falsePositiveRate, rankRegister, riskScore, wilson } from "../plugins/council/scripts/lib/audit-risk.mjs";

test("deriveConfidence caps candidates and floors verified evidence", () => {
  assert.equal(deriveConfidence("regex-only", 0.9), 0.35, "regex-only capped");
  assert.equal(deriveConfidence("deterministic-unproven", 0.9), 0.55);
  assert.equal(deriveConfidence("one-finder", 0.9), 0.65);
  assert.equal(deriveConfidence("independent-agreement", 0.9), 0.8);
  assert.equal(deriveConfidence("adversarial-verified", 0.5), 0.85, "floored up");
  assert.equal(deriveConfidence("reproduced", 0.1), 0.95);
  assert.equal(deriveConfidence("unknown-state", 0.42), 0.42, "pass-through");
});

test("riskScore computes raw + calibrated and keeps every component", () => {
  const worst = riskScore({ severity: "P0", likelihood: 5, blastRadius: 5, exploitability: 5, confidence: 1 });
  assert.equal(worst.raw, 100);
  assert.equal(worst.calibrated, 100, "confidence 1 -> factor 1");
  const lowConf = riskScore({ severity: "P0", likelihood: 5, blastRadius: 5, exploitability: 5, confidence: 0 });
  assert.equal(lowConf.raw, 100);
  assert.equal(lowConf.calibrated, 25, "confidence 0 -> factor 0.25");
  assert.deepEqual(worst.components, { S: 10, L: 5, B: 5, E: 5, C: 1 });
  // out-of-range inputs are clamped, not NaN
  assert.ok(Number.isFinite(riskScore({ severity: "bogus", likelihood: 99, blastRadius: -3, confidence: 2 }).calibrated));
  // raw is kept at full precision (auditable), only calibrated is rounded
  const tiny = riskScore({ severity: "nit", likelihood: 1, blastRadius: 1, exploitability: 1, confidence: 1 });
  assert.ok(Math.abs(tiny.raw - 0.08) < 1e-9, "raw is not rounded away to 0");
  assert.equal(tiny.calibrated, 0);
});

test("wilson interval + falsePositiveRate handle sparse data honestly", () => {
  assert.equal(wilson(0, 0), null, "no sample -> no interval");
  assert.equal(wilson(2, 1), null, "successes > n -> null, not NaN bounds");
  assert.equal(wilson(1.5, 4), null, "non-integer successes rejected");
  assert.equal(falsePositiveRate(0, 0), null, "nothing resolved -> null, not 0% precision");
  const fp = falsePositiveRate(8, 2); // 2 false positives out of 10 resolved
  assert.equal(fp.n, 10);
  assert.ok(Math.abs(fp.rate - 0.2) < 1e-9);
  assert.ok(fp.low < 0.2 && fp.high > 0.2 && fp.low >= 0 && fp.high <= 1, "interval brackets the rate");
});

test("rankRegister puts active findings first, then calibrated risk, then severity", () => {
  const reg = [
    { lifecycle: "refuted", severity: "P0", risk: { calibrated: 100 } },
    { lifecycle: "confirmed", severity: "P2", risk: { calibrated: 30 } },
    { lifecycle: "confirmed", severity: "P0", risk: { calibrated: 80 } }
  ];
  const ranked = rankRegister(reg);
  assert.equal(ranked[0].severity, "P0", "highest-risk confirmed first");
  assert.equal(ranked[1].severity, "P2");
  assert.equal(ranked[2].lifecycle, "refuted", "resolved sinks to the bottom despite high risk");
});
