// Bridge from a raw agent/merged finding (findings.mjs shape) to a canonical
// audit-finding (docs/audit-schema.md §1). Assigns the lens, caps severity, derives
// confidence from evidence state, computes the risk score + stable fingerprint, and
// sets lifecycle / scope / fixDisposition. Pure.

import { cappedSeverity, getLens, isProposeOnly } from "./audit-lenses.mjs";
import { semanticFingerprint } from "./audit-fingerprint.mjs";
import { deriveConfidence, riskScore } from "./audit-risk.mjs";
import { classifyScope } from "./scope.mjs";

const CATEGORY_LENS = {
  bug: "correctness",
  correctness: "correctness",
  other: "correctness",
  "dead-code": "architecture_ssot",
  concurrency: "concurrency_resources",
  resource: "concurrency_resources",
  security: "security_secrets",
  auth: "security_secrets",
  secret: "security_secrets",
  injection: "security_secrets",
  "data-loss": "data_integrity",
  data: "data_integrity",
  ssot: "architecture_ssot",
  architecture: "architecture_ssot",
  design: "architecture_ssot",
  performance: "performance",
  reliability: "reliability_observability",
  "error-handling": "reliability_observability",
  observability: "reliability_observability",
  test: "testing",
  testing: "testing",
  dependency: "dependencies_supply_chain",
  "supply-chain": "dependencies_supply_chain",
  compliance: "compliance_governance",
  privacy: "compliance_governance",
  docs: "docs_maintainability",
  doc: "docs_maintainability",
  dx: "docs_maintainability",
  config: "config_cicd_security",
  ci: "config_cicd_security",
  cicd: "config_cicd_security"
};

export function categoryToLens(category, fallback = "correctness") {
  const c = String(category ?? "").toLowerCase().trim();
  return CATEGORY_LENS[c] ?? fallback;
}

// Inherently MULTI-FILE verdicts (from the Tier-0 predicate detector / a model's structural judgement):
// removing a module, folding it into a survivor, a redesign or relocation is never a single-file fix.
const REMOVAL_VERDICTS = new Set(["remove", "merge-into", "redesign", "relocate"]);

/**
 * The FIX-ELIGIBILITY lens — deliberately SEPARATE from the coverage lens (docs/logical-autofix-design.md).
 * The grouped review stamps the GROUP lens authoritatively on every cell finding (relens,
 * audit-grouped-review.mjs) — correct for coverage/reporting attribution, but WRONG as a fix classification:
 * a `category:bug` surfaced under the logical_sense group is a correctness bug that merely appeared during a
 * logical review, not a cross-cutting design issue. This returns the category-native lens when the coverage
 * lens is propose-only (logical_sense/architecture_ssot) BUT the finding is really a localized, mechanically
 * fixable class — so it can flow through the NORMAL correctness fixer instead of being frozen propose-only.
 * PURE and CONSENT-FREE: consent stays a fix-time gate, never part of the finding's canonical identity
 * (Council P1: consent in pure normalize is the wrong seam / split-brain). Falls back to the coverage lens
 * (stays propose-only) unless every guard clears — so the DEFAULT is always the safe, unchanged behaviour.
 */
export function fixEligibilityLens(raw = {}, coverageLens) {
  // Only ever reattribute AWAY from a propose-only coverage lens; a runtime-fixable lens keeps its identity.
  if (!isProposeOnly(coverageLens)) return coverageLens;
  const native = categoryToLens(raw.category);
  // The category must map to a genuinely fixable (non-propose-only) lens — else there is nothing to gain.
  if (isProposeOnly(native)) return coverageLens;
  // VETO 1 (Council P1): honour an explicit OR heuristic cross-cutting signal. classifyScope respects an
  // explicit raw.scope AND the CROSS_CUTTING_HINTS text scan (architect/refactor/across/api surface/…).
  if (classifyScope(raw) === "cross-cutting") return coverageLens;
  // VETO 2 (Council P1): a removal/merge/redesign verdict or a survivor target is inherently multi-file.
  if (REMOVAL_VERDICTS.has(String(raw.verdict ?? "").toLowerCase()) || raw.survivor) return coverageLens;
  return native;
}

/**
 * True when the refutation verifier REFUTED this finding. `verified` is the verifier's annotation
 * object {by, refuted, reason, demotable} — it is TRUTHY for BOTH outcomes, so `Boolean(f.verified)`
 * must never be read as "supported" (council Fable P1: a refuted finding was landing in the STRONGEST
 * evidence state — adversarial-verified, confidence floor 0.85, lifecycle confirmed, ranked first).
 */
export function isRefuted(raw = {}) {
  return raw?.verified != null && typeof raw.verified === "object" && raw.verified.refuted === true;
}

/** True when the verifier ran AND SUPPORTED the finding (the only reading that means "verified"). */
export function isVerifiedSupported(raw = {}) {
  return Boolean(raw?.verified) && !isRefuted(raw);
}

