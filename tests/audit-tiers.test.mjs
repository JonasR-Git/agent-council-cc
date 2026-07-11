import assert from "node:assert/strict";
import test from "node:test";

import { lensIds } from "../plugins/council/scripts/lib/audit-lenses.mjs";
import {
  actionableByTier,
  applyTierGating,
  groupByTier,
  orderByTier,
  tierAction,
  tierOfLens,
  unmappedLenses,
  SECURITY_OVERRIDE_LENSES,
  TIERS
} from "../plugins/council/scripts/lib/audit-tiers.mjs";

test("every registered lens is mapped to exactly one tier", () => {
  assert.deepEqual(unmappedLenses(lensIds()), [], "no lens may be left un-tiered");
  const seen = new Set();
  for (const t of TIERS) for (const l of t.lenses) {
    assert.equal(seen.has(l), false, `${l} mapped twice`);
    seen.add(l);
  }
  assert.equal(seen.size, lensIds().length, "tier lens sets cover the whole registry");
});

test("tierOfLens places lenses in the right tier; unknown -> quality", () => {
  assert.equal(tierOfLens("logical_sense"), 0);
  assert.equal(tierOfLens("architecture_ssot"), 1);
  assert.equal(tierOfLens("correctness"), 2);
  assert.equal(tierOfLens("security_secrets"), 2);
  assert.equal(tierOfLens("testing"), 3);
  assert.equal(tierOfLens("nonsense_lens"), 3, "unknown lens is treated as lowest-stakes");
});

test("orderByTier sorts by tier, then severity, then file", () => {
  const ordered = orderByTier([
    { lens: "testing", severity: "P1", file: "z.mjs" },
    { lens: "correctness", severity: "P2", file: "b.mjs" },
    { lens: "correctness", severity: "P0", file: "a.mjs" },
    { lens: "logical_sense", severity: "P2", file: "m.mjs" }
  ]);
  assert.deepEqual(ordered.map((f) => f.file), ["m.mjs", "a.mjs", "b.mjs", "z.mjs"]);
});

test("groupByTier buckets findings, preserving tier order", () => {
  const g = groupByTier([{ lens: "logical_sense" }, { lens: "correctness" }, { lens: "testing" }]);
  assert.deepEqual(g.map((t) => t.tierId), [0, 1, 2, 3]);
  assert.equal(g[0].findings.length, 1);
  assert.equal(g[1].findings.length, 0);
  assert.equal(g[2].findings.length, 1);
  assert.equal(g[3].findings.length, 1);
});

test("tierAction: keep -> process; remove -> skip; merge-into -> redirect", () => {
  const vm = {
    "a.mjs": { verdict: "keep" },
    "b.mjs": { verdict: "remove" },
    "c.mjs": { verdict: "merge-into", survivor: "core.mjs" }
  };
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "a.mjs" }, vm).action, "process");
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "b.mjs" }, vm).action, "skip");
  const r = tierAction({ lens: "correctness", severity: "P1", file: "c.mjs" }, vm);
  assert.equal(r.action, "redirect");
  assert.equal(r.to, "core.mjs");
});

test("tierAction: redesign suppresses Quality polish but keeps Correctness", () => {
  const vm = { "x.mjs": { verdict: "redesign" } };
  assert.equal(tierAction({ lens: "docs_maintainability", severity: "P2", file: "x.mjs" }, vm).action, "suppress");
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "x.mjs" }, vm).action, "process");
});

test("P0-security override: a live P0 hole is processed even on a remove-marked unit", () => {
  const vm = { "auth.mjs": { verdict: "remove" } };
  const sec = tierAction({ lens: "security_secrets", severity: "P0", file: "auth.mjs" }, vm);
  assert.equal(sec.action, "process");
  assert.match(sec.reason, /override/);
  // a NON-security P0, or a P1 security finding, still obeys the remove verdict
  assert.equal(tierAction({ lens: "correctness", severity: "P0", file: "auth.mjs" }, vm).action, "skip");
  assert.equal(tierAction({ lens: "security_secrets", severity: "P1", file: "auth.mjs" }, vm).action, "skip");
});

