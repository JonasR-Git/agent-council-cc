import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFixLoop } from "../plugins/council/scripts/lib/audit-fixloop.mjs";
import { findingsStorePath, makeFindingsAppender, readFindingsStore } from "../plugins/council/scripts/lib/audit-findings-store.mjs";
import { USAGE_TTL_MS, makeMidPassGuard } from "../plugins/council/scripts/lib/audit-midpass-guard.mjs";

const finding = (o) => ({ lens: "correctness", severity: "P1", ...o });
const noCheckpoint = () => {};
const NOW = Date.parse("2026-07-13T00:00:00Z");
const RESET = Date.parse("2026-07-13T02:00:00Z");
const isoOf = (ms) => new Date(ms).toISOString();
const PAUSE_ON = { enabled: true, threshold: 85, autonomous: false };
const PAUSE_AUTO = { enabled: true, threshold: 85, autonomous: true };
const okFix = async (actionable) => ({ fixed: (actionable ?? []).map((f) => ({ file: f.file, finding: f, commit: "x" })), failed: [], branch: "council/x", changedFiles: [], spent: 1 });

const pauseObj = (over) => ({
  paused: true,
  schedulable: true,
  resumeAt: isoOf(RESET + 120000),
  blockers: [{ model: "claude", percent: 92, threshold: 85, resetsAt: isoOf(RESET) }],
  threshold: 85,
  autonomous: over,
  thrash: false,
  windowSig: `claude@${isoOf(RESET)}`,
  pauseId: "pid-1"
});

// SSOT: a MID-PASS ceiling quiesce emits the SAME terminal usage-ceiling stopReason the between-pass path
// does — and does NOT fix the incomplete band.
test("mid-pass CEILING quiesce → same usage-ceiling stop, band NOT fixed, partial findings preserved", async () => {
  const review = async () => ({
    findings: [finding({ file: "a.mjs", title: "partial bug" })],
    coverage: { quiesced: { kind: "ceiling", breaches: [{ model: "codex", percent: 80, ceiling: 50, window: "weekly" }] }, budgetSpent: 5 }
  });
  let fixCalls = 0;
  const fix = async (a) => { fixCalls += 1; return okFix(a); };
  const cps = [];
  const out = await runFixLoop("/x", { budget: 40, maxPasses: 10, dryStreak: 5 }, { review, fix, checkpoint: (s) => cps.push(s) });
  assert.match(out.stopReason, /usage-ceiling/);
  assert.match(out.stopReason, /codex 80%≥50% \(weekly\)/, "identical message shape to the between-pass ceiling stop");
  assert.equal(fixCalls, 0, "a quiesced (incomplete) review band is never fixed");
  assert.equal(out.passesRun, 1);
  assert.ok(cps.some((c) => (c.reviewed ?? []).some((f) => f.title === "partial bug")), "partial findings are checkpointed (preserved for resume)");
  assert.ok(cps.some((c) => c.quiesced === true), "the quiesce checkpoint records the pass as quiesced (resume redoes the band)");
});

// SSOT: a MID-PASS 5h pause quiesce yields the SAME out.pause contract the between-pass pause emits.
test("mid-pass PAUSE quiesce (non-autonomous) → the SAME out.pause contract, band NOT fixed", async () => {
  const review = async () => ({
    findings: [finding({ file: "a.mjs", title: "partial" })],
    coverage: { quiesced: { kind: "pause", pause: pauseObj(false) }, budgetSpent: 5 }
  });
  let fixCalls = 0;
  const fix = async (a) => { fixCalls += 1; return okFix(a); };
  const out = await runFixLoop("/x", { budget: 40, maxPasses: 10, dryStreak: 5, pause5h: PAUSE_ON }, { review, fix, now: () => NOW, checkpoint: noCheckpoint });
  assert.ok(out.pause, "the mid-pass pause surfaces the SAME machine-readable pause the companion emits as exit-75");
  assert.equal(out.pause.schedulable, true);
  assert.equal(out.pause.resumeAt, isoOf(RESET + 120000));
  assert.equal(out.pause.pauseId, "pid-1");
  assert.equal(fixCalls, 0, "no fix on the incomplete band");
  assert.match(out.stopReason, /quota-pause/);
});

