import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAuditReview } from "../plugins/council/scripts/lib/audit-review.mjs";
import { buildCodebaseModel } from "../plugins/council/scripts/lib/codebase-model.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// Phase 2 / Task 2 — the review path must actually FEED the progress reporter (anti-facade:
// a wired path with no test proving the call is not wired). We run the REAL runAuditReview with
// injected seats (no CLI, no network) and a REAL makeProgressReporter whose writeFile is an
// in-memory sink, then assert the live lens table + unit progress the dashboard reads.

const OK = (payload) => ({ status: 0, stdout: JSON.stringify(payload), stderr: "", skipped: false });
const DOC = (findings) => ({ agent: "seat", summary: "s", verdict: "request_changes", findings });
const F = (over = {}) => ({ id: "f-1", severity: "P1", category: "bug", title: "t", detail: "d", file: null, line: null, confidence: 0.8, ...over });

const CLAUDE_ONLY = { codex: { companionAvailable: false }, grok: { cli: { available: false } }, claude: { cli: { available: true } } };

function repoFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-progress-review-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), 'import { help } from "./b.mjs";\nexport function main(){ return help(); }\n');
  fs.writeFileSync(path.join(dir, "b.mjs"), "export function help(){ return 42; }\n");
  return dir;
}

test("runAuditReview feeds the progress reporter: unit progress + per-lens findings matrix", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  // Two distinct lenses/severities so the aggregated matrix is meaningfully populated. This test
  // isolates the PER-UNIT fold, so the global reduce returns nothing (the reduce's own contribution
  // to the live matrix has its own focused test below); that keeps the counts "one per reviewed unit".
  const deps = {
    runClaude: async (prompt) =>
      String(prompt).includes("PROJECT-WIDE structure")
        ? OK(DOC([]))
        : OK(
            DOC([
              F({ id: "s-1", category: "security", severity: "P0", title: "sql injection in the query builder" }),
              F({ id: "t-1", category: "test", severity: "P2", title: "no test covers the error path" })
            ])
          )
  };

  const writes = [];
  const reporter = makeProgressReporter({
    kind: "audit-review",
    title: "audit review",
    stateDir: "C:/state",
    now: () => "2026-07-13T00:00:00.000Z",
    writeFile: (file, data) => writes.push({ file, data })
  });

  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false, reporter }, deps);

  // The return shape is unchanged (the reporter is purely additive telemetry).
  assert.equal(out.coverage.unitsReviewed, 2, "the review still returns its normal coverage");

  const snap = reporter.snapshot();
  assert.equal(snap.kind, "audit-review");
  assert.equal(snap.phase, "review", "the review phase was announced");
  assert.equal(snap.progress.unitsTotal, 2, "unitsTotal === the number of selected units");
  assert.equal(snap.progress.unitsDone, 2, "both units reported done");

  // The live lens table: findings aggregated by category(lens) + severity bucket.
  assert.ok(snap.findingsByLens.security, "the security lens is populated by category");
  assert.equal(snap.findingsByLens.security.total, 2, "one security finding per reviewed unit");
  assert.equal(snap.findingsByLens.security.P0, 2, "and both landed in the P0 bucket");
  assert.ok(snap.findingsByLens.test, "the test lens is populated too");
  assert.equal(snap.findingsByLens.test.total, 2);
  assert.equal(snap.findingsByLens.test.P2, 2);

  // The reporter actually PERSISTED to progress.json (the file a watcher reads), via the injected sink.
  assert.ok(writes.length > 0, "progress.json was written through the injected writeFile");
  assert.match(writes.at(-1).file, /progress\.json$/);
  const persisted = JSON.parse(writes.at(-1).data);
  assert.equal(persisted.progress.unitsTotal, 2, "the persisted snapshot carries the same unit progress");
  assert.equal(persisted.findingsByLens.security.total, 2, "and the same per-lens matrix");
});

