import assert from "node:assert/strict";
import test from "node:test";

import { applyGovernance, isWaived } from "../plugins/council/scripts/lib/audit-baseline.mjs";

const gov = {
  baselined: new Set(["fp1|a.mjs|correctness|r|a:x"]),
  waivers: new Map([
    ["fp1|b.mjs|security_secrets|r|a:y", { fingerprint: "fp1|b.mjs|security_secrets|r|a:y", reason: "accepted", expires: "2999-01-01T00:00:00Z" }],
    ["fp1|c.mjs|correctness|r|a:z", { fingerprint: "fp1|c.mjs|correctness|r|a:z", reason: "old", expires: "2000-01-01T00:00:00Z" }]
  ])
};
const NOW = "2026-07-11T00:00:00Z";

test("isWaived: unexpired non-P0 only; P0 never waivable; expired re-surfaces", () => {
  const w = { fingerprint: "x", expires: "2999-01-01T00:00:00Z" };
  assert.equal(isWaived({ severity: "P2" }, w, NOW), true);
  assert.equal(isWaived({ severity: "P0" }, w, NOW), false, "P0 is non-waivable");
  assert.equal(isWaived({ severity: "P2" }, { expires: "2000-01-01T00:00:00Z" }, NOW), false, "expired -> not waived");
  assert.equal(isWaived({ severity: "P2" }, null, NOW), false);
});

test("applyGovernance tags baseline state; waiver beats baseline; expired/P0 not suppressed", () => {
  const findings = [
    { fingerprint: "fp1|a.mjs|correctness|r|a:x", severity: "P2" }, // baselined
    { fingerprint: "fp1|b.mjs|security_secrets|r|a:y", severity: "P1" }, // waived (unexpired)
    { fingerprint: "fp1|c.mjs|correctness|r|a:z", severity: "P2" }, // waiver expired -> new
    { fingerprint: "fp1|d.mjs|security_secrets|r|a:q", severity: "P0" } // unknown -> new
  ];
  const out = applyGovernance(findings, gov, NOW);
  assert.equal(out[0].baseline, "baselined");
  assert.equal(out[1].baseline, "waived");
  assert.equal(out[2].baseline, "new", "expired waiver re-surfaces as new");
  assert.equal(out[3].baseline, "new");
});

test("a P0 with a matching waiver is NOT suppressed", () => {
  const g = { baselined: new Set(), waivers: new Map([["fp", { fingerprint: "fp", expires: "2999-01-01T00:00:00Z" }]]) };
  const out = applyGovernance([{ fingerprint: "fp", severity: "P0" }], g, NOW);
  assert.equal(out[0].baseline, "new", "P0 is never waived");
});
