import assert from "node:assert/strict";
import test from "node:test";

import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { ineligibleReason } from "../plugins/council/scripts/lib/audit-fix.mjs";

const model = { files: [{ id: "a.mjs", fanIn: 2 }, { id: "hub.mjs", fanIn: 12 }, { id: "b.mjs", fanIn: 1 }] };
const bigModel = { files: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}.mjs`, fanIn: 1 })) };

test("R9: makeFixLoopDeps drives the loop off runGroupedReview when --groups is set", async () => {
  let seen = null;
  const runGroupedReview = async (cwd, m, backends, opts) => {
    seen = opts;
    return { findings: [{ file: "a.mjs", title: "x", category: "bug", severity: "P2" }], coverage: { unitsReviewed: 1, unitsSelected: 1, passComplete: false, budgetSpent: 5 } };
  };
  const runAuditReview = async () => { throw new Error("per-file path must NOT be used when --groups is set"); };
  const deps = makeFixLoopDeps("/x", model, {}, { lensGroups: "fine", maxCells: 100 }, { runGroupedReview, runAuditReview });
  const rev = await deps.review({ budget: 500, changedFiles: null }); // budget ≥ maxCells → cap not hit
  assert.equal(seen.lensGroups, "fine", "the grouped path is selected + the preset threaded");
  assert.equal(seen.maxCells, 100, "the cell cap is threaded (uncapped when budget ≥ maxCells)");
  assert.equal(rev.ran, true, "a grouped pass that reviewed a unit is ran:true");
});

test("R9 (council Grok/Codex P1): a grouped pass's cells are CAPPED to the per-pass budget", async () => {
  // each cell = one paid agent call; a pass must never dispatch more cells than its budget allots, else
  // one pass blows the whole loop budget → a 1-pass stop with under-reported spend.
  let seen = null;
  const runGroupedReview = async (cwd, m, backends, opts) => { seen = opts; return { findings: [], coverage: { unitsReviewed: 1, unitsSelected: 1, passComplete: true, budgetSpent: 0 } }; };
  const deps = makeFixLoopDeps("/x", model, {}, { lensGroups: "fine", maxCells: 1500 }, { runGroupedReview });
  await deps.review({ budget: 40, changedFiles: null });
  assert.equal(seen.maxCells, 40, "cells capped to the per-pass budget (min(1500, 40))");
});

test("R9: without --groups the loop still uses the per-file runAuditReview", async () => {
  let usedGrouped = false;
  const runGroupedReview = async () => { usedGrouped = true; return { findings: [], coverage: {} }; };
  const runAuditReview = async () => ({ findings: [], coverage: { unitsReviewed: 1, unitsSelected: 1, budgetSpent: 1 } });
  const deps = makeFixLoopDeps("/x", model, {}, {}, { runGroupedReview, runAuditReview });
  await deps.review({ budget: 5, changedFiles: null });
  assert.equal(usedGrouped, false, "the grouped path is opt-in — default stays per-file");
});

test("full-scope passes advance a WRAPPING window keyed to full passes, not the global pass counter", async () => {
  const calls = [];
  const runAuditReview = async (cwd, m, backends, opts) => {
    calls.push({ n: m.files.length, off: opts.unitOffset, skipReduce: opts.skipReduce });
    return { findings: [], coverage: { budgetSpent: 1 } };
  };
  const deps = makeFixLoopDeps("/x", bigModel, {}, { maxUnits: 2 }, { runAuditReview });
  await deps.review({ budget: 5, changedFiles: null }); // full -> 0
  await deps.review({ budget: 5, changedFiles: ["f0.mjs"] }); // scoped -> MUST NOT advance the window
  await deps.review({ budget: 5, changedFiles: null }); // full -> 2
  await deps.review({ budget: 5, changedFiles: null }); // full -> 4
  await deps.review({ budget: 5, changedFiles: null }); // full -> 6 % 6 = 0 (wrap, not an empty off-the-end review)
  assert.deepEqual(calls.map((c) => c.off), [0, 0, 2, 4, 0]);
  assert.equal(calls[1].n, 1, "the scoped pass reviewed only the changed file");
  assert.equal(calls[0].skipReduce, false, "the SSOT reduce runs on the first full pass");
  assert.equal(calls[2].skipReduce, true, "and not again");
});

test("review surfaces a top-level `ran` from the REAL coverage shape (throttled = ran:false)", async () => {
  // runAuditReview never returns a top-level `ran` — it reports coverage.{unitsReviewed,
  // unitsAttempted}. The dep must translate "attempted units but ALL failed" into ran:false
  // so the loop stops honestly instead of counting an unreviewed pass toward convergence.
  const mk = (unitsReviewed, unitsSelected, unitsAttempted) => async () => ({ findings: [], coverage: { unitsReviewed, unitsSelected, unitsAttempted: unitsAttempted ?? unitsSelected, budgetSpent: 1 } });

  const throttled = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview: mk(0, 3, 3) }); // 3 selected+tried, all failed
  assert.equal((await throttled.review({ budget: 5, changedFiles: null })).ran, false, "units failed → ran:false");

  // Grok's case: units SELECTED but none DISPATCHED (no reachable reviewer / budget-starved)
  const undispatched = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview: mk(0, 3, 0) });
  assert.equal((await undispatched.review({ budget: 5, changedFiles: null })).ran, false, "selected-but-undispatched is NOT convergence");

  const reviewed = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview: mk(2, 2, 2) }); // 2 reviewed, found nothing
  assert.equal((await reviewed.review({ budget: 5, changedFiles: null })).ran, true, "reviewed but empty is a real dry pass");

  const nothing = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview: mk(0, 0, 0) }); // nothing to review
  assert.equal((await nothing.review({ budget: 5, changedFiles: null })).ran, true, "0 selected is not a failure");
});

test("council Codex C2: a budget-starved pass with reduce-only findings is ran:true (findings not discarded)", async () => {
  // no unit dispatched (reviewed=0) but the reserved global SSOT reduce ran and produced a finding —
  // keying ran only on unitsReviewed would drop it before gating.
  const runAuditReview = async () => ({ findings: [{ file: "x.mjs", title: "ssot dup", category: "design", severity: "P2" }], coverage: { unitsSelected: 1, unitsReviewed: 0, reduceRan: true, budgetSpent: 1 } });
  const deps = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview });
  const rev = await deps.review({ budget: 2, changedFiles: null });
  assert.equal(rev.ran, true, "a reduce finding means the pass ran — surface it, don't stop as 'couldn't review'");
  assert.equal(rev.findings.length, 1);
});

test("review assigns a canonical lens to every finding (repairs loop-path tier staging)", async () => {
  // Regression guard: the loop path used to leave finding.lens undefined, so tierOfLens
  // dropped everything into the Quality tier and structure-first --per-tier was inert.
  const runAuditReview = async () => ({
    findings: [{ category: "concurrency", title: "race", file: "a.mjs", severity: "P1" }],
    coverage: { unitsReviewed: 1, unitsSelected: 1, budgetSpent: 1 }
  });
  const deps = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview });
  const rev = await deps.review({ budget: 5, changedFiles: null });
  assert.ok(rev.findings[0].lens, "finding carries a lens");
  assert.equal(typeof rev.findings[0].lens, "string");
});

test("review-normalized findings stay ELIGIBLE for runAuditFix (retain top-level .file)", async () => {
  // Regression guard for the P0: normalizeFindings canonicalizes to {location:{path}} and drops the
  // top-level .file that runAuditFix keys on (ineligibleReason "no target file"). Before the fix the
  // loop normalized every finding into an un-targetable shape → it never auto-fixed anything, and no
  // test caught it because they only asserted .lens. Assert the finding is a valid fix target.
  const runAuditReview = async () => ({
    findings: [{ category: "bug", title: "off-by-one", file: "a.mjs", line: 12, severity: "P1" }],
    coverage: { unitsReviewed: 1, unitsSelected: 1, budgetSpent: 1 }
  });
  const deps = makeFixLoopDeps("/x", model, {}, {}, { runAuditReview });
  const rev = await deps.review({ budget: 5, changedFiles: null });
  assert.equal(rev.findings[0].file, "a.mjs", "top-level .file survives normalization");
  assert.equal(rev.findings[0].line, 12, "top-level .line survives");
  assert.notEqual(ineligibleReason(rev.findings[0]), "no target file", "runAuditFix accepts it as a target");
});

test("a scoped pass whose files aren't in the model falls back to full scope, never an empty review", async () => {
  let seen;
  const runAuditReview = async (cwd, m) => {
    seen = m.files.length;
    return { findings: [], coverage: { budgetSpent: 1 } };
  };
  const deps = makeFixLoopDeps("/x", model, {}, { maxUnits: 5 }, { runAuditReview });
  await deps.review({ budget: 5, changedFiles: ["nonexistent.mjs"] });
  assert.equal(seen, model.files.length, "unknown changed files -> full scope, not zero units");
});

test("fix threads branch + stayOnBranch (and severity/max) to runAuditFix", async () => {
  let seen;
  const runAuditFix = async (cwd, findings, backends, opts) => {
    seen = opts;
    return { ok: true, fixed: [], changedFiles: [], spent: 0 };
  };
  const deps = makeFixLoopDeps("/x", model, {}, { minSeverity: "P1", maxFixesPerPass: 3, ledgerBaseBranch: "main" }, { runAuditFix });
  await deps.fix([{ file: "a.mjs" }], { branch: "council/z", stayOnBranch: true });
  assert.equal(seen.branch, "council/z");
  assert.equal(seen.stayOnBranch, true);
  assert.equal(seen.minSeverity, "P1");
  assert.equal(seen.maxFixes, 3);
  assert.equal(seen.ledgerBaseBranch, "main", "the TRUE base branch is pinned for the ledger (not the integration branch)");
});

test("fix threads §6 consent + reviewPatch to runAuditFix (options + deps)", async () => {
  let seenOpts;
  let seenDeps;
  const runAuditFix = async (cwd, findings, backends, opts, injected) => {
    seenOpts = opts;
    seenDeps = injected;
    return { ok: true, fixed: [], changedFiles: [], spent: 0 };
  };
  const reviewPatch = async () => [];
  const deps = makeFixLoopDeps("/x", model, {}, { sensitiveAutoApply: true, reviewPatch }, { runAuditFix });
  await deps.fix([{ file: "a.mjs" }], {});
  assert.equal(seenOpts.sensitiveAutoApply, true, "consent flag reaches runAuditFix");
  assert.equal(seenDeps.reviewPatch, reviewPatch, "the §6 patch reviewer is injected as a dep");
});

test("fix does NOT inject reviewPatch when none is configured (propose-only default)", async () => {
  let seenDeps;
  const runAuditFix = async (cwd, findings, backends, opts, injected) => {
    seenDeps = injected;
    return { ok: true, fixed: [], changedFiles: [], spent: 0 };
  };
  const deps = makeFixLoopDeps("/x", model, {}, {}, { runAuditFix });
  await deps.fix([{ file: "a.mjs" }], {});
  assert.equal(seenDeps.reviewPatch, undefined, "no reviewer → §6 stays propose-only in runAuditFix");
});

test("expandScope re-scopes to real dependents + dup-cluster peers; a hub-sized radius falls back to full", () => {
  const model2 = {
    files: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}.mjs`, fanIn: 1, isTest: false })),
    graph: { importers: { "f0.mjs": ["f1.mjs", "f2.mjs"], "f5.mjs": ["f0.mjs", "f1.mjs", "f2.mjs", "f3.mjs", "f4.mjs"] } },
    dupClusters: [{ locations: [{ file: "f3.mjs" }, { file: "f4.mjs" }] }]
  };
  const deps = makeFixLoopDeps("/x", model2, {}, { hubFanIn: 4 });
  assert.deepEqual(deps.expandScope(["f0.mjs"]).sort(), ["f0.mjs", "f1.mjs", "f2.mjs"], "importers are re-reviewed");
  assert.deepEqual(deps.expandScope(["f3.mjs"]).sort(), ["f3.mjs", "f4.mjs"], "dup-cluster peers are re-reviewed");
  assert.deepEqual(deps.expandScope(["f5.mjs"]), [], "a hub-sized blast radius falls back to a full re-scope");
});

test("verdictsFor returns the configured verdict map (empty by default)", () => {
  assert.deepEqual(makeFixLoopDeps("/x", model, {}, {}).verdictsFor(), {});
  assert.deepEqual(makeFixLoopDeps("/x", model, {}, { verdictMap: { "a.mjs": { verdict: "remove" } } }).verdictsFor(), { "a.mjs": { verdict: "remove" } });
});
