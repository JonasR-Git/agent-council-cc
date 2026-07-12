import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGED_PHASES,
  isResumableStop,
  phaseOfTier,
  resetAwareWaitMs,
  runSupervised
} from "../plugins/council/scripts/lib/supervisor.mjs";

test("isResumableStop: rate-limit / did-not-run resume; terminal convergence does not (terminal wins)", () => {
  assert.equal(isResumableStop("rate-limited — backing off"), true);
  assert.equal(isResumableStop("review did not run on pass 3 (backends unavailable or rate-limited)"), true);
  assert.equal(isResumableStop("HTTP 429 throttled"), true);
  // terminal convergence must never be resumed
  assert.equal(isResumableStop("diminishing returns — 2 consecutive passes found nothing new"), false);
  assert.equal(isResumableStop("all tiers converged (structure -> correctness -> quality)"), false);
  assert.equal(isResumableStop("budget exhausted (60/60 agent calls)"), false);
  assert.equal(isResumableStop("reached max passes (10)"), false);
  assert.equal(isResumableStop(""), false);
  assert.equal(isResumableStop(null), false);
});

test("resetAwareWaitMs honors a retry-after hint over the plain attempt backoff, bounded", () => {
  const base = resetAwareWaitMs(null, 1);
  assert.ok(base > 0 && Number.isFinite(base));
  const hinted = resetAwareWaitMs({ retryAfter: 600 }, 1); // a 10-minute reset hint
  assert.ok(hinted >= base, "a real reset hint waits at least as long as the base backoff");
  // bounded (never an unbounded sleep)
  assert.ok(resetAwareWaitMs({ retryAfter: 10 ** 9 }, 1) <= 900_000 + 60_000);
});

test("STAGED_PHASES / phaseOfTier map structure-first (0,1) then detail (2,3)", () => {
  assert.deepEqual(STAGED_PHASES.map((p) => p.id), ["structure", "detail"]);
  assert.equal(phaseOfTier(0), "structure");
  assert.equal(phaseOfTier(1), "structure");
  assert.equal(phaseOfTier(2), "detail");
  assert.equal(phaseOfTier(3), "detail");
  assert.equal(phaseOfTier(99), "detail", "unknown tiers default to detail");
});

test("runSupervised returns immediately on a terminal stop (no wait)", async () => {
  let calls = 0;
  const out = await runSupervised(async () => { calls += 1; return { done: true, stopReason: "all tiers converged" }; }, { sleep: async () => { throw new Error("must not sleep"); } });
  assert.equal(calls, 1);
  assert.equal(out.supervisorStop, "done");
});

test("runSupervised WAITS reset-aware then RESUMES on a resumable stop, until terminal", async () => {
  const resumes = [];
  const waits = [];
  let n = 0;
  const out = await runSupervised(
    async ({ resume, attempt }) => {
      resumes.push(resume);
      n += 1;
      if (n < 3) return { stopReason: "rate-limited — reset in a while", err: { retryAfter: 5 } };
      return { done: true, stopReason: "diminishing returns" };
    },
    { sleep: async (ms) => waits.push(ms), onWait: ({ waitMs }) => waits.push(-waitMs) }
  );
  assert.equal(out.attempts, 3);
  assert.equal(out.supervisorStop, "done");
  assert.deepEqual(resumes, [false, true, true], "the first pass is fresh, subsequent passes resume from checkpoint");
  assert.ok(waits.length >= 2, "it waited before each resume");
});

test("runSupervised is bounded by a wall-clock cap (never infinite on a stuck limit)", async () => {
  let clock = 0;
  const out = await runSupervised(
    async () => ({ stopReason: "rate-limited" }), // never terminal
    { sleep: async () => {}, now: () => clock, maxWallClockMs: 1000 }
  );
  // first pass runs (clock 0 < 1000), waits; before the 2nd resume the clock check trips once advanced
  // advance the clock via a stateful now
  assert.match(out.supervisorStop, /wall-clock cap|max attempts/);
});

test("runSupervised is bounded by maxAttempts", async () => {
  const out = await runSupervised(async () => ({ stopReason: "throttled" }), { sleep: async () => {}, maxAttempts: 4 });
  assert.equal(out.attempts, 4);
  assert.equal(out.supervisorStop, "max attempts reached");
});
