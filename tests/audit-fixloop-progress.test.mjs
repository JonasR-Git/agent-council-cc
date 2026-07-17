import assert from "node:assert/strict";
import test from "node:test";

import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "../plugins/council/scripts/lib/audit-fixloop-deps.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// Phase 2 / Task 5 — the fix loop must FEED the ONE run reporter the companion threads in. Two seams:
//   (a) runFixLoop itself emits pass-level phase/progress from options.reporter;
//   (b) makeFixLoopDeps threads that SAME reporter into the per-pass runAuditReview + runAuditFix,
//       so the live lens table + fix counters land on the same progress.json.
// Anti-facade: prove BOTH the pass-level emit AND the closure threading actually happen.

const finding = (o) => ({ lens: "correctness", severity: "P1", ...o });
const noCheckpoint = () => {};

test("runFixLoop drives pass-level phase/progress/budget from the reporter", async () => {
  const writes = [];
  const reporter = makeProgressReporter({
    kind: "audit-fix-loop",
    stateDir: "C:/state",
    now: () => "2026-07-13T00:00:00.000Z",
    writeFile: (file, data) => writes.push({ file, data })
  });
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 2 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ ok: true, fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "abc" })), failed: [], rejected: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 2 });
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2, maxPasses: 7, reporter }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(out.fixed.length, 1, "the loop still fixes (reporter is additive)");

  const snap = reporter.snapshot();
  assert.equal(snap.phase, "fix", "each pass announces the fix phase");
  assert.match(snap.phaseDetail, /^pass \d+$/, "with a pass detail");
  assert.ok(snap.progress.passesDone >= 1, "passesDone advanced");
  assert.equal(snap.progress.passesTotal, 7, "passesTotal === maxPasses");
  assert.ok(snap.budget && snap.budget.total === 40, "the run budget is reported");
  assert.ok(writes.length > 0, "progress.json was persisted through the injected writeFile");
});

test("finding 6: the budget is re-emitted AFTER each pass's charges, not only pre-charge at pass start", async () => {
  const reporter = makeProgressReporter({ kind: "audit-fix-loop", stateDir: null, now: () => "2026-07-13T00:00:00.000Z" });
  // One pass that SPENDS on review (budgetSpent 3) then converges (dry). The pass-start budget emit is
  // PRE-charge (spent 0); only the post-charge re-emit reflects the 3 this pass actually spent — so the
  // final progress.json budget must read 3, not 0.
  const review = async () => ({ findings: [], coverage: { budgetSpent: 3, complete: true } });
  const fix = async () => ({ ok: true, fixed: [], failed: [], rejected: [], branch: "council/x", changedFiles: [], spent: 0 });
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 1, maxPasses: 7, reporter }, { review, fix, checkpoint: noCheckpoint });
  assert.equal(out.spent, 3, "the run really spent 3");
  const snap = reporter.snapshot();
  assert.equal(snap.budget.total, 40);
  assert.equal(snap.budget.spent, 3, "progress.json carries the POST-charge spend, not the pre-charge 0");
});

test("makeFixLoopDeps threads the SAME reporter into BOTH the per-pass runAuditReview and runAuditFix", async () => {
  const sentinel = makeProgressReporter({ stateDir: null }); // in-memory only; identity is what matters
  const model = { files: [{ id: "a.mjs", isTest: false }], graph: { importers: {} }, dupClusters: [] };
  let reviewGot = "unset";
  let fixGot = "unset";
  const impl = {
    runAuditReview: async (_cwd, _model, _backends, opts) => {
      reviewGot = opts.reporter;
      return { findings: [], coverage: { unitsSelected: 0, unitsReviewed: 0, budgetSpent: 1 } };
    },
    runAuditFix: async (_cwd, _findings, _backends, opts) => {
      fixGot = opts.reporter;
      return { ok: true, fixed: [], failed: [], rejected: [], changedFiles: [], spent: 1 };
    }
  };
  const deps = makeFixLoopDeps("/x", model, {}, { reporter: sentinel, maxUnits: 1 }, impl);

  await deps.review({ budget: 5, pass: 1, changedFiles: null });
  await deps.fix([], { branch: null, stayOnBranch: true, pass: 1 });

  assert.equal(reviewGot, sentinel, "the review closure passed the run reporter to runAuditReview");
  assert.equal(fixGot, sentinel, "the fix closure passed the run reporter to runAuditFix");
});

