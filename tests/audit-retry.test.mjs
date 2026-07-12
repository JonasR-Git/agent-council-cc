import assert from "node:assert/strict";
import test from "node:test";

import { backoffMs, isRateLimitError, retryOnRateLimit } from "../plugins/council/scripts/lib/audit-retry.mjs";

test("isRateLimitError recognizes the common shapes, ignores unrelated errors", () => {
  assert.equal(isRateLimitError(new Error("Rate limit exceeded")), true);
  assert.equal(isRateLimitError(new Error("HTTP 429 Too Many Requests")), true);
  assert.equal(isRateLimitError({ status: 429 }), true);
  assert.equal(isRateLimitError({ status: 529 }), true);
  assert.equal(isRateLimitError({ status: 503 }), true);
  assert.equal(isRateLimitError("resource_exhausted"), true);
  assert.equal(isRateLimitError(529), true);
  assert.equal(isRateLimitError(new Error("ENOENT: no such file")), false);
  assert.equal(isRateLimitError(new Error("tests failed after fix")), false);
  assert.equal(isRateLimitError(null), false);
  // PERMANENT exhaustion must NOT be retried (would sleep for hours then fail)
  assert.equal(isRateLimitError({ code: "insufficient_quota" }), false);
  assert.equal(isRateLimitError(new Error("disk quota exceeded")), false);
  // a BARE numeric token must not trigger (e.g. a stack frame "line 429")
  assert.equal(isRateLimitError(new Error("error at line 429 in file")), false);
});

test("backoffMs is exponential and capped; an explicit retry-after hint wins", () => {
  assert.equal(backoffMs(1, { baseMs: 1000, factor: 2 }), 1000);
  assert.equal(backoffMs(2, { baseMs: 1000, factor: 2 }), 2000);
  assert.equal(backoffMs(3, { baseMs: 1000, factor: 2 }), 4000);
  assert.equal(backoffMs(99, { baseMs: 1000, factor: 2, maxMs: 5000 }), 5000, "capped at maxMs");
  assert.equal(backoffMs(1, { baseMs: 1000, retryAfterS: 12 }), 12000, "retry-after hint honored");
  assert.equal(backoffMs(1, { baseMs: 1000, retryAfterS: 9999, maxMs: 3000 }), 3000, "hint still capped");
});

test("retryOnRateLimit retries a rate-limited fn then succeeds, sleeping between", async () => {
  const sleeps = [];
  let calls = 0;
  const result = await retryOnRateLimit(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("429 rate limit");
      return "ok";
    },
    { retries: 5, baseMs: 100, factor: 2, sleep: async (ms) => sleeps.push(ms) }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200], "backed off before each retry");
});

test("retryOnRateLimit rethrows a NON-rate-limit error immediately (no retry)", async () => {
  let calls = 0;
  await assert.rejects(
    () => retryOnRateLimit(async () => { calls += 1; throw new Error("tests failed"); }, { retries: 5, sleep: async () => {} }),
    /tests failed/
  );
  assert.equal(calls, 1, "non-rate-limit error is not retried");
});

test("retryOnRateLimit gives up after `retries` and rethrows the rate-limit error", async () => {
  let calls = 0;
  const seen = [];
  await assert.rejects(
    () => retryOnRateLimit(
      async () => { calls += 1; throw new Error("HTTP 429 rate limit exceeded"); },
      { retries: 2, baseMs: 10, sleep: async () => {}, onRetry: (i) => seen.push(i.attempt) }
    ),
    /429/
  );
  assert.equal(calls, 3, "initial try + 2 retries");
  assert.deepEqual(seen, [1, 2]);
});
