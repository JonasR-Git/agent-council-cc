// Tier-0 predicate detector (docs/enterprise-fix-design.md §3). Judges the DESIGN
// decision, not the implementation, over the static fact-base — so its evidence lives
// OUTSIDE the code text (reachability, importer counts, age). PREDICATE-DRIVEN: every
// finding type has a machine-measurable trigger; no firing predicate -> no finding
// (this is what stops it degenerating into "feels over-engineered" LLM opinion). The
// LLM only VERIFIES/defends, it does not detect.
//
// Confidence + observation tier (hardened after the M2 detector council): a regex-grade
// single-signal candidate is LOW confidence and emitted as an OBSERVATION — it surfaces
// as a proposal but is NOT written into the verdict map, so it never autonomously gates
// (skip/redirect/suppress) mechanical work. A verdict only gates once corroborated above
// GATE_CONFIDENCE_FLOOR. This resolves the two P0s (deadModule's reachable:false
// disarming the security override; singleConsumer's fan-in=1 misdirecting real fixes):
// both stay observations at their current confidence. The adversarial intent-defense and
// the age source are INJECTABLE so the module is pure + testable without agents or git.

import { findOrphanModules } from "./import-graph.mjs";
import { GATE_CONFIDENCE_FLOOR } from "./audit-tiers.mjs";

