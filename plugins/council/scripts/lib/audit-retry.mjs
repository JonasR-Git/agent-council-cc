// Rate-limit-aware retry for the autonomous fix loop. When a review/fix phase fails
// because a backend is rate-limited (429/529/quota), an unattended run should NOT stop
// dead — it should back off and retry so the loop survives a transient limit. Pure +
// injectable (sleep is a dep) so the backoff/retry logic is unit-tested without waiting.

const RATE_LIMIT_RE = /rate[ _-]?limit|too many requests|quota|resource[ _-]?exhausted|overloaded|\b429\b|\b529\b/i;

/** True if an error looks like a transient rate-limit / overload the run can wait out. */
export function isRateLimitError(err) {
  if (err == null) return false;
  if (typeof err === "number") return err === 429 || err === 529;
  if (typeof err === "string") return RATE_LIMIT_RE.test(err);
  const status = err.status ?? err.statusCode ?? err.code;
  if (status === 429 || status === 529 || status === "rate_limited" || status === "insufficient_quota") return true;
  const msg = String(err.message ?? err.error ?? err.reason ?? "");
  return RATE_LIMIT_RE.test(msg);
}

/**
 * Exponential backoff (1-based attempt), capped. If the error carries an explicit
 * retry-after hint (seconds or a Retry-After-like field), that wins — up to maxMs.
 */
export function backoffMs(attempt, { baseMs = 30_000, maxMs = 900_000, factor = 2, retryAfterS = null } = {}) {
  const hinted = Number(retryAfterS);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(maxMs, Math.round(hinted * 1000));
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, Math.round(baseMs * factor ** (n - 1)));
}

function retryAfterFrom(err) {
  if (!err || typeof err !== "object") return null;
  const v = err.retryAfter ?? err.retry_after ?? err.retryAfterSeconds ?? err.headers?.["retry-after"];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Run `fn`; on a rate-limit error, back off and retry up to `retries` times. Any
 * NON-rate-limit error propagates immediately (no retry). A rate-limit error that
 * outlives all retries is rethrown so the caller can stop + checkpoint. `sleep` is
 * injectable for tests; `onRetry({attempt, ms, err})` reports each backoff.
 */
export async function retryOnRateLimit(fn, { retries = 5, baseMs, maxMs, factor, sleep, onRetry } = {}) {
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      attempt += 1;
      if (attempt > retries) throw err;
      const ms = backoffMs(attempt, { baseMs, maxMs, factor, retryAfterS: retryAfterFrom(err) });
      if (onRetry) {
        try {
          onRetry({ attempt, ms, err });
        } catch {
          /* reporting must never break the retry */
        }
      }
      await doSleep(ms);
    }
  }
}
