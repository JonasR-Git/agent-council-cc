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
  // Two distinct lenses/severities so the aggregated matrix is meaningfully populated.
  const deps = {
    runClaude: async () =>
      OK(
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

test("runAuditReview without a reporter is unchanged (NOOP fallback, no throw)", async () => {
  const dir = repoFixture();
  const model = buildCodebaseModel(dir);
  const deps = { runClaude: async () => OK(DOC([F({ title: "a finding" })])) };
  const out = await runAuditReview(dir, model, CLAUDE_ONLY, { budget: 6, maxUnits: 2, ledger: false, verifyAudit: false }, deps);
  assert.equal(out.coverage.unitsReviewed, 2, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
