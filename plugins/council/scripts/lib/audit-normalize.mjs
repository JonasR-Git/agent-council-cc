// Bridge from a raw agent/merged finding (findings.mjs shape) to a canonical
// audit-finding (docs/audit-schema.md §1). Assigns the lens, caps severity, derives
// confidence from evidence state, computes the risk score + stable fingerprint, and
// sets lifecycle / scope / fixDisposition. Pure.

import { cappedSeverity, getLens, isProposeOnly } from "./audit-lenses.mjs";
import { semanticFingerprint } from "./audit-fingerprint.mjs";
import { deriveConfidence, riskScore } from "./audit-risk.mjs";

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
  const confidence = deriveConfidence(state, Number.isFinite(raw.confidence) ? raw.confidence : 0.6);
  const L = clamp15(raw.likelihood);
  const B = clamp15(raw.blastRadius);
  const E = clamp15(raw.exploitability);
  const risk = riskScore({ severity, likelihood: L, blastRadius: B, exploitability: E, confidence });
  const scope = raw.scope === "cross-cutting" || isProposeOnly(lens) ? "cross-cutting" : "localized";
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
    fixDisposition
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
