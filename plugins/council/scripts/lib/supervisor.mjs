// M10/C3 — endless SUPERVISOR + staged whole-project phases.
//
// A single audit fix/endless loop invocation stops when it exhausts its per-run budget OR hits a
// rate limit its in-run retries can't outlast (a multi-hour reset). The SUPERVISOR wraps the loop so
// an autonomous whole-project run survives those gaps: on a RESUMABLE stop it WAITS reset-aware
// (until the limit resets, honoring a retry-after hint) then RESUMES the loop (--resume, from the
// checkpoint), until the loop reports a TERMINAL stop (converged / all-tiers / max-passes) or a
// wall-clock cap. Staging (structure clean → detail) is the per-tier convergence from B5; this
// module just names the phases for the report + supervises the reset-aware resume.
import { backoffMs, isRateLimitError, retryAfterFrom } from "./audit-retry.mjs";

// Loop stopReasons that mean "work remains but is BLOCKED right now" (retry after a wait) vs a
// terminal convergence. Kept conservative: only known transient/throttle/did-not-run phrasings.
const RESUMABLE_RE = /rate.?limit|throttl|\b429\b|\b529\b|overload|quota|did not run|backends? unavailable|interrupted/i;
// A TERMINAL convergence must never be mistaken for resumable, even if its text brushes a keyword.
const TERMINAL_RE = /diminishing returns|all tiers converged|budget exhausted|max passes|nothing/i;

/** True when a loop stopReason means "resume after a wait" rather than "done". Terminal wins. */
export function isResumableStop(stopReason) {
  if (typeof stopReason !== "string" || !stopReason) return false;
  if (TERMINAL_RE.test(stopReason)) return false;
  return RESUMABLE_RE.test(stopReason);
}

/**
 * Reset-aware wait before the next resume: honor a retry-after hint on the loop's error/stop signal
 * (a real reset time), else exponential backoff by attempt. Bounded by backoffMs (default 30s..15m).
 */
export function resetAwareWaitMs(signal, attempt = 1, { baseMs, maxMs, factor } = {}) {
  return backoffMs(Math.max(1, attempt), { baseMs, maxMs, factor, retryAfterS: retryAfterFrom(signal) });
}

// The staged whole-project phases: STRUCTURE first (tiers 0 Logical + 1 Structure/SSOT) so a
// consolidation lands before DETAIL (tiers 2 Correctness + 3 Quality) runs on the consolidated code
// — a bug is then found once, post-consolidation, not N times across copies (the B5 per-tier order).
export const STAGED_PHASES = Object.freeze([
  { id: "structure", title: "Structure / SSOT", tiers: [0, 1] },
  { id: "detail", title: "Detail (correctness → quality)", tiers: [2, 3] }
]);

/** Which staged phase a tier belongs to (structure = 0/1, detail = 2/3; unknown → detail). */
export function phaseOfTier(tier) {
  return STAGED_PHASES.find((p) => p.tiers.includes(tier))?.id ?? "detail";
}

/**
 * Supervise a loop across rate-limit gaps. `runPass({ resume, attempt })` runs ONE loop invocation
 * and returns its result: `{ stopReason, done?, resumable?, err?, ... }`. The supervisor:
 *  - returns immediately on a TERMINAL stop (done, or a non-resumable stopReason);
 *  - on a RESUMABLE stop (rate-limited / did-not-run / an err that isRateLimitError), WAITS
 *    reset-aware then re-runs with resume:true (the loop reloads its checkpoint);
 *  - is bounded by maxAttempts and maxWallClockMs (both fail-safe caps, never infinite).
 * `sleep`/`now` are injectable for tests; `onWait` reports each backoff. Returns the last pass
 * result plus `attempts` and `supervisorStop`.
 */
export async function runSupervised(runPass, { maxAttempts = 100, maxWallClockMs = 24 * 3600_000, baseMs, maxMs, factor, sleep, now, onWait } = {}) {
  if (typeof runPass !== "function") throw new Error("runSupervised requires a runPass function");
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now ?? (() => Date.now());
  const started = clock();
  let attempt = 0;
  let last = null;
  let resume = false;
  while (attempt < Math.max(1, maxAttempts)) {
    attempt += 1;
    last = await runPass({ resume, attempt });
    const stop = last?.stopReason;
    // Explicit result flags win; else infer from the stopReason text or a rate-limit error.
    const resumable =
      last?.done === true
        ? false
        : last?.resumable === true || isResumableStop(stop) || Boolean(last?.err && isRateLimitError(last.err));
    if (!resumable) return { ...last, attempts: attempt, supervisorStop: last?.done ? "done" : "terminal" };
    if (clock() - started >= maxWallClockMs) return { ...last, attempts: attempt, supervisorStop: "wall-clock cap reached" };
    const waitMs = resetAwareWaitMs(last?.err ?? stop, attempt, { baseMs, maxMs, factor });
    if (onWait) {
      try {
        onWait({ attempt, waitMs, stopReason: stop });
      } catch {
        /* reporting must never break the supervisor */
      }
    }
    await doSleep(waitMs);
    resume = true;
  }
  return { ...last, attempts: attempt, supervisorStop: "max attempts reached" };
}
