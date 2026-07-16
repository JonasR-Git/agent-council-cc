// SSOT for `audit fix --loop`'s runFixLoop options. Pure: no I/O, no clock, no defaults read from disk.
//
// Why this module exists (it is a bug fix, not tidying): the CLI used to build this object INLINE inside a
// ~3000-line command handler, where no test could reach it. So all 12 loop/fix test files hand-rebuilt their
// own approximation — 165 call sites, none of which was ever compared against the real thing. They drifted,
// and the drift was invisible: tests/audit-fixloop-structure.test.mjs threaded the structure consent ONLY
// into the runAuditFix impl seam, while the CLI ALSO puts it here (`structureAutoApply`). Every loop-level
// decision keyed on that flag — the tier floor, the tier plan's per-tier `fix`, the correlate exemption —
// was therefore exercised in a configuration the CLI never runs. Result: a green suite over a feature that
// was dead in production for 17 passes (see 9ce65a7).
//
// Tests that need realistic loop options MUST call this, not hand-roll one: then a divergence between what
// the CLI runs and what the suite proves is impossible BY CONSTRUCTION rather than merely "tested for".

import { NOOP_REPORTER } from "./progress.mjs";

/**
 * Build the options object the CLI passes to runFixLoop. Every caller-varying value is a named input;
 * everything the autonomous `fix` profile pins unconditionally (midPassGuard / durableFindings /
 * failClosedFindings / correlate) is set here, so it cannot be forgotten by a caller.
 */
export function buildLoopOpts({
  budget,
  maxPasses,
  dryStreak,
  maxUnits,
  flat = false,
  structureAutoApply = false,
  epochSweep = false,
  baseBranch = null,
  retryOnLimit = undefined,
  retryLimit = undefined,
  logicalProposals = [],
  usageCeiling = undefined,
  usageSince = undefined,
  pause5h = undefined,
  reporter = NOOP_REPORTER,
  importers = {}
} = {}) {
  const rep = reporter ?? NOOP_REPORTER;
  return {
    budget,
    maxPasses,
    dryStreak,
    maxUnits,
    perTierConvergence: !flat,
    // F-B: thread the structure consent into the loop so runFixLoop derives a CAPABILITY-AWARE FIRST_TIER.
    // Without this the loop's static floor (2) filtered every tier-0/1 structure finding out BEFORE fix()
    // saw it, so `audit fix --loop --structure-auto-apply` silently no-op'd the enabled transformer (only
    // --flat worked). The runAuditFix impl seam's `structureAutoApply:true` stays — that consents the
    // PER-PASS fixer; THIS consents the tier FLOOR. Both are required; that split is exactly what the old
    // hand-rolled test harness got wrong.
    structureAutoApply,
    // WAVE 2: pin the sweep mode + the ledger's true base branch into the run so runFixLoop drives
    // scheduling/tier-advance off the durable ledger and a resume can't flip the mode.
    epochSweep,
    ledgerBaseBranch: baseBranch,
    retryOnLimit,
    retryLimit,
    logicalProposals,
    usageCeiling,
    usageSince,
    pause5h,
    reporter: rep,
    onProgress: rep.line,
    // B: the mid-pass checkpoint-and-resume quota guard — on the grouped path a quota breach quiesces the
    // pass (finish the in-flight cell, flush partial findings + cursor) and emits the SAME hard-stop / pause
    // the between-pass backstop does. Inert on the per-file path (no cells).
    midPassGuard: true,
    // C: durable findings SSOT (audit-findings.jsonl) — the grouped review appends each finding as
    // discovered; the gate reads the accumulated ledger; the dashboard tails it. Autonomous FIXING fails
    // CLOSED if the store can't be opened (no untracked fix ever lands).
    durableFindings: true,
    failClosedFindings: true,
    // D: deterministic correlation — one writer per same-file cluster; multi-file / cross-cutting / SSOT
    // clusters escalate to proposal instead of a symptom fix. Uses the model's import graph. NOTE: with
    // structureAutoApply consented, structure-class findings are EXEMPT from that escalation (9ce65a7) —
    // they must reach fix() to be offered to the M9 multi-file writer.
    correlate: true,
    correlateImporters: importers
  };
}
