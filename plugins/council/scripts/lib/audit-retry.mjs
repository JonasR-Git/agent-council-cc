// Rate-limit-aware retry for the autonomous fix loop. When a review/fix phase fails
// because a backend is rate-limited (429/529/quota), an unattended run should NOT stop
// dead — it should back off and retry so the loop survives a transient limit. Pure +
// injectable (sleep is a dep) so the backoff/retry logic is unit-tested without waiting.

// Match rate-limit / overload signals while avoiding false positives: a BARE numeric
// "429" (e.g. "line 429") and a generic "quota" (disk EDQUOT: "quota exceeded" is fine,
// bare "quota" is not) must NOT trigger a retry. 429/529/503 count only with HTTP/status
// context; 503 / service-unavailable (overloaded upstream) is included.
// Only TRANSIENT throttling/overload — never PERMANENT exhaustion. "insufficient_quota" /
// "quota exceeded" (billing or disk) is permanent and must NOT be retried (it would sleep
// for hours then return the same error). Bare numeric "429" (e.g. "line 429") is excluded;
// 429/529/503 count only with http/status context. 503 / service-unavailable is included.
const RATE_LIMIT_RE = /rate[ _-]?limit|too many requests|resource[ _-]?exhausted|overloaded|service unavailable|temporarily unavailable|http[\s/]?(?:429|529|503)|(?:status|statuscode|code)[\s:=]*(?:429|529|503)/i;

/** True if an error looks like a TRANSIENT rate-limit / overload the run can wait out. */
export function isRateLimitError(err) {
  if (err == null) return false;
  if (typeof err === "number") return err === 429 || err === 529 || err === 503;
  if (typeof err === "string") return RATE_LIMIT_RE.test(err);
  const status = err.status ?? err.statusCode ?? err.code;
  if (status === 429 || status === 529 || status === 503 || status === "rate_limited") return true;
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
