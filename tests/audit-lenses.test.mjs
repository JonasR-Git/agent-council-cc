import assert from "node:assert/strict";
import test from "node:test";

import { LENSES, LENS_REGISTRY_VERSION, cappedSeverity, getLens, isProposeOnly, lensIds, requiresConsensus } from "../plugins/council/scripts/lib/audit-lenses.mjs";

test("the registry ships all thirteen lenses, each fully specified", () => {
  const ids = lensIds();
  assert.equal(ids.length, 13);
  assert.ok(ids.includes("logical_sense"), "Tier-0 logical_sense lens is registered");
  for (const id of ids) {
    const l = LENSES[id];
    assert.ok(["P0", "P1", "P2", "nit"].includes(l.ceiling), `${id} has a valid ceiling`);
    assert.equal(typeof l.consensus, "boolean");
    assert.ok(["localized", "conditional", "propose-only"].includes(l.handling), `${id} handling`);
    assert.ok(Array.isArray(l.standards) && l.standards.length > 0, `${id} has standards tags`);
  }
  assert.equal(LENS_REGISTRY_VERSION, 2);
});

test("consensus + handling policy match the schema", () => {
  assert.equal(requiresConsensus("security_secrets"), true);
  assert.equal(requiresConsensus("correctness"), false);
  assert.equal(isProposeOnly("architecture_ssot"), true, "SSOT/architecture is always propose-only");
  assert.equal(isProposeOnly("config_cicd_security"), true);
  assert.equal(isProposeOnly("correctness"), false);
  assert.equal(getLens("nope"), null);
});

test("cappedSeverity enforces the P2 regex cap and the lens ceiling", () => {
  // regex-only candidate cannot exceed P2 until independently verified
  assert.equal(cappedSeverity("security_secrets", "P0", { regexOnly: true, verified: false }), "P2");
  // once verified, the P0-ceiling lens permits P0
  assert.equal(cappedSeverity("security_secrets", "P0", { regexOnly: true, verified: true }), "P0");
  // a P0 claim in a P1-ceiling lens is clamped to P1
  assert.equal(cappedSeverity("correctness", "P0", { verified: true }), "P1");
  // a P2-ceiling lens can never emit P1
  assert.equal(cappedSeverity("testing", "P0", { verified: true }), "P2");
  // within ceiling + verified, the proposed severity is respected
  assert.equal(cappedSeverity("performance", "P2", { verified: true }), "P2");
});
