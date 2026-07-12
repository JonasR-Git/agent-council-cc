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

test("isResumableStop (council C3 grok P1): PERMANENT quota is NOT resumable; a 429 needs real context", () => {
  // permanent billing/quota exhaustion → give up, never a 24h unattended retry thrash
  assert.equal(isResumableStop("review error on pass 1: insufficient_quota"), false);
  assert.equal(isResumableStop("fix error on pass 2: exceeded your current quota, please add billing"), false);
  // a bare line number that happens to be 429 is not a rate limit
  assert.equal(isResumableStop("review error on pass 1: Expected token at line 429"), false);
  // a genuinely transient rate limit still resumes, even with the word "nothing" in it
  assert.equal(isResumableStop("rate-limited — nothing left in this window, backing off"), true);
});

test("resetAwareWaitMs honors a retry-after hint over the plain attempt backoff, bounded", () => {
  const base = resetAwareWaitMs(null, 1);
  assert.ok(base > 0 && Number.isFinite(base));
  const hinted = resetAwareWaitMs({ retryAfter: 600 }, 1); // a 10-minute reset hint
  assert.ok(hinted >= base, "a real reset hint waits at least as long as the base backoff");
  // bounded (never an unbounded sleep)
  assert.ok(resetAwareWaitMs({ retryAfter: 10 ** 9 }, 1) <= 900_000 + 60_000);
});

test("runSupervised (council C3 codex P2): a null runPass result surfaces as an ANOMALY, not a silent terminal", async () => {
  const out = await runSupervised(async () => null, { sleep: async () => {} });
  assert.match(out.supervisorStop, /anomaly/, "a malformed pass is flagged, not mistaken for convergence");
  assert.equal(out.stopReason, "runPass returned no result");
});

test("STAGED_PHASES / phaseOfTier map structure-first (0,1) then detail (2,3)", () => {
  assert.deepEqual(STAGED_PHASES.map((p) => p.id), ["structure", "detail"]);
  // council C3 codex P2: the phase title reflects that tier 0 (Logical) is included, not tier 1's exact name
  assert.match(STAGED_PHASES[0].title, /Logical/);
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
    { sleep: async (ms) => { clock += ms; }, now: () => clock, maxWallClockMs: 100_000, baseMs: 60_000, maxAttempts: 1000 }
  );
  assert.equal(out.supervisorStop, "wall-clock cap reached", "the 24h-style wall-clock branch is actually exercised");
});

test("runSupervised: an explicit resumable:false forces a terminal stop even with a rate-limit stopReason", async () => {
  let calls = 0;
  const out = await runSupervised(async () => { calls += 1; return { stopReason: "rate-limited", resumable: false }; }, { sleep: async () => { throw new Error("must not wait"); } });
  assert.equal(calls, 1, "a hard-stop wins over the rate-limit text");
  assert.equal(out.supervisorStop, "terminal");
});

test("runSupervised: a thrown rate-limit error resumes; a non-rate-limit throw stops terminally (no crash)", async () => {
  // rate-limit throw → wait + resume, then succeed
  let n = 0;
  const okAfterLimit = await runSupervised(
    async () => { n += 1; if (n < 2) throw Object.assign(new Error("HTTP 429 rate limit"), { status: 429 }); return { done: true, stopReason: "all tiers converged" }; },
    { sleep: async () => {} }
  );
  assert.equal(okAfterLimit.supervisorStop, "done");
  assert.equal(n, 2, "the rate-limit throw was retried");
  // a non-rate-limit throw is recorded terminally, never crashes the unattended run
  const crashed = await runSupervised(async () => { throw new Error("null deref in the loop"); }, { sleep: async () => {} });
  assert.equal(crashed.supervisorStop, "terminal");
  assert.match(crashed.stopReason, /threw: .*null deref/);
});

test("runSupervised is bounded by maxAttempts", async () => {
  const out = await runSupervised(async () => ({ stopReason: "rate-limited — still throttled" }), { sleep: async () => {}, maxAttempts: 4 });
  assert.equal(out.attempts, 4);
  assert.equal(out.supervisorStop, "max attempts reached");
});
