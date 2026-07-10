// The twelve-lens registry (docs/audit-schema.md §2): versioned DATA that drives
// detection, severity ceilings, consensus policy, handling class and standards tags.
// No scattered logic — every consumer reads this table. A static/regex candidate is
// capped at P2 until independently verified; a lens ceiling is only exceeded by
// reclassification into the lens of the proven impact.

export const LENS_REGISTRY_VERSION = 1;

// handling: "localized"    -> localized fixes allowed (cross-module -> propose)
//           "conditional"  -> localized fix conditional; protocol/schema/redesign -> propose
//           "propose-only" -> never auto-fixed regardless of score
export const LENSES = {
  correctness: { ceiling: "P1", consensus: false, handling: "localized", standards: ["CWE-670", "CWE-691", "CWE-703"] },
  concurrency_resources: { ceiling: "P0", consensus: true, handling: "conditional", standards: ["CWE-362", "CWE-400", "CWE-404", "CWE-772", "CWE-833"] },
  security_secrets: { ceiling: "P0", consensus: true, handling: "conditional", standards: ["OWASP-A01", "OWASP-A02", "OWASP-A03", "OWASP-A05", "OWASP-A07", "OWASP-A08", "OWASP-A10"] },
  data_integrity: { ceiling: "P0", consensus: true, handling: "conditional", standards: ["CWE-20", "CWE-190", "CWE-345", "CWE-367", "OWASP-A04", "OWASP-A08"] },
  architecture_ssot: { ceiling: "P1", consensus: false, handling: "propose-only", standards: ["AC-ARCH", "AC-SSOT"] },
  performance: { ceiling: "P1", consensus: false, handling: "localized", standards: ["CWE-400", "CWE-770"] },
  reliability_observability: { ceiling: "P1", consensus: false, handling: "localized", standards: ["CWE-703", "CWE-754"] },
  testing: { ceiling: "P2", consensus: false, handling: "localized", standards: ["AC-TEST"] },
  dependencies_supply_chain: { ceiling: "P1", consensus: true, handling: "propose-only", reclassifyExploited: "security_secrets", standards: ["CWE-1104", "OWASP-A06", "OWASP-A08"] },
  compliance_governance: { ceiling: "P1", consensus: true, handling: "propose-only", standards: ["PRIVACY"] },
  docs_maintainability: { ceiling: "P2", consensus: false, handling: "localized", standards: ["AC-DOC"] },
  config_cicd_security: { ceiling: "P0", consensus: true, handling: "propose-only", standards: ["CWE-16", "CWE-78", "CWE-94", "CWE-829", "OWASP-A05", "OWASP-A08"] }
};

const RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };
const sevOf = (r) => ["P0", "P1", "P2", "nit"][Math.max(0, Math.min(3, r))];

export function lensIds() {
  return Object.keys(LENSES);
}

export function getLens(id) {
  return LENSES[id] ?? null;
}

export function requiresConsensus(id) {
  return Boolean(getLens(id)?.consensus);
}

export function isProposeOnly(id) {
  return getLens(id)?.handling === "propose-only";
}

/**
 * Clamp a proposed severity to what the lens + evidence permit. Higher RANK = less
 * severe, so capping pushes the rank UP (toward less severe). A regex-only candidate
 * cannot exceed P2 until independently verified; nothing exceeds the lens ceiling.
 */
export function cappedSeverity(lensId, proposed, { verified = false, regexOnly = false } = {}) {
  const lens = getLens(lensId);
  let r = RANK[proposed] ?? RANK.P2;
  if (regexOnly && !verified) r = Math.max(r, RANK.P2);
  if (lens) r = Math.max(r, RANK[lens.ceiling] ?? RANK.P2);
  return sevOf(r);
}