/** Evidence state → drives the confidence cap/floor (audit-risk deriveConfidence). */
export function evidenceState(raw = {}) {
  // A REFUTED finding is the WEAKEST evidence state, never the strongest: an independent verifier
  // could not support it. It stays VISIBLE (annotate-only) but must be deprioritized, not promoted.
  if (isRefuted(raw)) return "refuted";
  if (isVerifiedSupported(raw)) return raw.reproduced ? "reproduced" : "adversarial-verified";
  if (raw.consensus) return "independent-agreement";
  const finders = raw.agents?.length ?? (raw.agent ? 1 : 0);
  return finders >= 1 ? "one-finder" : "regex-only";
}

const clamp15 = (n, d = 3) => Math.max(1, Math.min(5, Number.isFinite(Number(n)) ? Math.round(Number(n)) : d));

/** Convert one raw finding to a canonical audit-finding. `unit` is the reviewed file. */
export function toCanonicalFinding(raw = {}, { unit, ordinal } = {}) {
  const lens = raw.lens && getLens(raw.lens) ? raw.lens : categoryToLens(raw.category);
  const state = evidenceState(raw);
  // "verified" here means SUPPORTED by the verifier — a refuted finding must NOT lift the severity cap
  // nor read as confirmed (council Fable P1).
  const verified = isVerifiedSupported(raw);
  const severity = cappedSeverity(lens, raw.severity ?? "P2", { verified, regexOnly: state === "regex-only" });
  // A MERGED bucket (findings.mjs finalizeBuckets) carries the finders' averaged self-rating as
  // `avgConfidence`; a single raw finding carries `confidence`. Reading only the latter scored every
  // merged finding — i.e. every finding on the audit path — at the 0.6 default and threw the models'
  // confidence signal away. deriveConfidence still clamps to the evidence-state CAP/FLOOR, so a
  // self-rating can lower confidence but NEVER exceed what the evidence supports (a refuted finding
  // stays at the 0.2 cap however loudly the model rated itself).
  const selfRated = Number.isFinite(raw.avgConfidence) ? raw.avgConfidence : raw.confidence;
  const confidence = deriveConfidence(state, Number.isFinite(selfRated) ? selfRated : 0.6);
  const L = clamp15(raw.likelihood);
  const B = clamp15(raw.blastRadius);
  const E = clamp15(raw.exploitability);
  const risk = riskScore({ severity, likelihood: L, blastRadius: B, exploitability: E, confidence });
  // `lens` is the COVERAGE lens (reporting/tier attribution); `fixLens` is the FIX-ELIGIBILITY lens — they
  // differ only when a fixable category was group-stamped onto a propose-only lens (see fixEligibilityLens).
  // scope/fixDisposition derive from fixLens so a genuinely localized correctness bug found under the
  // logical_sense group is patchable, while true design/removal findings stay cross-cutting/propose-only.
  const fixLens = fixEligibilityLens(raw, lens);
  const scope = raw.scope === "cross-cutting" || isProposeOnly(fixLens) ? "cross-cutting" : "localized";
  const fixDisposition = scope === "cross-cutting" ? "propose-only" : "localized";
  // A refuted finding is neither "confirmed" nor pending verification — verification RAN and did not
  // support it. Surface that honestly so the report/gate deprioritizes it instead of ranking it first.
  const lifecycle = isRefuted(raw)
    ? "refuted"
    : verified || raw.consensus
      ? "confirmed"
      : severity === "P0" || severity === "P1"
        ? "verification_required"
        : "candidate";
  const path = String(raw.file || unit || "unknown");
  const line = Math.max(1, Math.round(Number(raw.line)) || 1);

  const finding = {
    schemaVersion: 1,
    ruleId: String(raw.ruleId ?? raw.category ?? lens),
    lens,
    category: raw.category ?? lens,
    title: String(raw.title ?? "").trim() || "(untitled)",
    lifecycle,
    severity,
    likelihood: L,
    blastRadius: B,
    exploitability: E,
    confidence,
    risk,
    location: { path, startLine: Math.max(1, line) },
    failureScenario: String(raw.failureScenario ?? raw.detail ?? raw.title ?? "(no scenario provided)").trim() || "(no scenario provided)",
    standards: getLens(lens)?.standards ?? [],
    scope,
    consensus: raw.consensus ? "consensus" : raw.contested ? "contested" : "single",
    fixDisposition,
    // Only carried when the fix-eligibility lens DIFFERS from the coverage lens (a reattributed finding);
    // absent = the two are identical, so downstream `f.fixLens ?? f.lens` recovers the fix lens uniformly.
    ...(fixLens !== lens ? { fixLens } : {})
  };
  finding.fingerprint = semanticFingerprint({ location: finding.location, lens, ruleId: finding.ruleId, title: finding.title, anchor: raw.anchor, symbol: raw.symbol, ordinal });
  return finding;
}

/**
 * Normalize a list of raw findings, assigning an `ordinal` to any that would share a
 * fingerprint (two findings of the same rule+anchor in one file) so none is dropped.
 */
export function normalizeFindings(rawList = [], { unit } = {}) {
  const counts = new Map();
  const out = [];
  for (const raw of rawList) {
    const probe = toCanonicalFinding(raw, { unit });
    const key = probe.fingerprint;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    out.push(n === 0 ? probe : toCanonicalFinding(raw, { unit, ordinal: n }));
  }
  return out;
}
