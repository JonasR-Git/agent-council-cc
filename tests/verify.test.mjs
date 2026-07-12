import assert from "node:assert/strict";
import test from "node:test";

import {
  isTrustworthyVerifierResult,
  parseRefutation,
  partitionByRefutation,
  shouldVerify,
  verifierAvailability,
  verifierFor
} from "../plugins/council/scripts/lib/verify.mjs";

test("shouldVerify targets P0/P1 single-agent findings, protects consensus + lower severities", () => {
  assert.equal(shouldVerify({ severity: "P0", consensus: false }), true);
  assert.equal(shouldVerify({ severity: "P1", consensus: false }), true);
  assert.equal(shouldVerify({ severity: "P0", consensus: true }), false, "consensus is protected, no wasted spawn");
  assert.equal(shouldVerify({ severity: "P2", consensus: false }), false, "below default severity");
  assert.equal(shouldVerify({ severity: "P2", consensus: false }, ["P0", "P1", "P2"]), true, "explicit severities honored");
});

test("verifierFor picks a seat that did NOT raise the finding; null when none independent", () => {
  assert.equal(verifierFor({ agents: ["codex"] }, {}), "grok", "grok verifies a codex-only finding");
  assert.equal(verifierFor({ agents: ["grok"] }, {}), "codex");
  // B2: Claude is now a THIRD candidate — so a codex-only finding with grok skipped is verified by
  // Claude (was null in the two-finder world; council codex-1 flagged that stale assumption).
  assert.equal(verifierFor({ agents: ["codex"] }, { skipGrok: true }), "claude", "Claude is an independent verifier");
  assert.equal(verifierFor({ agents: ["codex"] }, { skipGrok: true, skipClaude: true }), null, "no independent seat left");
  assert.equal(verifierFor({ agents: ["grok", "codex", "claude"] }, {}), null, "all three raised it → no independent verifier");
});

test("B2: verifierFor only picks a REACHABLE seat when availability is known (council claude-4)", () => {
  const onlyClaude = { codex: false, grok: false, claude: true };
  // grok is the first candidate, but unavailable → skip to codex (unavailable) → claude (available)
  assert.equal(verifierFor({ agents: ["codex"] }, {}, onlyClaude), "claude");
  // a codex-only finding with grok+claude unavailable → no reachable independent verifier (was a
  // wasted spawn before: it returned 'grok'/'claude' that then failed to launch).
  assert.equal(verifierFor({ agents: ["codex"] }, {}, { codex: true, grok: false, claude: false }), null);
});

test("verifierAvailability reflects the probed backends", () => {
  const a = verifierAvailability({ codex: { companionAvailable: true }, grok: { cli: { available: false } }, claude: { cli: { available: true } } });
  assert.deepEqual(a, { codex: true, grok: false, claude: true });
});

test("isTrustworthyVerifierResult does NOT trust a truncated reply even with status 0 and parseable stdout", () => {
  // A maxBuffer-overflow kill can still report exit 0 if the process had already flushed output
  // as/just-before the kill — status===0 alone must not be trusted when truncated is true.
  const truncatedButParseable = { status: 0, timedOut: false, truncated: true, skipped: false, stdout: '{"refuted": true, "reason": "looks fine"}' };
  assert.equal(isTrustworthyVerifierResult(truncatedButParseable), false, "a truncated run must never be trusted, even if status===0 and stdout parses cleanly");
  // sanity: the same stdout WOULD parse as a confident refutation if it were (wrongly) trusted —
  // demonstrating exactly what the truncated guard prevents from silently hiding a real finding.
  assert.deepEqual(parseRefutation(truncatedButParseable.stdout), { refuted: true, reason: "looks fine" });
  // a clean, non-truncated run with the same shape IS trusted
  const clean = { ...truncatedButParseable, truncated: false };
  assert.equal(isTrustworthyVerifierResult(clean), true);
  // the pre-existing guards still hold
  assert.equal(isTrustworthyVerifierResult({ ...clean, skipped: true }), false);
  assert.equal(isTrustworthyVerifierResult({ ...clean, timedOut: true }), false);
  assert.equal(isTrustworthyVerifierResult({ ...clean, status: 1 }), false);
  assert.equal(isTrustworthyVerifierResult({ ...clean, stdout: "   " }), false);
});

test("parseRefutation reads a strict {refuted,reason} JSON, rejects malformed", () => {
  assert.deepEqual(parseRefutation('{"refuted": true, "reason": "no such call path"}'), { refuted: true, reason: "no such call path" });
  assert.equal(parseRefutation("not json"), null);
  assert.equal(parseRefutation('{"reason":"x"}'), null, "missing boolean refuted → null");
});

const merged = (all) => ({ all, consensus: all.filter((f) => f.consensus), unique: all.filter((f) => !f.consensus) });

test("partitionByRefutation demotes ONLY an evidence-based refutation of a single-agent finding", () => {
  const f1 = { id: "a", consensus: false };
  const f2 = { id: "b", consensus: false };
  const refs = new Map([
    [f1, { by: "grok", refuted: true, reason: "dead path", demotable: true }], // evidence-based → demote
    [f2, { by: "grok", refuted: true, reason: "hunch", demotable: false }] // no evidence → annotate, keep
  ]);
  const out = partitionByRefutation(merged([f1, f2]), refs);
  assert.equal(out.refutedCount, 1);
  assert.equal(out.merged.refuted[0].id, "a");
  assert.ok(out.merged.all.some((f) => f.id === "b"), "evidence-less refutation keeps the finding");
  assert.ok(out.merged.all.find((f) => f.id === "b").verified, "but annotates it as disputed");
});

test("partitionByRefutation demote:false is ANNOTATE-ONLY — refuted stays VISIBLE in .all", () => {
  const f1 = { id: "a", consensus: false };
  const refs = new Map([[f1, { by: "grok", refuted: true, reason: "x", demotable: true }]]);
  const out = partitionByRefutation(merged([f1]), refs, 0, { demote: false });
  assert.equal(out.refutedCount, 1, "still COUNTED as refuted");
  assert.ok(out.merged.all.some((f) => f.id === "a"), "but never dropped from .all (no silent erasure)");
  assert.ok(out.merged.all.find((f) => f.id === "a").verified?.refuted, "annotated so downstream can deprioritize");
});

test("partitionByRefutation NEVER demotes a consensus finding, even if refuted", () => {
  const c = { id: "c", consensus: true };
  const refs = new Map([[c, { by: "grok", refuted: true, reason: "x", demotable: true }]]);
  const out = partitionByRefutation(merged([c]), refs);
  assert.equal(out.refutedCount, 0, "consensus is protected");
  assert.ok(out.merged.all.some((f) => f.id === "c"));
  assert.ok(out.merged.consensus[0].verified, "kept but annotated disputed");
});
