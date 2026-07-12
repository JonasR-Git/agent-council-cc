import assert from "node:assert/strict";
import test from "node:test";

import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";

const model = { files: [{ id: "a.mjs", fanIn: 2 }, { id: "hub.mjs", fanIn: 12 }, { id: "b.mjs", fanIn: 1 }] };
const bigModel = { files: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}.mjs`, fanIn: 1 })) };

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
  const deps = makeFixLoopDeps("/x", model, {}, { minSeverity: "P1", maxFixesPerPass: 3 }, { runAuditFix });
  await deps.fix([{ file: "a.mjs" }], { branch: "council/z", stayOnBranch: true });
  assert.equal(seen.branch, "council/z");
  assert.equal(seen.stayOnBranch, true);
  assert.equal(seen.minSeverity, "P1");
  assert.equal(seen.maxFixes, 3);
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
