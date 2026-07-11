// Assemble the audit-report envelope (docs/audit-schema.md §8) from canonical findings
// + per-(file,lens) coverage units. Pure: ranks the risk register, splits propose-only
// items, summarizes coverage, computes the gate and the false-positive rate. The output
// validates against schemas/audit-report.schema.json.

import { gateStatus, summarizeCoverage } from "./audit-coverage.mjs";
import { falsePositiveRate, rankRegister } from "./audit-risk.mjs";

// A finding counts against the gate only when it is a CONFIRMED P0/P1 that is not a
// pre-accepted baseline/waiver (baseline "new" or unset).
function isNewHigh(f) {
  const active = f.baseline == null || f.baseline === "new";
  return active && (f.severity === "P0" || f.severity === "P1") && f.lifecycle === "confirmed";
}

/**
 * @param canonicalFindings audit-finding[] (already normalized)
 * @param coverageUnits     [{ file, lens, state, mandatory, requiresVerification }]
 * @param meta              { generatedAt, target, provenance, verificationComplete,
 *                            confirmedCount, refutedFp }
 */
export function assembleReport(canonicalFindings = [], coverageUnits = [], meta = {}) {
  const { generatedAt = null, target = null, provenance = {}, verificationComplete = true, confirmedCount = 0, refutedFp = 0 } = meta;
  const coverage = summarizeCoverage(coverageUnits);
  const newHighSeverity = canonicalFindings.filter(isNewHigh).length;
  const gate = {
    status: gateStatus({ mandatory: coverage.mandatory, newHighSeverity, verificationComplete }),
    newHighSeverity
  };
  // Register = all findings ranked; proposals = the cross-cutting/propose-only subset
  // (never auto-fixed) surfaced separately for the human.
  const register = rankRegister(canonicalFindings);
  const proposals = register.filter((f) => f.fixDisposition === "propose-only");
  return {
    schemaVersion: 1,
    generatedAt,
    target: target ?? {},
    gate,
    register,
    proposals,
    coverage,
    falsePositiveRate: falsePositiveRate(confirmedCount, refutedFp),
    governance: {},
    provenance
  };
}
