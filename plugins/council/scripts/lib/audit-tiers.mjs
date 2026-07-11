// Tiered ordering + Tier-0 verdict gating (docs/enterprise-fix-design.md §3). Tier 0
// judges the design decision and PRUNES the mechanical tiers so effort is not spent
// polishing code that should be removed/redesigned; the mechanical tiers then run
// Structure -> Correctness -> Quality so a bug is found once (post-consolidation), not
// N times across copies. Pure DATA + pure functions: no I/O, no agents. The Tier-0
// verdict map is produced elsewhere (predicate detection + adversarial intent-defense);
// this module only orders findings by tier and decides how a verdict gates each fix.
//
// Contract (hardened after the M2 council review):
//  - Verdicts are looked up by AST-anchored fingerprint FIRST (survives Tier-1
//    move/rename re-maps -> loop-until-dry can converge), then by repo-relative POSIX
//    path. A unit that can't be uniquely identified ("" / "unknown" sentinel) is never
//    gated (fail-open, visibly) so unrelated findings can't collapse onto one key.
//  - The P0 live-hole override covers EVERY P0-ceiling lens (derived from the registry,
//    not hand-listed) and only fires when it actually changes the outcome, on reachable
//    code. On a merge-into unit the live hole is fixed at the SURVIVOR, not the doomed
//    copy.
//  - A skipped P0/P1 (a real bug behind an *unconfirmed* remove? proposal) is flagged
//    surfaceInReport so the §6 report foregrounds it — skipped never means dropped.

import { getLens, lensIds } from "./audit-lenses.mjs";

// Ordered tiers. Each runs to convergence before the next. Every lens maps to exactly
// one tier; a lens absent here falls back to the Quality tier (lowest stakes for
// ordering). NOTE: `dependencies_supply_chain` sits in Structure because dep hygiene is
// a behaviour-preserving concern; a KNOWN-EXPLOITED dependency must be reclassified to
// `security_secrets` by the detector (lens.reclassifyExploited) BEFORE tiering, so it
// lands in Correctness with the live-hole override — tiering assumes `lens` already
// reflects that reclassification.
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

// Tier-0 verdicts over a unit. `keep` is the default; only the others gate mechanical
// work. Removal-class verdicts are proposals, never auto-applied.
export const VERDICTS = ["keep", "remove", "merge-into", "redesign", "relocate", "quarantine"];

// A P0 in one of these lenses, in reachable code, is ALWAYS processed regardless of a
// remove?/redesign? verdict — a live hole does not wait for a delete decision (§3).
// Derived from the registry: exactly the lenses whose ceiling is P0 (security, data
// integrity, concurrency, ci/config injection). Hand-listing missed two of them.
export const SECURITY_OVERRIDE_LENSES = new Set(lensIds().filter((id) => getLens(id)?.ceiling === "P0"));

// A verdict only GATES (skip/redirect/suppress) when its confidence clears this floor
// (docs/enterprise-fix-design.md §3 "confidence floor -> observations not verdicts").
// A regex-grade single-signal verdict stays below it -> it surfaces as a proposal but
// never autonomously prunes mechanical work. Corroborated (multi-fact) verdicts clear it.
export const GATE_CONFIDENCE_FLOOR = 0.7;

// Unit ids that don't uniquely identify a file: never gate on these (fail-open).
const SENTINEL_UNITS = new Set(["", "unknown"]);
const SURFACE_FLOOR = new Set(["P0", "P1"]);
const RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

