import assert from "node:assert/strict";
import test from "node:test";

import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

const finding = (o) => ({ lens: "correctness", severity: "P1", ...o });
const noCheckpoint = () => {};
const CEILING = { claude: 40, codex: 50, grok: 40 };

const underSnap = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 5, tokens: {} }, grok: { available: false } });
const overCodexSnap = () => ({ claude: { available: false, weekPercent: null }, codex: { available: true, weekPercent: 80, tokens: {} }, grok: { available: false } });

// The LOAD-BEARING stop: a confirmed between-pass breach ends the loop with a usage-ceiling reason.
test("--usage-ceiling STOPS the loop between passes on a confirmed breach (over on pass 2)", async () => {
  let p = 0;
  // Each pass raises a NEW finding + fixes it → the loop would never converge dry on its own.
  const review = async () => ({ findings: [finding({ file: "a.mjs", title: `bug ${p++}` })], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  let usageCalls = 0;
  const readUsage = async () => {
    usageCalls += 1;
    return usageCalls >= 2 ? overCodexSnap() : underSnap();
  };
  const out = await runFixLoop("/x", { budget: 40, maxPasses: 10, dryStreak: 5, usageCeiling: CEILING }, { review, fix, readUsage, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /usage-ceiling/);
  assert.match(out.stopReason, /codex 80%≥50% \(weekly\)/);
  assert.equal(out.passesRun, 2, "ran pass 1 (under ceiling) then stopped after pass 2 (over)");
});

test("--usage-ceiling under the ceiling → the loop runs to its normal convergence (no usage stop)", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  const readUsage = async () => underSnap();
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2, usageCeiling: CEILING }, { review, fix, readUsage, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /diminishing returns/);
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""), "an under-ceiling run never stops on usage");
});

test("--usage-ceiling: a THROWING readUsage never crashes or stops the loop (fail-soft)", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  const readUsage = async () => {
    throw new Error("provider network down");
  };
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2, usageCeiling: CEILING }, { review, fix, readUsage, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /diminishing returns/, "a usage-read failure is treated as not-breached");
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""));
});

test("--usage-ceiling: an UNAVAILABLE (available:false) model never trips the stop, even at 99%", async () => {
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  const readUsage = async () => ({ claude: { available: false, weekPercent: 99 }, codex: { available: false, weekPercent: 99 }, grok: { available: false, weekPercent: 99 } });
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2, usageCeiling: CEILING }, { review, fix, readUsage, checkpoint: noCheckpoint });
  assert.ok(!/usage-ceiling/.test(out.stopReason ?? ""), "unknown usage can never stop the loop");
});

test("--usage-ceiling: the loop stashes each pass's usage snapshot into progress state (reporter.usage)", async () => {
  const reporter = makeProgressReporter({ kind: "audit-fix-loop", stateDir: null });
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  const readUsage = async () => underSnap();
  await runFixLoop("/x", { budget: 40, dryStreak: 2, usageCeiling: CEILING, reporter }, { review, fix, readUsage, checkpoint: noCheckpoint });
  const s = reporter.snapshot();
  assert.ok(s.usage, "the latest usage snapshot is on the progress state");
  assert.equal(s.usage.codex.weekPercent, 5);
  assert.deepEqual(s.usageCeiling, CEILING);
});

test("no --usage-ceiling → readUsage is never called (zero overhead when the guard is off)", async () => {
  let usageCalls = 0;
  let p = 0;
  const review = async () => (p++ === 0 ? { findings: [finding({ file: "a.mjs", title: "bug" })], coverage: { budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } });
  const fix = async (actionable) => ({ fixed: actionable.map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: ["a.mjs"], spent: 1 });
  const readUsage = async () => {
    usageCalls += 1;
    return underSnap();
  };
  await runFixLoop("/x", { budget: 40, dryStreak: 2 }, { review, fix, readUsage, checkpoint: noCheckpoint });
  assert.equal(usageCalls, 0, "with no ceiling the loop never reads usage");
});

// --- reporter.usage round-trip (progress.mjs writer side) ---------------------
test("reporter.usage round-trips a compact snapshot + ceiling; a bare call keeps the earlier ceiling", () => {
  const reporter = makeProgressReporter({ kind: "audit-fix-loop", stateDir: null });
  reporter.usage(
    {
      claude: { available: true, weekPercent: 1, fiveHourPercent: 6, weekResetsAt: "2026-07-20T00:00:00Z", tokens: { out: 250, in: 1000, total: 1250 } },
      codex: { available: true, weekPercent: 14, weekResetsAt: null, tokens: { out: 1, in: 2, total: 3 } },
      grok: { available: false, weekPercent: null, tokens: { total: 0 } }
    },
    { claude: 40, codex: 50, grok: 40 }
  );
  let s = reporter.snapshot();
  assert.equal(s.usage.claude.weekPercent, 1);
  assert.equal(s.usage.claude.fiveHourPercent, 6);
  assert.equal(s.usage.claude.weekResetsAt, "2026-07-20T00:00:00Z");
  assert.deepEqual(s.usage.claude.tokens, { out: 250, in: 1000, total: 1250 });
  assert.equal(s.usage.codex.weekPercent, 14);
  assert.equal(s.usage.grok.available, false);
  assert.deepEqual(s.usageCeiling, { claude: 40, codex: 50, grok: 40 });

  // A subsequent bare usage(snapshot) must NOT wipe the earlier ceiling.
  reporter.usage({ codex: { available: true, weekPercent: 20, tokens: {} } });
  s = reporter.snapshot();
  assert.equal(s.usage.codex.weekPercent, 20);
  assert.deepEqual(s.usageCeiling, { claude: 40, codex: 50, grok: 40 }, "a bare usage() keeps the prior ceiling");

  // A garbage/empty snapshot compacts to null (never leaks junk into progress.json).
  reporter.usage({ bogus: true });
  assert.equal(reporter.snapshot().usage, null);
});
