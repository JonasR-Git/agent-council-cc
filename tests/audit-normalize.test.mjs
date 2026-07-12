import assert from "node:assert/strict";
import test from "node:test";

import { categoryToLens, evidenceState, normalizeFindings, toCanonicalFinding } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

test("categoryToLens maps raw categories onto the 12 lenses", () => {
  assert.equal(categoryToLens("security"), "security_secrets");
  assert.equal(categoryToLens("data-loss"), "data_integrity");
  assert.equal(categoryToLens("ssot"), "architecture_ssot");
  assert.equal(categoryToLens("nonsense"), "correctness", "unknown -> default");
});

test("evidenceState: a REFUTED finding is the WEAKEST state, never adversarial-verified (council Fable P1 — inversion)", () => {
  // partitionByRefutation annotates BOTH outcomes with a truthy `verified` object; reading it as
  // Boolean() promoted a REFUTED finding to the strongest evidence (floor 0.85, lifecycle confirmed,
  // ranked first). The refuted flag must dominate.
  const refuted = { verified: { by: "grok", refuted: true, reason: "not reachable" }, agents: ["codex"] };
  assert.equal(evidenceState(refuted), "refuted", "a refuted finding is not 'verified'");
  const canon = toCanonicalFinding({ ...refuted, severity: "P0", category: "security", file: "a.mjs" }, { unit: "a.mjs" });
  assert.equal(canon.lifecycle, "refuted", "not 'confirmed'");
  assert.ok(canon.confidence <= 0.2, `refuted confidence is capped low (got ${canon.confidence})`);
  // a SUPPORTED verification still promotes normally
  const supported = { verified: { by: "grok", refuted: false, reason: "reproduced the call path" }, agents: ["codex"] };
  assert.equal(evidenceState(supported), "adversarial-verified");
  assert.ok(toCanonicalFinding({ ...supported, severity: "P1", category: "bug", file: "a.mjs" }, { unit: "a.mjs" }).confidence >= 0.85);
});

test("evidenceState reflects verification / consensus / finder count", () => {
  assert.equal(evidenceState({ verified: true, reproduced: true }), "reproduced");
  assert.equal(evidenceState({ verified: true }), "adversarial-verified");
  assert.equal(evidenceState({ consensus: true }), "independent-agreement");
  assert.equal(evidenceState({ agents: ["codex"] }), "one-finder");
  assert.equal(evidenceState({}), "regex-only");
});

test("toCanonicalFinding produces a schema-valid canonical finding", () => {
  const raw = { severity: "P1", category: "security", title: "SQL injection in query", detail: "user input concatenated into SQL", file: "src/db.mjs", line: 42, agents: ["codex", "claude"], consensus: true, anchor: "runQuery" };
  const f = toCanonicalFinding(raw, { unit: "src/db.mjs" });
  assert.equal(f.lens, "security_secrets");
  assert.equal(f.lifecycle, "confirmed", "consensus -> confirmed");
  assert.equal(f.consensus, "consensus");
  assert.equal(f.scope, "localized");
  assert.ok(f.fingerprint.startsWith("fp1|src/db.mjs|security_secrets|"));
  assert.ok(f.risk.calibrated > 0);
  const v = validate(SCHEMAS.auditFinding, f);
  assert.ok(v.valid, v.errors.join("; "));
});

test("regex-only candidate is capped at P2 and low confidence; propose-only lens is cross-cutting", () => {
  const regexP0 = toCanonicalFinding({ severity: "P0", category: "security", title: "maybe", file: "a.mjs", line: 1 });
  assert.equal(regexP0.severity, "P2", "regex-only (no finder) capped");
  assert.ok(regexP0.confidence <= 0.35);
  const ssot = toCanonicalFinding({ severity: "P1", category: "ssot", title: "dup", file: "a.mjs", line: 1, agents: ["codex"] });
  assert.equal(ssot.scope, "cross-cutting");
  assert.equal(ssot.fixDisposition, "propose-only", "architecture/SSOT is never auto-fixed");
});

test("normalizeFindings assigns ordinals so same rule+anchor findings don't collapse", () => {
  const raws = [
    { severity: "P2", category: "bug", title: "empty catch", file: "a.mjs", line: 10, anchor: "handle", agents: ["codex"] },
    { severity: "P2", category: "bug", title: "empty catch", file: "a.mjs", line: 55, anchor: "handle", agents: ["codex"] }
  ];
  const out = normalizeFindings(raws, { unit: "a.mjs" });
  assert.equal(out.length, 2);
  assert.notEqual(out[0].fingerprint, out[1].fingerprint, "two occurrences get distinct identities");
});
