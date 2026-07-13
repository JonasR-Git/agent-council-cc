import assert from "node:assert/strict";
import test from "node:test";

import { runEndless } from "../plugins/council/scripts/lib/audit-endless.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// Phase 2 / Task 4 — the endless review loop must FEED the progress reporter per pass (anti-facade:
// a test must prove the reporter is reached). Everything is injected: deps.review + a real reporter.

const noCheckpoint = () => {};

function reporterWithSink() {
  const writes = [];
  const reporter = makeProgressReporter({
    kind: "audit-endless",
    title: "audit endless",
    stateDir: "C:/state",
    now: () => "2026-07-13T00:00:00.000Z",
    writeFile: (file, data) => writes.push({ file, data })
  });
  return { reporter, writes };
}

test("runEndless drives phase/progress/budget/findings per pass", async () => {
  const { reporter, writes } = reporterWithSink();
  // Each pass finds ONE distinct new finding (a fresh category so the lens matrix accumulates).
  const review = async ({ pass }) => ({
    findings: [{ severity: "P1", category: "bug", file: `m${pass}.mjs`, title: `distinct problem number ${pass} alpha` }],
    coverage: { budgetSpent: 1 }
  });
  const out = await runEndless("/x", { maxPasses: 3, dryStreak: 5, budget: 100, reporter }, { review, checkpoint: noCheckpoint });
  assert.equal(out.passesRun, 3);

  const snap = reporter.snapshot();
  assert.equal(snap.phase, "review", "each pass announces the review phase");
  assert.equal(snap.phaseDetail, "pass 3", "the last pass detail is carried");
  assert.equal(snap.progress.passesDone, 3);
  assert.equal(snap.progress.passesTotal, 3, "passesTotal === maxPasses ceiling");
  assert.equal(snap.findingsByLens.bug.total, 3, "three passes folded three bug findings into the live matrix");
  assert.ok(snap.budget && snap.budget.total === 100, "the run budget is reported");
  assert.ok(writes.length > 0, "progress.json was persisted through the injected writeFile");
});

test("runEndless without a reporter is unchanged (NOOP fallback)", async () => {
  const review = async ({ pass }) => ({ findings: [{ severity: "P2", file: `m${pass}.mjs`, title: `t${pass}` }], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 2, dryStreak: 5, budget: 50 }, { review, checkpoint: noCheckpoint });
  assert.equal(out.passesRun, 2, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
