import assert from "node:assert/strict";
import test from "node:test";

import { categoryToLens, evidenceState, fixEligibilityLens, isMultiSeat, normalizeFindings, seatsOf, toCanonicalFinding } from "../plugins/council/scripts/lib/audit-normalize.mjs";
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

// --- fixEligibilityLens: the Wurzel-Fix — fix eligibility decoupled from the coverage lens -------------

test("fixEligibilityLens: a fixable category group-stamped onto logical_sense reattributes to its native lens", () => {
  // A bug found under the logical_sense group (relens) — concrete location, no cross-cutting language.
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 42, title: "off-by-one" }, "logical_sense"), "correctness");
  assert.equal(fixEligibilityLens({ category: "data-loss", file: "a.mjs", line: 9, title: "drops last row" }, "logical_sense"), "data_integrity");
});

test("fixEligibilityLens: a runtime-fixable coverage lens is never reattributed (keeps identity)", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 1 }, "correctness"), "correctness");
  assert.equal(fixEligibilityLens({ category: "auth", file: "a.mjs", line: 1 }, "security_secrets"), "security_secrets");
});

test("fixEligibilityLens: a category that maps to a propose-only lens stays on the coverage lens", () => {
  // design → architecture_ssot (propose-only): nothing to gain, stays propose-only.
  assert.equal(fixEligibilityLens({ category: "design", file: "a.mjs", line: 1 }, "logical_sense"), "logical_sense");
});

test("fixEligibilityLens: VETO 1 — an explicit cross-cutting scope keeps it propose-only", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 5, scope: "cross-cutting" }, "logical_sense"), "logical_sense");
});

test("fixEligibilityLens: VETO 1 — cross-cutting language in the text keeps it propose-only", () => {
  // classifyScope's CROSS_CUTTING_HINTS fires on 'across'/'refactor'/'api surface'.
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 5, title: "inconsistent handling across modules" }, "logical_sense"), "logical_sense");
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 5, title: "x", detail: "requires an api surface refactor" }, "logical_sense"), "logical_sense");
});

test("fixEligibilityLens: VETO 1 — no precise location (missing line) is not localizable", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs" }, "logical_sense"), "logical_sense");
});

test("fixEligibilityLens: VETO 2 — a removal verdict or survivor target is inherently multi-file", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 3, verdict: "remove" }, "logical_sense"), "logical_sense");
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 3, verdict: "merge-into", survivor: "b.mjs" }, "logical_sense"), "logical_sense");
});

test("fixEligibilityLens: FAIL-CLOSED allowlist — unknown/other/test/docs categories stay propose-only (council P1)", () => {
  // categoryToLens fails OPEN to correctness for these; the positive allowlist must keep them propose-only.
  assert.equal(fixEligibilityLens({ category: "other", file: "a.mjs", line: 5 }, "logical_sense"), "logical_sense", "the 92-strong 'other' bucket is NOT auto-eligible");
  assert.equal(fixEligibilityLens({ category: "test", file: "a.mjs", line: 5 }, "logical_sense"), "logical_sense");
  assert.equal(fixEligibilityLens({ category: "docs", file: "a.mjs", line: 5 }, "logical_sense"), "logical_sense");
  assert.equal(fixEligibilityLens({ category: undefined, file: "a.mjs", line: 5 }, "logical_sense"), "logical_sense", "missing category never reattributes");
  assert.equal(fixEligibilityLens({ category: "logic-error", file: "a.mjs", line: 5 }, "logical_sense"), "logical_sense", "unmapped free-text category stays propose-only");
});

test("fixEligibilityLens: allowlisted sensitive synonyms reattribute to their sensitive lens (the §6 gate then applies)", () => {
  assert.equal(fixEligibilityLens({ category: "secret", file: "a.mjs", line: 5 }, "logical_sense"), "security_secrets");
  assert.equal(fixEligibilityLens({ category: "resource", file: "a.mjs", line: 5 }, "logical_sense"), "concurrency_resources");
  assert.equal(fixEligibilityLens({ category: "data", file: "a.mjs", line: 5 }, "logical_sense"), "data_integrity");
});

