// Evidence-backed risk model (docs/audit-schema.md §3). Pure + auditable: every
// component is retained, confidence is DERIVED from evidence state (not a model's
// self-rating), and the false-positive rate carries a zero-dep Wilson 95% interval
// so sparse data is never shown as precision.

const SEV_SCORE = { P0: 10, P1: 7, P2: 4, nit: 1 };
const SEV_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

// Evidence state -> confidence CAP (candidate side) or FLOOR (verified side).
// "refuted" = an independent verifier could NOT support this finding → the LOWEST cap (it stays visible
// as a disputed candidate, but must never outrank an unrefuted one; council Fable P1).
const CONFIDENCE_CAP = { refuted: 0.2, "regex-only": 0.35, "deterministic-unproven": 0.55, "one-finder": 0.65, "independent-agreement": 0.8 };
const CONFIDENCE_FLOOR = { "adversarial-verified": 0.85, reproduced: 0.95 };

/** Confidence derived from evidence state, clamping a proposed value to the cap/floor. */
export function deriveConfidence(state, proposed = 0.6) {
  const p = Math.max(0, Math.min(1, Number.isFinite(proposed) ? proposed : 0.6));
  if (state in CONFIDENCE_CAP) return Math.min(p, CONFIDENCE_CAP[state]);
  if (state in CONFIDENCE_FLOOR) return Math.max(p, CONFIDENCE_FLOOR[state]);
  return p;
}

const clamp15 = (n) => Math.max(1, Math.min(5, Number.isFinite(Number(n)) ? Math.round(Number(n)) : 3));

/**
 * rawRisk = 100·(S/10)·(L/5)·(B/5)·(E/5); calibrated = raw·(0.25 + 0.75·C).
 * Returns both plus every component so the number is auditable.
 */
export function riskScore({ severity, likelihood, blastRadius, exploitability, confidence } = {}) {
  const S = SEV_SCORE[severity] ?? SEV_SCORE.P2;
  const L = clamp15(likelihood);
  const B = clamp15(blastRadius);
  const E = clamp15(exploitability);
  const C = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.6));
  const raw = 100 * (S / 10) * (L / 5) * (B / 5) * (E / 5);
  const confidenceFactor = 0.25 + 0.75 * C;
  // Keep raw at full precision (auditable); round only the calibrated score.
  return { raw, calibrated: Math.round(raw * confidenceFactor), components: { S, L, B, E, C } };
}

/**
 * Wilson 95% interval for a proportion (zero-dep). Null unless n is a positive
 * integer, successes an integer in [0,n], and z finite/positive — degenerate inputs
 * (e.g. successes>n) would otherwise yield NaN bounds.
 */
export function wilson(successes, n, z = 1.96) {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (!Number.isInteger(successes) || successes < 0 || successes > n) return null;
  if (!Number.isFinite(z) || z <= 0) return null;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return { rate: phat, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin), n };
}

/**
 * Observed false-positive rate = refuted_fp / (confirmed + refuted_fp), with a Wilson
 * 95% interval + sample size. Null when there is nothing resolved yet (no precision
 * theatre on an empty sample).
 */
export function falsePositiveRate(confirmed, refutedFp) {
  const n = (confirmed || 0) + (refutedFp || 0);
  return wilson(refutedFp || 0, n);
}

// Active (gate-relevant) lifecycle states rank before resolved ones.
const STATE_ORDER = { confirmed: 0, verification_required: 1, candidate: 2, inconclusive: 3, fixed: 4, refuted: 5 };

/**
 * Rank a register: active gate-relevant findings first, then calibratedRisk desc,
 * then severity, then confidence desc. Never reorders by confidence ahead of risk.
 */
export function rankRegister(findings = []) {
  const cal = (f) => (Number.isFinite(f.risk?.calibrated) ? f.risk.calibrated : riskScore(f).calibrated);
  return [...findings].sort((a, b) => {
    const sa = STATE_ORDER[a.lifecycle] ?? 2;
    const sb = STATE_ORDER[b.lifecycle] ?? 2;
    if (sa !== sb) return sa - sb;
    const ra = cal(a);
    const rb = cal(b);
    if (ra !== rb) return rb - ra;
    const va = SEV_RANK[a.severity] ?? 2;
    const vb = SEV_RANK[b.severity] ?? 2;
    if (va !== vb) return va - vb;
    return (b.risk?.components?.C ?? 0) - (a.risk?.components?.C ?? 0);
  });
}
