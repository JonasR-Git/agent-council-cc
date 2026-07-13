import assert from "node:assert/strict";
import test from "node:test";

import { runEndless } from "../plugins/council/scripts/lib/audit-endless.mjs";
import { makeProgressReporter, mutedFindingsReporter } from "../plugins/council/scripts/lib/progress.mjs";

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

test("finding 10: an endless pass advances unitsDone LIVE via the muted-findings reporter, without double-counting findingsByLens", async () => {
  const { reporter } = reporterWithSink();
  // This mirrors the companion wiring: the per-pass review gets a MUTED-findings reporter so it can drive
  // per-unit PROGRESS live inside a pass, while runEndless remains the ONLY place that folds each pass's
  // deduped findings (reporter.findings(fresh)). The review here emits per-unit progress AND folds its own
  // findings through the muted wrapper — the latter must be a no-op so the count isn't doubled.
  const passReporter = mutedFindingsReporter(reporter);
  const review = async ({ pass }) => {
    passReporter.progress({ unitsDone: 1, unitsTotal: 2 });
    const finding = { severity: "P1", category: "bug", file: `m${pass}.mjs`, title: `distinct problem ${pass} alpha` };
    passReporter.findings([finding]); // MUTED — must NOT fold into findingsByLens
    passReporter.progress({ unitsDone: 2, unitsTotal: 2 });
    return { findings: [finding], coverage: { budgetSpent: 1 } };
  };
  const out = await runEndless("/x", { maxPasses: 2, dryStreak: 5, budget: 100, reporter }, { review, checkpoint: noCheckpoint });
  assert.equal(out.passesRun, 2);

  const snap = reporter.snapshot();
  // Per-unit progress fired LIVE inside the pass (forwarded by the muted wrapper to the real reporter).
  assert.equal(snap.progress.unitsDone, 2, "per-unit progress advanced live inside a pass");
  assert.equal(snap.progress.unitsTotal, 2);
  assert.equal(snap.progress.passesDone, 2, "pass-level progress advanced too");
  // Each pass's fresh finding was counted EXACTLY once (runEndless's fold), not twice — the muted inner
  // fold did nothing. A broken mute would show 4 here (2 inner + 2 from runEndless).
  assert.equal(snap.findingsByLens.bug.total, 2, "one bug per pass — no double-count");
});

test("runEndless without a reporter is unchanged (NOOP fallback)", async () => {
  const review = async ({ pass }) => ({ findings: [{ severity: "P2", file: `m${pass}.mjs`, title: `t${pass}` }], coverage: { budgetSpent: 1 } });
  const out = await runEndless("/x", { maxPasses: 2, dryStreak: 5, budget: 50 }, { review, checkpoint: noCheckpoint });
  assert.equal(out.passesRun, 2, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