test("makeFixLoopDeps threads onProgress into runAuditFix's options (the fix-phase LOG sink)", async () => {
  // Regression for the 0-diagnostic fix pass: the fix closure MUST forward options.onProgress to
  // runAuditFix, because audit-fix.mjs derives its `log` sink from options.onProgress. When the CLI
  // sets onProgress (it does now), this forward is the only thing that carries it to the writer — a
  // missing forward silently no-op'd every "reverted — <gate>" / "committed <sha>" line on the loop path.
  const model = { files: [{ id: "a.mjs", isTest: false }], graph: { importers: {} }, dupClusters: [] };
  const sink = () => {};
  let fixOnProgress = "unset";
  const impl = {
    runAuditReview: async () => ({ findings: [], coverage: { unitsSelected: 0, budgetSpent: 1 } }),
    runAuditFix: async (_cwd, _findings, _backends, opts) => {
      fixOnProgress = opts.onProgress;
      return { ok: true, fixed: [], failed: [], rejected: [], changedFiles: [], spent: 1 };
    }
  };
  const deps = makeFixLoopDeps("/x", model, {}, { onProgress: sink, maxUnits: 1 }, impl);
  await deps.fix([], { branch: null, stayOnBranch: true, pass: 1 });
  assert.equal(fixOnProgress, sink, "the fix closure forwarded options.onProgress to runAuditFix (log sink live)");
});

test("makeFixLoopDeps threads agentTimeoutMs into runAuditFix's options (large-file writer budget)", async () => {
  // Regression for "reverted — write runner timed out": the policy sets agent_timeout_minutes (30min);
  // without this thread the loop writer fell back to realApplyFix's 300_000ms floor and every large-file
  // fix timed out before the test gate. Assert the fix closure forwards options.agentTimeoutMs.
  const model = { files: [{ id: "a.mjs", isTest: false }], graph: { importers: {} }, dupClusters: [] };
  let fixTimeout = "unset";
  const impl = {
    runAuditReview: async () => ({ findings: [], coverage: { unitsSelected: 0, budgetSpent: 1 } }),
    runAuditFix: async (_cwd, _findings, _backends, opts) => {
      fixTimeout = opts.agentTimeoutMs;
      return { ok: true, fixed: [], failed: [], rejected: [], changedFiles: [], spent: 1 };
    }
  };
  const deps = makeFixLoopDeps("/x", model, {}, { agentTimeoutMs: 1_800_000, maxUnits: 1 }, impl);
  await deps.fix([], { branch: null, stayOnBranch: true, pass: 1 });
  assert.equal(fixTimeout, 1_800_000, "the fix closure forwarded the policy agent timeout to the writer");
});

test("makeFixLoopDeps without a reporter passes reporter:undefined (NOOP fallback downstream)", async () => {
  const model = { files: [{ id: "a.mjs", isTest: false }], graph: { importers: {} }, dupClusters: [] };
  let reviewGot = "unset";
  const impl = {
    runAuditReview: async (_cwd, _model, _backends, opts) => {
      reviewGot = opts.reporter;
      return { findings: [], coverage: { unitsSelected: 0, budgetSpent: 1 } };
    },
    runAuditFix: async () => ({ ok: true, fixed: [], failed: [], rejected: [], changedFiles: [], spent: 1 })
  };
  const deps = makeFixLoopDeps("/x", model, {}, { maxUnits: 1 }, impl);
  await deps.review({ budget: 5, pass: 1, changedFiles: null });
  assert.equal(reviewGot, undefined, "no reporter → undefined → runAuditReview falls back to NOOP_REPORTER");
});