function normUnit(s) {
  return String(s ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Repo-relative POSIX unit id for a finding (|| so an empty .file can't shadow path). */
function fileOf(finding) {
  return normUnit(finding?.file || finding?.location?.path || "");
}

/** Tier id for a lens; unknown/missing lens falls back to the Quality tier. */
export function tierOfLens(lensId) {
  return TIER_OF_LENS.has(lensId) ? TIER_OF_LENS.get(lensId) : QUALITY_TIER;
}

/** Verdict entry for a finding: fingerprint (stable across re-map) first, then path. */
function verdictFor(finding, verdictMap) {
  const fp = finding?.fingerprint ? String(finding.fingerprint) : null;
  if (fp && verdictMap[fp]) return verdictMap[fp];
  const path = fileOf(finding);
  if (path && !SENTINEL_UNITS.has(path) && verdictMap[path]) return verdictMap[path];
  return null;
}

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
      return fileOf(a.f).localeCompare(fileOf(b.f)) || a.i - b.i;
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

/** Base gate decision from a verdict, before the live-hole override. */
function baseAction(finding, verdict, entry) {
  switch (verdict) {
    case "remove":
      return { action: "skip", reason: "unit marked remove? — not worth fixing this pass" };
    case "merge-into": {
      const survivor = entry?.survivor ? normUnit(entry.survivor) : null;
      // A missing or self-referential survivor is not a real redirect target: process
      // in place with a loud reason rather than emit a dangling pointer.
      if (!survivor || survivor === fileOf(finding)) {
        return { action: "process", reason: "merge-into missing/self survivor — processing in place" };
      }
      return { action: "redirect", to: survivor, reason: `merge-into ${survivor}` };
    }
    case "redesign":
      return tierOfLens(finding.lens) === QUALITY_TIER
        ? { action: "suppress", reason: finding?.lens ? "redesign? — quality polish suppressed (shape will change)" : "lens missing — defaulted to quality tier, suppressed" }
        : { action: "process", reason: "redesign? — correctness still runs (propose mode)" };
    case "relocate":
      // Code that will move: suppress Quality-tier polish (like redesign); other tiers
      // still process.
      return tierOfLens(finding.lens) === QUALITY_TIER
        ? { action: "suppress", reason: "relocate? — quality polish suppressed (code will move)" }
        : { action: "process", reason: "relocate? — non-quality work still runs" };
    case "quarantine":
      // Contested (intent-defense found evidence): the unit is KEPT, so mechanical
      // fixing continues, but the state is flagged so it's not mistaken for a clean keep.
      return { action: "process", reason: "quarantine (contested) — kept + fixed, flagged" };
    case "keep":
    default:
      return { action: "process" };
  }
}

/**
 * Decide how the mechanical tiers should treat one finding given the Tier-0 verdict of
 * its unit. `verdictMap` maps a fingerprint OR repo-relative POSIX path ->
 * { verdict, survivor?, reachable? }. Returns { action, to?, reason }:
 *   - process   : run the fix/proposal normally (default)
 *   - skip      : unit marked remove? -> don't spend effort here
 *   - redirect  : unit marked merge-into(X) -> route the fix to survivor X
 *   - suppress  : redesign?/relocate? on a Quality-tier finding -> skip polish only
 * P0 live-hole override: a P0 in a P0-ceiling lens, in reachable code, is processed
 * even on a remove? unit — but only when that actually changes the outcome.
 */
export function tierAction(finding, verdictMap = {}, { securityLenses = SECURITY_OVERRIDE_LENSES } = {}) {
  const path = fileOf(finding);
  const identifiable = (path && !SENTINEL_UNITS.has(path)) || Boolean(finding?.fingerprint);
  if (!identifiable) return { action: "process", reason: "unit not uniquely identifiable — not gated" };

  let entry = verdictFor(finding, verdictMap);
  // Confidence floor: a below-floor verdict is an OBSERVATION, not a gate — ignore it
  // (treat as keep) so a regex-grade signal never autonomously skips/redirects a fix.
  if (entry && Number.isFinite(entry.confidence) && entry.confidence < GATE_CONFIDENCE_FLOOR) entry = null;
  const base = baseAction(finding, entry?.verdict ?? "keep", entry);

  const reachable = entry?.reachable !== false;
  const isLiveHole = finding.severity === "P0" && securityLenses.has(finding.lens) && reachable;
  // Override only when it changes the outcome (base would skip). A merge-into already
  // redirects the fix to the survivor, so the hole is addressed there — no override.
  if (isLiveHole && base.action === "skip") {
    return { action: "process", reason: "P0 live-hole override (unit marked remove?)" };
  }
  return base;
}

/**
 * Apply the verdict map across a finding set, annotating each with its tier and the
 * gate effect for the auditable "what was pruned" trail (§3 gateEffect). A skipped
 * P0/P1 is flagged surfaceInReport so the report foregrounds a real bug parked behind
 * an unconfirmed remove? proposal — skipped is not dropped. Findings are tier-ordered.
 */
export function applyTierGating(findings = [], verdictMap = {}, opts = {}) {
  const gated = orderByTier(findings).map((f) => {
    const d = tierAction(f, verdictMap, opts);
    // A serious finding that is skipped OR redirected (fix routed off to a survivor) is
    // surfaced so the §6 report foregrounds it — a misdirected P0/P1 is never invisible.
    const surfaceInReport = (d.action === "skip" || d.action === "redirect") && SURFACE_FLOOR.has(f.severity);
    return {
      ...f,
      tier: tierOfLens(f.lens),
      gateEffect: d.action,
      gateReason: d.reason ?? null,
      ...(d.to ? { redirectedTo: d.to } : {}),
      ...(surfaceInReport ? { surfaceInReport: true } : {})
    };
  });
  return {
    findings: gated,
    process: gated.filter((f) => f.gateEffect === "process"),
    redirected: gated.filter((f) => f.gateEffect === "redirect"),
    skipped: gated.filter((f) => f.gateEffect === "skip"),
    suppressed: gated.filter((f) => f.gateEffect === "suppress"),
    surfaced: gated.filter((f) => f.surfaceInReport)
  };
}

/**
 * Loop-facing selector for M3: the still-actionable findings (process + redirect),
 * grouped by tier so the fix loop can run each tier to convergence before the next.
 */
export function actionableByTier(gatingResult = {}) {
  const actionable = [...(gatingResult.process ?? []), ...(gatingResult.redirected ?? [])];
  return TIERS.map((t) => ({
    tierId: t.id,
    key: t.key,
    title: t.title,
    findings: actionable.filter((f) => (typeof f.tier === "number" ? f.tier : tierOfLens(f.lens)) === t.id)
  }));
}

/** Validate a lens->tier mapping covers every registered lens (guards drift). */
export function unmappedLenses(lensIds = []) {
  return lensIds.filter((id) => getLens(id) && !TIER_OF_LENS.has(id));
}