test("fixEligibilityLens: only logical_sense reattributes — architecture_ssot (Tier 1) stays propose-only", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 5 }, "architecture_ssot"), "architecture_ssot");
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 5 }, "dependencies_supply_chain"), "dependencies_supply_chain");
});

test("fixEligibilityLens: precise-line veto is EXPLICIT — a missing/zero line is not localizable", () => {
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs" }, "logical_sense"), "logical_sense", "no line → propose-only");
  assert.equal(fixEligibilityLens({ category: "bug", file: "a.mjs", line: 0 }, "logical_sense"), "logical_sense", "line 0 is not a real location");
});

test("isMultiSeat: STRICT on the consensus string — 'single'/'contested' never fabricate consensus (council P1)", () => {
  assert.equal(isMultiSeat({ consensus: "single" }), false, "the truthy string 'single' must NOT read as consensus");
  assert.equal(isMultiSeat({ consensus: "contested" }), false, "an actively contested finding is not consensus");
  assert.equal(isMultiSeat({ consensus: "consensus" }), true);
  assert.equal(isMultiSeat({ consensus: true }), true);
  assert.equal(isMultiSeat({ seats: ["codex", "grok"] }), true, "a real ≥2-seat union is consensus");
  assert.equal(isMultiSeat({ seats: ["codex"] }), false);
});

test("toCanonicalFinding: idempotent on consensus — re-normalizing a canonical single finding never promotes it", () => {
  const once = toCanonicalFinding({ category: "bug", lens: "correctness", severity: "P1", file: "a.mjs", line: 5, title: "x", agents: ["codex"] }, { unit: "a.mjs" });
  assert.equal(once.consensus, "single");
  const twice = toCanonicalFinding(once, { unit: "a.mjs" });
  assert.equal(twice.consensus, "single", "a second canonicalization must not turn 'single' into 'consensus'");
});

test("seatsOf: an empty agents array does not shadow a populated seats array (consensus-deciding)", () => {
  assert.deepEqual(seatsOf({ agents: [], seats: ["codex", "grok"] }).sort(), ["codex", "grok"]);
  assert.deepEqual(seatsOf({ agents: ["claude"], seats: ["codex"] }), ["claude"], "a populated agents still wins");
});

test("toCanonicalFinding: a reattributed bug is localized+fixable and carries fixLens; coverage lens stays logical_sense", () => {
  const f = toCanonicalFinding({ category: "bug", lens: "logical_sense", severity: "P1", file: "a.mjs", line: 42, title: "off-by-one", agents: ["codex", "grok"], consensus: true }, { unit: "a.mjs" });
  assert.equal(f.lens, "logical_sense", "coverage lens (reporting/tier) is preserved");
  assert.equal(f.fixLens, "correctness", "fix lens is the category-native lens");
  assert.equal(f.scope, "localized");
  assert.equal(f.fixDisposition, "localized");
});

test("toCanonicalFinding: a true logical design finding stays cross-cutting/propose-only with no fixLens", () => {
  const f = toCanonicalFinding({ category: "design", lens: "logical_sense", severity: "P2", file: "a.mjs", line: 1, title: "premature abstraction", agents: ["grok"] }, { unit: "a.mjs" });
  assert.equal(f.lens, "logical_sense");
  assert.equal(f.scope, "cross-cutting");
  assert.equal(f.fixDisposition, "propose-only");
  assert.ok(!("fixLens" in f), "no reattribution → fixLens is absent, downstream falls back to lens");
});

test("toCanonicalFinding: fingerprint uses the COVERAGE lens so identity is unaffected by reattribution", () => {
  const reattributed = toCanonicalFinding({ category: "bug", lens: "logical_sense", severity: "P1", file: "a.mjs", line: 42, title: "x", agents: ["codex"] }, { unit: "a.mjs" });
  const plainLogical = toCanonicalFinding({ category: "bug", lens: "logical_sense", severity: "P1", file: "a.mjs", line: 42, title: "x", scope: "cross-cutting", agents: ["codex"] }, { unit: "a.mjs" });
  assert.equal(reattributed.fingerprint, plainLogical.fingerprint, "same coverage lens+location+rule → same identity regardless of fix scope");
});