const normUnit = (s) =>
  String(s ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

// Each predicate is a pure function over `facts` -> candidate[]. A candidate carries the
// UNIT it judges, the proposed VERDICT, a CONFIDENCE (0-1), and the evidence that fired
// it. Predicates guard every field so a partial/malformed node degrades to "no
// candidates", never a crash. facts = { nodes: Map<id,node>, entrypoints: Set<id>,
// ageOf?(id)->days }; node = { id, exports:Set, hasDefault, in:Set, out:Set, opaque }.
export const PREDICATES = {
  // Dead feature: exports something, but no module imports it and it is not an entry
  // point. LOW confidence — the import graph is regex-based (blind to dynamic import(),
  // require(), package "exports"/bin, non-configured entries), so this is a CANDIDATE,
  // never authority. It does NOT stamp reachable:false: that would disarm the P0
  // live-hole override on the least-trustworthy signal.
  deadModule(facts) {
    return findOrphanModules(facts.nodes, { entrypoints: facts.entrypoints }).map((o) => ({
      unit: o.id,
      category: "dead-feature",
      verdict: "remove",
      confidence: 0.45,
      severity: "P2",
      reason: `no module imports ${o.id} and it is not an entry point — dead capability? (regex graph: verify)`,
      evidence: { importers: 0, exports: (o.exports ?? []).length }
    }));
  },

  // Over-layered indirection / premature boundary: a non-entry, non-opaque module
  // imported by exactly one consumer. LOW confidence — one *importer* is the normal
  // shape of an extracted helper, and a barrel re-export or a dynamic second importer is
  // invisible to the graph, so this is a proposal to consider folding in, not a merge
  // order. survivor = the sole consumer (informational for the human).
  singleConsumer(facts) {
    const out = [];
    for (const n of facts.nodes.values()) {
      const inSize = n?.in?.size ?? 0;
      if (!n || facts.entrypoints.has(n.id) || n.opaque) continue;
      if (inSize === 1 && ((n.exports?.size ?? 0) > 0 || n.hasDefault)) {
        const survivor = [...n.in][0];
        if (survivor === n.id) continue;
        out.push({
          unit: n.id,
          category: "over-layered-indirection",
          verdict: "merge-into",
          confidence: 0.3,
          survivor,
          severity: "P2",
          reason: `${n.id} is imported by exactly one module (${survivor}) — fold in? (regex graph: verify)`,
          evidence: { importers: 1, survivor }
        });
      }
    }
    return out;
  }
};

const REMOVAL_CLASS = new Set(["remove", "merge-into"]);
const GATING_VERDICTS = new Set(["remove", "merge-into", "redesign", "relocate"]);

function toLogicalFinding(c, verdict, observation, intentEvidence) {
  return {
    schemaVersion: 1,
    ruleId: `logical/${c.category}`,
    lens: "logical_sense",
    category: c.category,
    severity: c.severity ?? "P2",
    title: c.reason,
    failureScenario: c.reason,
    location: { path: normUnit(c.unit), startLine: 1 },
    scope: "cross-cutting",
    fixDisposition: "propose-only",
    lifecycle: "candidate",
    verdict,
    confidence: c.confidence ?? 0,
    observation,
    ...(c.survivor ? { survivor: normUnit(c.survivor) } : {}),
    ...(intentEvidence ? { intentEvidence } : {}),
    evidence: c.evidence ? [c.evidence] : []
  };
}

/**
 * Run the Tier-0 predicates over the fact-base and produce { findings, verdictMap }.
 * Every candidate becomes a finding (a proposal). Only candidates that (a) clear
 * GATE_CONFIDENCE_FLOOR, (b) were NOT demoted to quarantine by the intent-defense, and
 * (c) carry a gating verdict are written into the verdict map — everything else is an
 * observation that surfaces but never gates.
 *
 * Options:
 *   - predicates: the predicate registry (override for tests / extension).
 *   - ageGuardDays: young code suppresses speculative/removal-class candidates (a
 *     two-week-old unwired module is a plan, not dead). Needs facts.ageOf.
 *   - intentDefense: async (candidates[], facts) -> Map<unit,{found,source?,quote?}> |
 *     object. Called ONCE (batched — never one agent call per candidate). Documented
 *     intent demotes a removal-class verdict to quarantine (kept + flagged, no gating).
 *     A throwing/rejecting defense degrades to "no demotion" (candidates stay
 *     observations), never aborting the whole pass.
 */
export async function detectLogical(facts, { predicates = PREDICATES, ageGuardDays = 30, intentDefense = null } = {}) {
  const nodes = facts?.nodes ?? new Map();
  const entrypoints = facts?.entrypoints ?? new Set();
  const f = { nodes, entrypoints, ageOf: facts?.ageOf };

  // Aggregate predicates; a throwing predicate degrades to "no candidates" for that one.
  let candidates = [];
  for (const key of Object.keys(predicates)) {
    try {
      candidates = candidates.concat(predicates[key](f) ?? []);
    } catch {
      /* a bad node in one predicate must not abort detection for the whole repo */
    }
  }

  // Age guard: a young unit is a plan, not a finding — suppress speculative + removal.
  candidates = candidates.filter((c) => {
    const softenable = c.category === "over-layered-indirection" || REMOVAL_CLASS.has(c.verdict);
    if (!softenable || typeof f.ageOf !== "function") return true;
    const age = f.ageOf(c.unit);
    return !(Number.isFinite(age) && age < ageGuardDays);
  });

  // Adversarial intent-defense, batched + guarded: one call for all removal candidates.
  let defenseByUnit = new Map();
  const removal = candidates.filter((c) => REMOVAL_CLASS.has(c.verdict));
  if (intentDefense && removal.length) {
    try {
      const res = await intentDefense(removal, f);
      defenseByUnit = res instanceof Map ? res : new Map(Object.entries(res ?? {}));
    } catch {
      defenseByUnit = new Map(); // defense failed -> demote nothing; candidates stay observations
    }
  }

  const findings = [];
  const verdictMap = {};
  for (const c of candidates) {
    let verdict = c.verdict;
    let intentEvidence;
    const def = defenseByUnit.get(c.unit);
    if (def?.found && REMOVAL_CLASS.has(verdict)) {
      verdict = "quarantine";
      intentEvidence = { found: true, source: def.source ?? null, quote: def.quote ?? null };
    }
    const gates = (c.confidence ?? 0) >= GATE_CONFIDENCE_FLOOR && verdict !== "quarantine" && GATING_VERDICTS.has(verdict);
    findings.push(toLogicalFinding(c, verdict, !gates, intentEvidence));
    if (gates) {
      verdictMap[normUnit(c.unit)] = {
        verdict,
        confidence: c.confidence,
        ...(c.survivor ? { survivor: normUnit(c.survivor) } : {}),
        ...(c.reachable === false ? { reachable: false } : {}),
        ...(intentEvidence ? { intentEvidence } : {})
      };
    }
  }
  return { findings, verdictMap };
}
