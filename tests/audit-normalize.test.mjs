import assert from "node:assert/strict";
import test from "node:test";

import { categoryToLens, evidenceState, normalizeFindings, toCanonicalFinding } from "../plugins/council/scripts/lib/audit-normalize.mjs";
import { mergeFindings } from "../plugins/council/scripts/lib/findings.mjs";
import { SCHEMAS } from "../plugins/council/scripts/lib/schemas.mjs";
import { validate } from "../plugins/council/scripts/lib/validate.mjs";

// A review doc in the post-parse shape mergeFindings consumes (findings.mjs normalizeFindingsDoc).
const doc = (agent, confidence, over = {}) => ({
  agent,
  findings: [{
    id: `${agent}-1`,
    severity: "P1",
    category: "bug",
    title: "off-by-one in slice bound",
    detail: "drops the last element",
    file: "src/a.mjs",
    line: 12,
    confidence,
    agent,
    ...over
  }]
});

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

test("a MERGED bucket's avgConfidence reaches the canonical finding + the risk model (not the 0.6 default)", () => {
  // The audit path (audit-run.mjs) feeds normalizeFindings the MERGED buckets, which carry the
  // finders' averaged self-rating as `avgConfidence` — never `confidence`. Reading only the latter
  // scored EVERY audit finding at the 0.6 default and made the models' confidence signal dead weight.
  const merged = mergeFindings([doc("codex", 0.5), doc("grok", 0.3)]);
  assert.equal(merged.all.length, 1, "same finding from two agents merges into one bucket");
  const bucket = merged.all[0];
  assert.equal(bucket.avgConfidence, 0.4, "bucket carries the AVERAGED self-rating under `avgConfidence`");
  assert.equal(bucket.confidence, undefined, "...and does NOT carry a `confidence` field");

  const [f] = normalizeFindings(merged.all, {});
  // 0.4 is strictly BELOW the independent-agreement cap (0.8), so this can only be the models' own
  // rating flowing through — it is neither the cap nor the old 0.6 default.
  assert.equal(f.confidence, 0.4, "the merged self-rating survives into the canonical finding");
  assert.equal(f.risk.components.C, 0.4, "...and reaches the risk model");
});

test("the self-rating is clamped by the evidence-state CAP — it can lower confidence, never inflate it", () => {
  // Two agents agreeing (independent-agreement, cap 0.8) who both rate themselves 0.95: the evidence
  // supports 0.8, so 0.8 is what they get. A self-rating must never EXCEED its evidence.
  const [loud] = normalizeFindings(mergeFindings([doc("codex", 0.95), doc("grok", 0.95)]).all, {});
  assert.equal(loud.confidence, 0.8, "clamped to the independent-agreement cap");

  // Single finder (cap 0.65) rating itself 0.99 stays at 0.65.
  const solo = toCanonicalFinding({ severity: "P2", category: "bug", title: "t", file: "a.mjs", line: 1, agents: ["codex"], avgConfidence: 0.99 }, { unit: "a.mjs" });
  assert.equal(solo.confidence, 0.65, "clamped to the one-finder cap");
});

test("a REFUTED finding stays capped at 0.2 no matter how high the models rated themselves", () => {
  const refuted = { severity: "P0", category: "security", title: "rce", file: "a.mjs", line: 1, agents: ["codex", "grok"], consensus: true, verified: { by: "claude", refuted: true, reason: "input is never reachable" } };
  assert.equal(evidenceState(refuted), "refuted");
  const viaAvg = toCanonicalFinding({ ...refuted, avgConfidence: 0.99 }, { unit: "a.mjs" });
  assert.equal(viaAvg.confidence, 0.2, "refuted cap dominates a loud merged self-rating");
  assert.equal(viaAvg.lifecycle, "refuted", "and the refutation is not regressed into 'confirmed'");
  const viaRaw = toCanonicalFinding({ ...refuted, confidence: 0.99 }, { unit: "a.mjs" });
  assert.equal(viaRaw.confidence, 0.2, "refuted cap dominates a loud single-finding self-rating");
});

test("confidence sources: avgConfidence wins, then confidence, then the 0.6 default (back-compat)", () => {
  const base = { severity: "P2", category: "bug", title: "t", file: "a.mjs", line: 1, agents: ["codex"] };
  // one-finder cap is 0.65, so every value below stays untouched by the cap.
  assert.equal(toCanonicalFinding({ ...base, confidence: 0.5 }, { unit: "a.mjs" }).confidence, 0.5, "a plain raw finding still honors `confidence`");
  assert.equal(toCanonicalFinding({ ...base, avgConfidence: 0.3, confidence: 0.5 }, { unit: "a.mjs" }).confidence, 0.3, "a merged bucket's avgConfidence takes precedence");
  assert.equal(toCanonicalFinding(base, { unit: "a.mjs" }).confidence, 0.6, "neither present -> unchanged 0.6 default");
  // A non-finite rating must not poison the score (NaN risk); it falls back to the default.
  assert.equal(toCanonicalFinding({ ...base, avgConfidence: NaN, confidence: "high" }, { unit: "a.mjs" }).confidence, 0.6, "garbage ratings fall back to the default");
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
