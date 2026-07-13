// M10/C3 — endless SUPERVISOR.
//
// A single audit fix/endless loop invocation stops when it exhausts its per-run budget OR hits a
// rate limit its in-run retries can't outlast (a multi-hour reset). The SUPERVISOR wraps the loop so
// an autonomous whole-project run survives those gaps: on a RESUMABLE stop it WAITS reset-aware
// (until the limit resets, honoring a retry-after hint) then RESUMES the loop (--resume, from the
// checkpoint), until the loop reports a TERMINAL stop (converged / all-tiers / max-passes) or a
// wall-clock cap. Staging (structure clean → detail) is the per-tier convergence from B5, driven
// entirely inside runFixLoop itself — this module only supervises the reset-aware resume.
import { backoffMs, isRateLimitError, retryAfterFrom } from "./audit-retry.mjs";

// A TERMINAL convergence must NEVER be mistaken for resumable. Narrow to the real loop phrases only
// (council C3 grok P1): a bare `nothing` here over-matched resumable stops like "rate-limited —
// nothing left in window" and gave up with work remaining.
const TERMINAL_RE = /diminishing returns|all tiers converged|budget exhausted|max passes/i;
// "The review couldn't run this pass" (backends down / rate-limited-past-retries) — a resumable stop
// that isn't itself rate-limit ERROR text.
const DID_NOT_RUN_RE = /did not run|backends? unavailable|interrupted/i;

/**
 * True when a loop stopReason means "resume after a wait" rather than "done". Terminal wins. For
 * the rate-limit classification it DELEGATES to isRateLimitError (council C3 grok P1) so the
 * supervisor shares audit-retry's exact policy: PERMANENT quota/billing exhaustion is NOT resumable
 * (no ~24h unattended thrash on an insufficient_quota), and a bare "429" needs real status context
 * (not a stray line number). Only did-not-run + genuine transient rate limits resume.
 */
export function isResumableStop(stopReason) {
  if (typeof stopReason !== "string" || !stopReason) return false;
  if (TERMINAL_RE.test(stopReason)) return false;
  return DID_NOT_RUN_RE.test(stopReason) || isRateLimitError(stopReason);
}

/**
 * Reset-aware wait before the next resume: honor a retry-after hint on the loop's error/stop signal
 * (a real reset time), else exponential backoff by attempt. Bounded by backoffMs (default 30s..15m).
 */
export function resetAwareWaitMs(signal, attempt = 1, { baseMs, maxMs, factor } = {}) {
  return backoffMs(Math.max(1, attempt), { baseMs, maxMs, factor, retryAfterS: retryAfterFrom(signal) });
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
export async function runSupervised(runPass, { maxAttempts = 100, maxWallClockMs = 24 * 3600_000, maxDidNotRun = 3, baseMs, maxMs, factor, sleep, now, onWait } = {}) {
  if (typeof runPass !== "function") throw new Error("runSupervised requires a runPass function");
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now ?? (() => Date.now());
  const started = clock();
  let attempt = 0;
  // A PERMANENT quota/billing exhaustion is swallowed to ok:false at the cell layer (not thrown), so
  // the loop reports a generic "review did not run" stopReason — indistinguishable from a transient
  // outage by text alone. isResumableStop would then resume it up to maxAttempts/24h, thrashing on an
  // unrecoverable billing failure (council Opus O4 / Grok G4). Bound consecutive did-not-run resumes:
  // if the review can't run for maxDidNotRun tries in a row, no amount of waiting will help → terminal.
  let didNotRunStreak = 0;
  let last = null;
  let resume = false;
  while (attempt < Math.max(1, maxAttempts)) {
    attempt += 1;
    // A runPass that THROWS must never crash the unattended run (council C3 grok P2): a thrown
    // rate-limit error becomes a resumable stop (wait + resume); anything else a recorded terminal.
    try {
      last = await runPass({ resume, attempt });
    } catch (err) {
      last = { err, stopReason: `pass ${attempt} threw: ${String(err?.message ?? err)}` };
    }
    // A runPass that resolved to nothing (a wiring bug forgot to return) must surface as an ANOMALY,
    // not a silent "terminal" that looks like ordinary convergence on an unattended run (council C3
    // codex P2). Stop distinctly so an operator/report can flag it.
    if (last == null || typeof last !== "object") {
      return { attempts: attempt, stopReason: "runPass returned no result", supervisorStop: "aborted (runPass returned no result — anomaly)" };
    }
    const stop = last?.stopReason;
    // Explicit result flags WIN in both directions (council C3 grok P2): done OR an explicit
    // resumable:false forces a terminal stop; explicit resumable:true forces resume; otherwise infer
    // from the stopReason text / a rate-limit error.
    const resumable =
      last?.done === true || last?.resumable === false
        ? false
        : last?.resumable === true || isResumableStop(stop) || Boolean(last?.err && isRateLimitError(last.err));
    if (!resumable) return { ...last, attempts: attempt, supervisorStop: last?.done ? "done" : "terminal" };
    // Give up on a review that CANNOT run repeatedly (permanent quota / persistent outage): waiting
    // longer won't fix billing exhaustion. A genuine transient limit clears within a window or two.
    didNotRunStreak = DID_NOT_RUN_RE.test(stop ?? "") ? didNotRunStreak + 1 : 0;
    if (didNotRunStreak >= Math.max(1, maxDidNotRun)) {
      return { ...last, attempts: attempt, supervisorStop: `terminal — the review could not run ${didNotRunStreak} attempts in a row (likely permanent quota/outage, not a transient limit)` };
    }
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
