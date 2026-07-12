import assert from "node:assert/strict";
import test from "node:test";

import { assembleFixMeta, changedFilesShape } from "../plugins/council/scripts/lib/fix-report-meta.mjs";

const sampleOut = () => ({
  branch: "council/audit-fix-abc1234",
  baseBranch: "master",
  fixed: [
    { finding: { severity: "P1", category: "bug", title: "t1" }, file: "a.mjs", verified: true },
    { finding: { severity: "P1", category: "concurrency", title: "t2" }, file: "b.mjs", verified: true, council: { approved: true, verdicts: [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "confirm" }] } }
  ],
  rejected: [{ finding: { severity: "P2", category: "design", title: "t3" }, reason: "cross-cutting → propose-only" }],
  failed: [{ finding: { severity: "P2", category: "bug", title: "t4" }, file: "d.mjs", reason: "tests failed after fix" }],
  skipped: []
});

test("assembleFixMeta: metrics derive from the fix result + timing (no seat instrumentation → zeros)", () => {
  const meta = assembleFixMeta(sampleOut(), { wallClockMs: 5000, autonomy: "aggressive", sensitiveAutoApply: true });
  assert.ok(meta.metrics, "metrics present");
  assert.equal(meta.metrics.wallClockMs, 5000);
  assert.equal(meta.metrics.autonomy, "aggressive");
  assert.equal(meta.metrics.sensitiveAutoApply, true);
  assert.ok(meta.metrics.totals, "outcome totals present");
  assert.ok(meta.metrics.gates, "gate funnel present");
  assert.ok(meta.metrics.council, "council tally present");
  assert.ok(meta.metrics.seats, "seat map present (zeroed without instrumentation)");
  assert.equal(meta.shape, undefined, "no shape without before/after");
});

test("assembleFixMeta: a before/after shape + numstat produces the shape delta", () => {
  const before = { files: 2, lines: 100, codeLines: 90, functions: 10, branches: 6, complexity: 20 };
  const after = { files: 2, lines: 80, codeLines: 72, functions: 8, branches: 4, complexity: 16 };
  const meta = assembleFixMeta(sampleOut(), { shapeBefore: before, shapeAfter: after, numstat: "10\t40\ta.mjs\n5\t5\tb.mjs\n" });
  assert.ok(meta.shape, "shape present when before+after supplied");
  assert.equal(meta.shape.linesAdded, 15, "git churn added parsed from numstat (10+5)");
  assert.equal(meta.shape.linesRemoved, 45, "git churn removed parsed (40+5)");
  assert.equal(meta.shape.complexity, -4, "complexity delta 16-20");
});

test("changedFilesShape: before/after computed per ref; a source change is reflected", () => {
  const readAt = (ref, p) => (ref === "base" ? "function f(a){ if (a) { return 1; } return 2; }\nfunction g(){}" : "function f(a){ return a ? 1 : 2; }");
  const { before, after } = changedFilesShape(["a.mjs"], "base", "head", readAt);
  assert.ok(before.functions >= after.functions, "the head removed a function");
  assert.equal(before.files, 1);
  assert.equal(after.files, 1);
});

test("changedFilesShape: FAIL-SOFT — a git-read error contributes an empty side, never throws", () => {
  const readAt = (ref) => { if (ref === "base") throw new Error("git show failed (renamed)"); return "const x = 1;"; };
  const { before, after } = changedFilesShape(["renamed.mjs"], "base", "head", readAt);
  assert.equal(before.files, 1, "the unreadable base side is an empty file, not a crash");
  assert.equal(after.files, 1);
});
