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
const TRANSIENT_STATUS = new Set([429, 529, 503, 502, 504]);
const RATE_LIMIT_RE = /rate[ _-]?limit|too many requests|resource[ _-]?exhausted|overloaded|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|http[\s/]?(?:429|529|503|502|504)|(?:status|statuscode|code)[\s:=]*(?:429|529|503|502|504)/i;
// PERMANENT failures — billing/quota exhaustion, auth — must NEVER be retried, even when
// they carry an HTTP 429 (a quota 429 is not transient: retrying sleeps for hours then
// returns the same error). Checked FIRST, before any transient signal.
// Order-agnostic quota match ("quota exceeded" AND "exceeded your quota") plus the other
// permanent classes. Permanent → never retried, even with an HTTP 429.
const PERMANENT_RE = /insufficient[ _-]?quota|quota[\s\w]{0,20}(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached)[\s\w]{0,20}quota|billing|payment required|permission denied|invalid[ _-]?api[ _-]?key|unauthor(?:ized|ised)/i;

/** True if an error looks like a TRANSIENT rate-limit / overload the run can wait out. */
export function isRateLimitError(err) {
  if (err == null) return false;
  // Extract text from string, message, AND a nested error.message (SDKs wrap the real
  // message one level deep) so a nested permanent-quota error isn't stringified to "[object
  // Object]" and misread as transient.
  const text =
    typeof err === "string"
      ? err
      : String(err?.message ?? err?.error?.message ?? err?.error ?? err?.reason ?? "");
  const code = typeof err === "object" && err ? String(err.code ?? err.error?.code ?? "") : "";
  if (PERMANENT_RE.test(text) || PERMANENT_RE.test(code)) return false; // permanent → never retry
  if (typeof err === "number") return TRANSIENT_STATUS.has(err);
  if (typeof err === "string") return RATE_LIMIT_RE.test(err);
  const status = err.status ?? err.statusCode ?? err.code;
  if (TRANSIENT_STATUS.has(Number(status)) || status === "rate_limited") return true; // Number() catches string "429"
  return RATE_LIMIT_RE.test(text);
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
