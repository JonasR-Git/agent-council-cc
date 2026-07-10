// Honest coverage accounting (docs/audit-schema.md §4, blocker 3). "mapped" (a file
// was inventoried) NEVER implies "parsed"/"reviewed". Budget exhaustion yields an
// explicit `indeterminate` gate rather than a false "complete". Pure functions.

// Increasing depth of coverage for one (file, lens) unit.
const STATES = ["uncovered", "mapped", "parsed", "reviewed", "verified"];

/**
 * Tail hotspot rank H = 100·((e+(1-e)C)(e+(1-e)Ch)(e+(1-e)B)(e+(1-e)Sm))^¼, e=0.05.
 * Each input is a 0..1 normalized signal; the e floor keeps a zero factor from
 * zeroing the whole score. Mandatory units always outrank the tail (handled by caller).
 */
export function tailScore({ complexity = 0, churn = 0, blastRadius = 0, smell = 0 } = {}, e = 0.05) {
  const t = (x) => e + (1 - e) * Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  return Math.round(100 * Math.pow(t(complexity) * t(churn) * t(blastRadius) * t(smell), 1 / 4));
}

/**
 * Reduce per-(file,lens) unit records to an honest summary: counts per depth, the
 * mandatory-surface completion, and the explicit uncovered list with reasons. A unit
 * only counts as mandatory-done when verified (or reviewed when it needs no verify).
 */
export function summarizeCoverage(units = []) {
  const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
  const uncovered = [];
  let mandatoryTotal = 0;
  let mandatoryDone = 0;
  for (const u of units) {
    const st = STATES.includes(u.state) ? u.state : "uncovered";
    byState[st] += 1;
    // mapped but not parsed/reviewed still counts as NOT reviewed
    if (st === "uncovered" || st === "mapped") uncovered.push({ file: u.file, lens: u.lens, reason: u.reason ?? st });
    if (u.mandatory) {
      mandatoryTotal += 1;
      const done = st === "verified" || (st === "reviewed" && !u.requiresVerification);
      if (done) mandatoryDone += 1;
    }
  }
  return {
    total: units.length,
    byState,
    mandatory: { total: mandatoryTotal, done: mandatoryDone, complete: mandatoryTotal === 0 || mandatoryDone === mandatoryTotal },
    uncovered
  };
}

/**
 * Gate verdict. `indeterminate` when the mandatory surface or required verification
 * is incomplete (budget/tool limits) — never a false pass; `fail` on any NEW P0/P1;
 * else `pass`.
 */
export function gateStatus({ mandatory, newHighSeverity = 0, verificationComplete = true } = {}) {
  const mandatoryComplete = mandatory ? mandatory.complete !== false : true;
  if (!mandatoryComplete || !verificationComplete) return "indeterminate";
  return newHighSeverity > 0 ? "fail" : "pass";
}
