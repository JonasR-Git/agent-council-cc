// Tier-0 predicate detector (docs/enterprise-fix-design.md §3). Judges the DESIGN
// decision, not the implementation, over the static fact-base — so its evidence lives
// OUTSIDE the code text (reachability, importer counts, age). PREDICATE-DRIVEN: every
// finding type has a machine-measurable trigger; no firing predicate -> no finding
// (this is what stops it degenerating into "feels over-engineered" LLM opinion). The
// LLM only VERIFIES/defends, it does not detect. Emits logical_sense candidate findings
// (propose-only, cross-cutting) plus a verdict map the tier gating consumes.
//
// The adversarial intent-defense and the age source are INJECTABLE so the module is
// pure + testable without agents or git; the wiring that supplies the real fact-base,
// an agent-backed intent-defense, and churn/age lives in the audit run (M3).

import { findOrphanModules } from "./import-graph.mjs";

// Each predicate is a pure function over `facts` -> candidate[]. A candidate carries
// the UNIT it judges, the proposed VERDICT, and the evidence that fired it.
// facts = { nodes: Map<id,node>, entrypoints: Set<id>, ageOf?(id)->days }
// node  = { id, exports: Set, hasDefault, in: Set, out: Set, opaque }
export const PREDICATES = {
  // Dead feature / unreachable capability: exports something, but no module imports it
  // and it is not an entry point. reachable:false so the tier gating won't spend a
  // live-hole override verifying a hole in provably-dead code.
  deadModule(facts) {
    return findOrphanModules(facts.nodes, { entrypoints: facts.entrypoints }).map((o) => ({
      unit: o.id,
      category: "dead-feature",
      verdict: "remove",
      reachable: false,
      severity: "P2",
      reason: `no module imports ${o.id} and it is not an entry point — dead capability?`,
      evidence: { importers: 0, exports: o.exports.length }
    }));
  },

  // Speculative generality: a non-entry module imported by exactly ONE consumer is a
  // candidate to fold into that consumer (merge-into survivor). Opaque modules
  // (star re-export / dynamic) are skipped — their true fan-in is unknowable.
  singleConsumer(facts) {
    const out = [];
    for (const n of facts.nodes.values()) {
      if (facts.entrypoints.has(n.id) || n.opaque) continue;
      if (n.in.size === 1 && (n.exports.size > 0 || n.hasDefault)) {
        const survivor = [...n.in][0];
        if (survivor === n.id) continue;
        out.push({
          unit: n.id,
          category: "speculative-generality",
          verdict: "merge-into",
          survivor,
          severity: "P2",
          reason: `${n.id} is imported by exactly one module (${survivor}) — fold in?`,
          evidence: { importers: 1, survivor }
        });
      }
    }
    return out;
  }
};

const REMOVAL_CLASS = new Set(["remove", "merge-into"]);

function toLogicalFinding(c, verdict, intentEvidence) {
  return {
    schemaVersion: 1,
    ruleId: `logical/${c.category}`,
    lens: "logical_sense",
    category: c.category,
    severity: c.severity ?? "P2",
    title: c.reason,
    failureScenario: c.reason,
    location: { path: c.unit, startLine: 1 },
    scope: "cross-cutting",
    fixDisposition: "propose-only",
    lifecycle: "candidate",
    verdict,
    ...(c.survivor ? { survivor: c.survivor } : {}),
    ...(intentEvidence ? { intentEvidence } : {}),
    evidence: c.evidence ? [c.evidence] : []
  };
}

/**
 * Run the Tier-0 predicates over the fact-base and produce { findings, verdictMap }.
 * Options:
 *   - predicates: the predicate registry (override for tests / extension).
 *   - ageGuardDays: young code suppresses speculative-generality (a two-week-old
 *     one-consumer module is a plan, not a finding). Needs facts.ageOf.
 *   - intentDefense: async (candidate, facts) -> { found, source?, quote? }. When it
 *     finds documented intent for a removal-class candidate, the verdict is demoted to
 *     `quarantine` (kept, but flagged) and the evidence is attached.
 * The verdict map is keyed by the unit's POSIX path so the tier gating (which looks up
 * by fingerprint then path) matches it.
 */
export async function detectLogical(facts, { predicates = PREDICATES, ageGuardDays = 30, intentDefense = null } = {}) {
  const nodes = facts?.nodes ?? new Map();
  const entrypoints = facts?.entrypoints ?? new Set();
  const f = { nodes, entrypoints, ageOf: facts?.ageOf };

  let candidates = [];
  for (const key of Object.keys(predicates)) candidates = candidates.concat(predicates[key](f));

  // Age guard: suppress speculative-generality on young code.
  candidates = candidates.filter((c) => {
    if (c.category !== "speculative-generality" || typeof f.ageOf !== "function") return true;
    const age = f.ageOf(c.unit);
    return !(Number.isFinite(age) && age < ageGuardDays);
  });

  const findings = [];
  const verdictMap = {};
  for (const c of candidates) {
    let verdict = c.verdict;
    let intentEvidence;
    if (intentDefense && REMOVAL_CLASS.has(verdict)) {
      const def = await intentDefense(c, f);
      if (def?.found) {
        verdict = "quarantine";
        intentEvidence = { found: true, source: def.source ?? null, quote: def.quote ?? null };
      }
    }
    findings.push(toLogicalFinding(c, verdict, intentEvidence));
    verdictMap[c.unit] = {
      verdict,
      ...(c.survivor ? { survivor: c.survivor } : {}),
      ...(c.reachable === false ? { reachable: false } : {})
    };
  }
  return { findings, verdictMap };
}