// SSOT + checkpoint-resume: an AUTONOMOUS pause quiesce waits IN-PROCESS then continues the SAME loop;
// the resumed pass completes and the run converges with NO exit-75 pause.
test("mid-pass PAUSE quiesce (autonomous) → waits in-process then resumes + converges (no out.pause)", async () => {
  let p = 0;
  const review = async () =>
    p++ === 0
      ? { findings: [finding({ file: "a.mjs", title: "partial" })], coverage: { quiesced: { kind: "pause", pause: pauseObj(true) }, budgetSpent: 5 } }
      : { findings: [], coverage: { budgetSpent: 1 } };
  const sleeps = [];
  const out = await runFixLoop(
    "/x",
    { budget: 40, maxPasses: 10, dryStreak: 2, pause5h: PAUSE_AUTO },
    { review, fix: okFix, now: () => NOW, sleep: async (ms) => sleeps.push(ms), checkpoint: noCheckpoint }
  );
  assert.equal(sleeps.length, 1, "it waited exactly once, in-process (did not exit)");
  assert.equal(sleeps[0], RESET + 120000 - NOW, "the wait runs until resumeAt (reset + buffer) — same as between-pass");
  assert.equal(out.pause, undefined, "an autonomous wait that resumed then converged returns NO pause");
  assert.match(out.stopReason, /diminishing returns|budget|max passes/);
});

// A STALE-beyond-TTL quiesce (the hard ceiling can't fail-soft forever) → terminal stop, no fix.
test("mid-pass STALE-ceiling quiesce → terminal stop mentioning unreadable/stale usage, no fix", async () => {
  const review = async () => ({ findings: [], coverage: { quiesced: { kind: "stale-ceiling", ageMs: 300000, ttlMs: 240000 }, budgetSpent: 3 } });
  let fixCalls = 0;
  const fix = async (a) => { fixCalls += 1; return okFix(a); };
  const out = await runFixLoop("/x", { budget: 40, maxPasses: 10, dryStreak: 5 }, { review, fix, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /unreadable\/stale/);
  assert.equal(fixCalls, 0);
});

// FAIL-CLOSED: if the durable store can't be opened, autonomous fixing must not run at all.
test("fail-closed: an unwritable durable store STOPS the loop before any fix (no untracked mutation)", async () => {
  let fixCalls = 0;
  let reviewCalls = 0;
  const review = async () => { reviewCalls += 1; return { findings: [finding({ file: "a.mjs", title: "b" })], coverage: { budgetSpent: 1 } }; };
  const fix = async (a) => { fixCalls += 1; return okFix(a); };
  const requireDurableStore = () => { throw new Error("EROFS: read-only file system"); };
  const out = await runFixLoop("/x", { budget: 40, dryStreak: 2, failClosedFindings: true }, { review, fix, requireDurableStore, checkpoint: noCheckpoint });
  assert.match(out.stopReason, /fails closed/);
  assert.equal(fixCalls, 0, "no fix is applied when findings can't be durably recorded");
  assert.equal(reviewCalls, 0, "the loop never even reviews — it is terminal before the first pass");
});

// Grok-1 REGRESSION PIN (nowIso): the fix-loop constructs the durable appender bound to the REAL nowIso
// import (state.mjs) — NO options.nowIso here, so this exercises the actual companion path the earlier
// tests missed by stubbing the clock. Pre-fix nowIso was unbound in audit-fixloop.mjs → the append
// closure threw ReferenceError at write time → audit-findings.jsonl stayed EMPTY. Now the finding lands
// durably with a real ISO timestamp.
test("Grok-1 (nowIso): the durable-findings append uses the REAL nowIso (no injected clock) — records actually land", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixloop-nowiso-"));
  const review = async ({ findingsAppender }) => {
    // review flushes to the appender runFixLoop wired (real makeFindingsAppender + real bound nowIso).
    findingsAppender.append([{ severity: "P1", lens: "correctness", category: "bug", title: "real-clock bug", file: "a.mjs", line: 1 }], { pass: 1 });
    return { findings: [], coverage: { budgetSpent: 1 } };
  };
  const out = await runFixLoop(cwd, { budget: 8, dryStreak: 1, maxPasses: 2, durableFindings: true }, { review, fix: okFix, checkpoint: noCheckpoint });
  const recs = readFindingsStore(findingsStorePath(cwd));
  assert.equal(recs.length, 1, "the finding landed durably — the real nowIso path did not throw a ReferenceError");
  assert.ok(!Number.isNaN(Date.parse(recs[0].ts)), "the record carries a real ISO timestamp from the bound nowIso");
  assert.ok(!/review error/.test(out.stopReason ?? ""), "the append did not blow up the pass");
});