test("applyTierGating annotates gateEffect and splits process/skipped/suppressed", () => {
  const findings = [
    { lens: "correctness", severity: "P1", file: "keep.mjs" },
    { lens: "correctness", severity: "P1", file: "dead.mjs" },
    { lens: "docs_maintainability", severity: "P2", file: "redo.mjs" },
    { lens: "security_secrets", severity: "P0", file: "dead.mjs" }
  ];
  const vm = { "dead.mjs": { verdict: "remove" }, "redo.mjs": { verdict: "redesign" } };
  const out = applyTierGating(findings, vm);
  assert.equal(out.skipped.length, 1, "the correctness fix on the dead unit is skipped");
  assert.equal(out.suppressed.length, 1, "the quality polish on the redesign unit is suppressed");
  // process includes keep.mjs correctness AND the P0-security override on dead.mjs
  assert.ok(out.process.some((f) => f.file === "keep.mjs"));
  assert.ok(out.process.some((f) => f.file === "dead.mjs" && f.lens === "security_secrets"));
  // skipped != dropped: the real P1 bug parked behind an unconfirmed remove? is surfaced
  assert.equal(out.surfaced.length, 1);
  assert.equal(out.surfaced[0].file, "dead.mjs");
  assert.equal(out.surfaced[0].lens, "correctness");
  for (const f of out.findings) assert.ok(typeof f.tier === "number" && f.gateEffect);
});

test("override covers ALL P0-ceiling lenses (derived), obeys reachability", () => {
  assert.deepEqual([...SECURITY_OVERRIDE_LENSES].sort(), ["concurrency_resources", "config_cicd_security", "data_integrity", "security_secrets"]);
  const vm = { "x.mjs": { verdict: "remove" } };
  // a P0 race and a P0 CI-injection on a remove? unit are still processed
  assert.equal(tierAction({ lens: "concurrency_resources", severity: "P0", file: "x.mjs" }, vm).action, "process");
  assert.equal(tierAction({ lens: "config_cicd_security", severity: "P0", file: "x.mjs" }, vm).action, "process");
  // explicitly unreachable -> the override does NOT fire (don't verify a dead hole)
  const dead = { "x.mjs": { verdict: "remove", reachable: false } };
  assert.equal(tierAction({ lens: "security_secrets", severity: "P0", file: "x.mjs" }, dead).action, "skip");
});

test("merge-into: valid survivor redirects; missing/self survivor processes in place", () => {
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "a.mjs" }, { "a.mjs": { verdict: "merge-into", survivor: "core.mjs" } }).to, "core.mjs");
  const noSurv = tierAction({ lens: "correctness", severity: "P1", file: "a.mjs" }, { "a.mjs": { verdict: "merge-into" } });
  assert.equal(noSurv.action, "process");
  assert.match(noSurv.reason, /missing\/self survivor/);
  const self = tierAction({ lens: "correctness", severity: "P1", file: "a.mjs" }, { "a.mjs": { verdict: "merge-into", survivor: "a.mjs" } });
  assert.equal(self.action, "process");
});

test("quarantine is kept+flagged (process); relocate suppresses quality polish", () => {
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "q.mjs" }, { "q.mjs": { verdict: "quarantine" } }).action, "process");
  assert.equal(tierAction({ lens: "docs_maintainability", severity: "P2", file: "r.mjs" }, { "r.mjs": { verdict: "relocate" } }).action, "suppress");
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "r.mjs" }, { "r.mjs": { verdict: "relocate" } }).action, "process");
});

test("verdicts key on fingerprint first (survives a re-map); sentinel/unknown units are never gated", () => {
  // same file path but the verdict is keyed by the AST-anchored fingerprint
  const vm = { "fp:sym#1": { verdict: "remove" } };
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "moved.mjs", fingerprint: "fp:sym#1" }, vm).action, "skip");
  // an unidentifiable unit ("" / "unknown") is never gated -> always process
  assert.equal(tierAction({ lens: "correctness", severity: "P1", file: "" }, { "": { verdict: "remove" } }).action, "process");
  assert.equal(tierAction({ lens: "correctness", severity: "P1", location: { path: "unknown" } }, { unknown: { verdict: "remove" } }).action, "process");
});

test("verdict lookup normalizes Windows separators; location.path shape works", () => {
  const vm = { "src/a.mjs": { verdict: "remove" } };
  // a finding whose path uses backslashes still matches the posix-keyed verdict
  assert.equal(tierAction({ lens: "correctness", severity: "P1", location: { path: "src\\a.mjs" } }, vm).action, "skip");
});

test("actionableByTier groups process+redirect for the fix loop, tier-ordered", () => {
  const findings = [
    { lens: "logical_sense", severity: "P1", file: "l.mjs" },
    { lens: "correctness", severity: "P1", file: "c.mjs" },
    { lens: "correctness", severity: "P1", file: "m.mjs" }
  ];
  const vm = { "m.mjs": { verdict: "merge-into", survivor: "core.mjs" } };
  const buckets = actionableByTier(applyTierGating(findings, vm));
  assert.deepEqual(buckets.map((b) => b.tierId), [0, 1, 2, 3]);
  assert.equal(buckets[2].findings.length, 2, "both correctness findings (one redirected) are actionable in tier 2");
});
