// SSOT for the BETWEEN-PASS quota-guard DECISION, shared by BOTH review loops (audit-fixloop's
// fix-until-dry loop AND audit-endless's review loop). The loops own the I/O (reading a usage
// snapshot) and the orchestration (checkpoint / wait / break / emit the resume contract); THIS module
// is the pure, clock-free, fs-free DECISION they share so the evaluate logic is never copy-pasted:
// given a snapshot, does --usage-ceiling breach (weekly HARD stop) and does --pause-at-5h pause (the
// soft 5h stop — schedulable? a resume→re-pause thrash? autonomous?).
//
// It REUSES evaluateCeiling / evaluatePause5h — it never reimplements their logic — so FAIL-SOFT is
// inherited verbatim: an unknown / unavailable / stale snapshot yields no breach and no pause. That
// invariant is load-bearing: a flaky quota read must never stop or pause a long unattended run.

import { evaluateCeiling, evaluatePause5h } from "./usage-guard.mjs";
import { hashLite } from "./util.mjs";

// The autonomous 5h pause waits IN-PROCESS to a KNOWN future reset. Cap the wait so a wrong/rolled
// resetsAt can never turn into an indefinite/absurd sleep: max = maxAheadMs (5h15m) + the pause buffer
// (2m). evaluatePause5h already refuses to mark anything past this bound schedulable; this is the
// belt-and-suspenders bound at each loop's sleep site (shared so both loops use the same ceiling).
export const MAX_AUTONOMOUS_WAIT_MS = 5 * 3600e3 + 17 * 60e3;

/**
 * The 5h-window signature both loops key the anti-thrash guard on: `model@resetsAt` for every blocker,
 * order-independent. A resume that re-pauses on the SAME signature has NOT crossed a real reset. PURE.
 */
export function pauseWindowSig(blockers) {
  return (blockers ?? []).map((b) => `${b.model}@${b.resetsAt ?? "?"}`).sort().join(",");
}

/**
 * Pure between-pass guard decision. The snapshot I/O stays in the caller, so this is unit-testable with
 * no clock and no fs. Returns `{ ceiling, pause }`:
 *  - `ceiling`: null when no --usage-ceiling; else `{ breached, breaches, unavailable }` straight from
 *    evaluateCeiling (fail-soft — only an AVAILABLE model at/over its WEEKLY ceiling breaches; an
 *    unknown/unavailable model never does).
 *  - `pause`: null when --pause-at-5h is off OR the snapshot does not pause; else
 *    `{ paused:true, schedulable, resumeAt, blockers, threshold, autonomous, thrash, windowSig, pauseId }`.
 *    `thrash` is true ONLY when a prior pause's `prevWindowSig` matches this pause's window AND no durable
 *    progress was made since (the caller supplies `madeProgress` — fix-loop: more durable fixes; endless:
 *    more accumulated findings). A thrash is a resume→re-pause spin on the same still-full window and must
 *    hard-stop for manual attention instead of waiting/exiting into the same loop again. `pauseId` is
 *    derived from `pauseIdSeed` + a thrash/resumeAt discriminator + the window signature (scheduler
 *    idempotency). PURE — reuses evaluatePause5h for the schedulability/blocker decision.
 */
export function evaluateBetweenPassGuards({
  usageCeiling = null,
  pause5h = null,
  snapshot = null,
  nowMs = Date.now(),
  prevWindowSig = null,
  madeProgress = false,
  pauseIdSeed = ""
} = {}) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};

  // --usage-ceiling: the weekly HARD stop. evaluateCeiling is fail-soft (unknown never breaches).
  const ceiling = usageCeiling ? evaluateCeiling(snap, usageCeiling) : null;

  // --pause-at-5h: the soft 5h pause. evaluatePause5h is fail-soft/total (unknown/null-5h never pauses).
  let pause = null;
  if (pause5h && pause5h.enabled) {
    const p = evaluatePause5h(snap, pause5h.threshold, { nowMs });
    if (p.paused) {
      const windowSig = pauseWindowSig(p.blockers);
      // Anti-thrash = SAME window as the last pause AND no forward progress since. When either differs
      // it is a legitimate (first / post-progress) pause, not a spin.
      const thrash = prevWindowSig != null && prevWindowSig === windowSig && madeProgress === false;
      // pauseId keeps the fix-loop's EXACT construction (byte-identical): a thrash keys on the window
      // signature (a same-window spin), a normal pause on its resume clock. Both are scheduler-idempotent.
      const pauseId = thrash
        ? hashLite(`${pauseIdSeed}|thrash|${windowSig}`)
        : hashLite(`${pauseIdSeed}|${p.resumeAt ?? "manual"}`);
      pause = {
        paused: true,
        schedulable: p.schedulable,
        resumeAt: p.resumeAt,
        blockers: p.blockers,
        threshold: pause5h.threshold,
        autonomous: Boolean(pause5h.autonomous),
        thrash,
        windowSig,
        pauseId
      };
    }
  }

  return { ceiling, pause };
}
