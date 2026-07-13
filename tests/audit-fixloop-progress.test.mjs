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
