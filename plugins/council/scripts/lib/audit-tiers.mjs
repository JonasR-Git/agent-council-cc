// Tiered ordering + Tier-0 verdict gating (docs/enterprise-fix-design.md §3). Tier 0
// judges the design decision and PRUNES the mechanical tiers so effort is not spent
// polishing code that should be removed/redesigned; the mechanical tiers then run
// Structure -> Correctness -> Quality so a bug is found once (post-consolidation), not
// N times across copies. Pure DATA + pure functions: no I/O, no agents. The Tier-0
// verdict map is produced elsewhere (predicate detection + adversarial intent-defense);
// this module only orders findings by tier and decides how a verdict gates each fix.

import { getLens } from "./audit-lenses.mjs";

// Ordered tiers. Each runs to convergence before the next. Every lens maps to exactly
// one tier; a lens absent here falls back to the Quality tier (safe: lowest-stakes).
export const TIERS = [
  { id: 0, key: "logical", title: "Logical-sense", lenses: ["logical_sense"] },
  { id: 1, key: "structure", title: "Structure / SSOT", lenses: ["architecture_ssot", "dependencies_supply_chain"] },
  {
    id: 2,
    key: "correctness",
    title: "Correctness",
    lenses: ["correctness", "concurrency_resources", "security_secrets", "data_integrity", "config_cicd_security", "compliance_governance"]
  },
  { id: 3, key: "quality", title: "Quality", lenses: ["performance", "reliability_observability", "testing", "docs_maintainability"] }
];

const QUALITY_TIER = 3;
const TIER_OF_LENS = new Map();
for (const t of TIERS) for (const l of t.lenses) TIER_OF_LENS.set(l, t.id);

// Tier-0 verdicts over a unit (file/module). `keep` is the default; only the others
// gate mechanical work. Removal-class verdicts are proposals, never auto-applied.
export const VERDICTS = ["keep", "remove", "merge-into", "redesign", "relocate", "quarantine"];

// A P0 in one of these lenses, in reachable code, is ALWAYS processed regardless of a
// remove?/redesign? verdict — a live hole does not wait for a delete decision (§3).
export const SECURITY_OVERRIDE_LENSES = new Set(["security_secrets", "data_integrity"]);

/** Tier id for a lens; unknown lenses fall back to the Quality tier (lowest stakes). */
export function tierOfLens(lensId) {
  return TIER_OF_LENS.has(lensId) ? TIER_OF_LENS.get(lensId) : QUALITY_TIER;
}

const RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

/**
 * Order findings by tier (0->3), then by severity, then by file for stability. Returns
 * a new array; input is not mutated.
 */
export function orderByTier(findings = []) {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ta = tierOfLens(a.f.lens);
      const tb = tierOfLens(b.f.lens);
      if (ta !== tb) return ta - tb;
      const ra = RANK[a.f.severity] ?? RANK.P2;
      const rb = RANK[b.f.severity] ?? RANK.P2;
      if (ra !== rb) return ra - rb;
      const fa = String(a.f.file ?? a.f.location?.path ?? "");
      const fb = String(b.f.file ?? b.f.location?.path ?? "");
      return fa.localeCompare(fb) || a.i - b.i;
    })
    .map((x) => x.f);
}

/** Group findings into { tierId, title, findings[] } buckets, tier order preserved. */
export function groupByTier(findings = []) {
  return TIERS.map((t) => ({
    tierId: t.id,
    key: t.key,
    title: t.title,
    findings: findings.filter((f) => tierOfLens(f.lens) === t.id)
  }));
}

function fileOf(finding) {
  return String(finding?.file ?? finding?.location?.path ?? "");
}

/**
 * Decide how the mechanical tiers should treat one finding given the Tier-0 verdict of
 * its unit. `verdictMap` maps a file id -> { verdict, survivor? }. Returns
 * { action, to?, reason }:
 *   - process   : run the fix/proposal normally (default)
 *   - skip      : unit marked remove? -> don't spend effort here
 *   - redirect  : unit marked merge-into(X) -> route the fix to survivor X
 *   - suppress  : unit marked redesign? -> suppress Quality-tier polish only
 * P0-security override: an active security/data-integrity P0 is ALWAYS processed.
 */
export function tierAction(finding, verdictMap = {}, { securityLenses = SECURITY_OVERRIDE_LENSES } = {}) {
  const entry = verdictMap[fileOf(finding)];
  const verdict = entry?.verdict ?? "keep";

  if (finding.severity === "P0" && securityLenses.has(finding.lens)) {
    return { action: "process", reason: "P0-security override" };
  }

  switch (verdict) {
    case "remove":
      return { action: "skip", reason: "unit marked remove? — not worth fixing this pass" };
    case "merge-into":
      return { action: "redirect", to: entry?.survivor ?? null, reason: `merge-into ${entry?.survivor ?? "(survivor unset)"}` };
    case "redesign":
      return tierOfLens(finding.lens) === QUALITY_TIER
        ? { action: "suppress", reason: "redesign? — quality polish suppressed (shape will change)" }
        : { action: "process", reason: "redesign? — correctness still runs (propose mode)" };
    case "relocate":
    case "quarantine":
    case "keep":
    default:
      return { action: "process" };
  }
}

/**
 * Apply the verdict map across a finding set, annotating each with its tier and the
 * gate effect Tier 0 had on it (for the report's auditable "what was pruned" trail —
 * §3 gateEffect). Findings are returned tier-ordered.
 */
export function applyTierGating(findings = [], verdictMap = {}, opts = {}) {
  const gated = orderByTier(findings).map((f) => {
    const decision = tierAction(f, verdictMap, opts);
    return { ...f, tier: tierOfLens(f.lens), gateEffect: decision.action, gateReason: decision.reason ?? null, redirectedTo: decision.to ?? undefined };
  });
  return {
    findings: gated,
    process: gated.filter((f) => f.gateEffect === "process" || f.gateEffect === "redirect"),
    skipped: gated.filter((f) => f.gateEffect === "skip"),
    suppressed: gated.filter((f) => f.gateEffect === "suppress")
  };
}

/** Validate a lens->tier mapping covers every registered lens (guards drift). */
export function unmappedLenses(lensIds = []) {
  return lensIds.filter((id) => getLens(id) && !TIER_OF_LENS.has(id));
}