test("runAuditReview folds the global reduce's UNIQUE findings into the live matrix, without double-counting reduce dupes", async () => {
  // Finding 3: the reduce's findings (SSOT/architecture — often the majority) were never folded into
  // the live per-lens matrix, so the dashboard under-reported vs the final output. The fold must add
  // the reduce's UNIQUE findings but NOT re-count a reduce finding that merely re-raises a unit one
  // (same dedup fingerprint the final output uses).
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const deps = {
    runClaude: async (prompt) =>
      String(prompt).includes("PROJECT-WIDE structure")
        ? OK(
            DOC([
              // (a) a DUPLICATE of the per-unit security finding (same file+title) — must be deduped away.
              F({ id: "s-dup", category: "security", severity: "P0", title: "sql injection in the query builder", file: "a.mjs" }),
              // (b) a reduce-ONLY architecture finding no unit raised — must appear in the live matrix.
              F({ id: "arch-1", category: "architecture", severity: "P1", title: "god object concentrates unrelated concerns", file: "a.mjs" })
            ])
          )
        : OK(DOC([F({ id: "s-1", category: "security", severity: "P0", title: "sql injection in the query builder", file: "a.mjs" })]))
  };

  const reporter = makeProgressReporter({ kind: "audit-review", title: "audit review", now: () => "2026-07-13T00:00:00.000Z" });
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false, reporter }, deps);

  assert.equal(out.coverage.reduceRan, true, "the global reduce actually ran this test");
  const snap = reporter.snapshot();
  // The reduce-only lens is now visible on the dashboard (was entirely absent before the fold).
  assert.ok(snap.findingsByLens.architecture, "the reduce-only architecture lens is folded into the live matrix");
  assert.equal(snap.findingsByLens.architecture.total, 1, "the unique reduce finding is counted once");
  assert.equal(snap.findingsByLens.architecture.P1, 1);
  // The reduce's DUPLICATE of the unit finding is NOT re-counted: two units folded security → total 2,
  // and the fingerprint-matching reduce dupe is filtered out (a broken fold would show 3 here).
  assert.equal(snap.findingsByLens.security.total, 2, "the reduce dupe is deduped, not double-counted");
});

test("finding 2: the unit bar advances for units that THROW (caught into failed) — never stalls at 0", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  // Every unit review throws → each is caught into `failed`. The old code advanced the bar only for
  // successfully-reviewed units and emitted NOTHING on the catch path, so the bar stalled at 0/2.
  const deps = { runClaude: async () => { throw new Error("seat exploded"); } };
  const reporter = makeProgressReporter({ kind: "audit-review", title: "audit review", now: () => "2026-07-13T00:00:00.000Z" });
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false, skipReduce: true, reporter }, deps);
  // Outcome unchanged (telemetry is additive): both units were selected and both failed.
  assert.equal(out.coverage.unitsSelected, 2);
  assert.equal(out.coverage.unitsReviewed, 0, "nothing reviewed OK");
  assert.equal(out.coverage.unitsFailed, 2);
  const snap = reporter.snapshot();
  assert.equal(snap.progress.unitsTotal, 2);
  assert.equal(snap.progress.unitsDone, 2, "the bar reached 100% — attempted (failed) units advance it too");
});

test("finding 2: the unit bar advances for units that review EMPTY (reviewed:false) — not just successful ones", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  // A non-zero seat run → no parseable doc → reviewUnit returns reviewed:false (dispatched but empty).
  // Such a unit lands in `results` but the OLD bar only counted results.filter(reviewed) → stalled at 0.
  const deps = { runClaude: async () => ({ status: 1, stdout: "", stderr: "boom", skipped: false }) };
  const reporter = makeProgressReporter({ kind: "audit-review", title: "audit review", now: () => "2026-07-13T00:00:00.000Z" });
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false, skipReduce: true, reporter }, deps);
  assert.equal(out.coverage.unitsReviewed, 0, "dispatched-but-empty units are not counted as reviewed");
  const snap = reporter.snapshot();
  assert.equal(snap.progress.unitsDone, 2, "empty-review units still advance the bar to unitsTotal");
  assert.equal(snap.progress.unitsTotal, 2);
});

test("runAuditReview without a reporter is unchanged (NOOP fallback, no throw)", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const deps = { runClaude: async () => OK(DOC([F({ title: "a finding" })])) };
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false }, deps);
  assert.equal(out.coverage.unitsReviewed, 2, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