// Claude-P2a REGRESSION PIN (wiring half): a FRESH (non-resume) run resets the durable store (prior-run
// findings gone); a --resume KEEPS it. Uses the REAL store on disk, seeded with a prior-run record.
test("P2a: a fresh run starts with an EMPTY durable store (prior findings gone); a --resume keeps them", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixloop-reset-"));
  const seed = () => makeFindingsAppender(findingsStorePath(cwd)).append([{ severity: "P1", lens: "correctness", category: "bug", title: "prior-run bug", file: "old.mjs", line: 1 }]);
  const review = async () => ({ findings: [], coverage: { budgetSpent: 1 } });
  // FRESH run: the pre-seeded store must be wiped before the appender is constructed.
  seed();
  assert.equal(readFindingsStore(findingsStorePath(cwd)).length, 1, "the prior run left a record");
  await runFixLoop(cwd, { budget: 8, dryStreak: 1, maxPasses: 1, durableFindings: true }, { review, fix: okFix, loadCheckpoint: () => null, checkpoint: noCheckpoint });
  assert.equal(readFindingsStore(findingsStorePath(cwd)).length, 0, "a fresh run reset the store — no cross-run contamination / unbounded growth");
  // RESUME run: the store is preserved.
  seed();
  await runFixLoop(cwd, { budget: 8, dryStreak: 1, maxPasses: 1, durableFindings: true, resume: true }, { review, fix: okFix, loadCheckpoint: () => ({ fixed: [] }), checkpoint: noCheckpoint });
  assert.equal(readFindingsStore(findingsStorePath(cwd)).length, 1, "a --resume keeps the store (its dedupe bridges the interrupted run)");
});

// Claude-P2b REGRESSION PIN (run-wide): with usage persistently UNREADABLE across several SMALL passes
// (each well under USAGE_TTL_MS) and a ceiling configured, the hard-ceiling stale-TTL now quiesces once
// accrued staleness passes the TTL — the clock persists across the per-pass guard rebuild. Uses the REAL
// makeMidPassGuard so the seeding/carry-back wiring is exercised end-to-end.
test("P2b: a hard ceiling quiesces RUN-WIDE once staleness accrues past the TTL across small passes", async () => {
  const CEILING = { codex: 50 };
  let t = Date.parse("2026-07-13T00:00:00Z");
  const PER_PASS_MS = 60e3; // ~1 min per pass — far under the 4-min USAGE_TTL_MS (the bug's condition)
  const stubCursor = { isDone: () => false, markDone: () => {}, reset: () => {}, size: () => 0, keys: () => [] };
  let passes = 0;
  const review = async ({ guard }) => {
    passes += 1;
    await guard.beforeCell({}); // one pre-dispatch check at this small pass's start
    t += PER_PASS_MS; // the pass runs ~1 min
    return guard.quiesce ? { findings: [], coverage: { quiesced: guard.quiesce, budgetSpent: 1 } } : { findings: [], coverage: { budgetSpent: 1 } };
  };
  const out = await runFixLoop(
    "/x",
    { budget: 100, maxPasses: 30, dryStreak: 50, usageCeiling: CEILING, midPassGuard: true },
    { review, fix: okFix, now: () => t, readUsage: async () => { throw new Error("usage endpoint down"); }, makeGuard: makeMidPassGuard, reviewCursor: stubCursor, checkpoint: noCheckpoint }
  );
  assert.match(out.stopReason, /unreadable\/stale/, "the hard ceiling quiesced once run-wide staleness passed the TTL — not stuck forever in the small-pass loop");
  assert.ok(passes > USAGE_TTL_MS / PER_PASS_MS, `it took several small passes to accrue past the TTL (ran ${passes})`);
});

// A (accumulated-evidence gating): a finding from a PRIOR pass (in the durable ledger) still influences
// THIS pass's gating even though the small pass didn't re-surface it.
test("A: the gate sees the accumulated ledger, not just this small pass's findings", async () => {
  const seen = [];
  const gate = (findings) => { seen.push(findings.map((f) => f.title)); return { actionable: [], surfaced: [], skipped: [], suppressed: [] }; };
  const review = async () => ({ findings: [finding({ file: "b.mjs", title: "pass2 bug" })], coverage: { budgetSpent: 1 } });
  await runFixLoop(
    "/x",
    { budget: 4, maxPasses: 1, dryStreak: 5 },
    { review, fix: okFix, gate, accumulatedFindings: () => [finding({ file: "a.mjs", title: "pass1 ledger bug" })], checkpoint: noCheckpoint }
  );
  assert.ok(seen[0].includes("pass2 bug") && seen[0].includes("pass1 ledger bug"), "the gate input is the UNION of this pass + the accumulated ledger");
});
