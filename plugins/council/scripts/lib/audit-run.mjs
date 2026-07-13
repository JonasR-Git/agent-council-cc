// Self-driving audit orchestration (docs/audit-schema.md §5/§8): inventory the whole
// surface, compute the mandatory set, run the (reused) review engine, normalize its
// findings to canonical form, build honest coverage units, and assemble the report.
// The review + inventory are injectable so the wiring is testable without agents.

import { assembleReport } from "./audit-assemble.mjs";
import { normalizeFindings } from "./audit-normalize.mjs";
import { mandatorySet } from "./audit-targets.mjs";
import { inventoryFiles } from "./codebase-model.mjs";
import { applyGovernance, loadGovernance } from "./audit-baseline.mjs";
import { runAuditReview } from "./audit-review.mjs";
import { nowIso, workspaceRoot } from "./state.mjs";

/** Enrich inventory records with model facts so mandatorySet can see fan-in/entrypoints. */
function enrich(inv, model) {
  const factById = new Map((model?.files ?? []).map((f) => [f.id, f]));
  // Entrypoints live on the graph the codebase-model builds (model.graph.entrypoints),
  // not at the model root — reading model.entrypoints yielded undefined, so the
  // mandatory-coverage gate never marked the CLI entrypoint as isEntrypoint.
  const entrypoints = new Set(model?.graph?.entrypoints ?? []);
  return inv.map((f) => {
    const fact = factById.get(f.id);
    return {
      id: f.id,
      fileClass: f.fileClass,
      isEntrypoint: entrypoints.has(f.id) || Boolean(fact?.isEntrypoint),
      fanIn: Number.isFinite(fact?.fanIn) ? fact.fanIn : undefined
    };
  });
}

export async function runAudit(cwd, model, backends = {}, options = {}, deps = {}) {
  const root = workspaceRoot(cwd);
  const inv = deps.inventory ?? inventoryFiles(root, { areas: options.areas });
  const mand = mandatorySet(enrich(inv, model), { criticalGlobs: options.criticalGlobs, highFanIn: options.highFanIn ?? 8 });
  const mandIds = new Set(mand.ids);

  const review = deps.review ?? ((o) => runAuditReview(cwd, model, backends, o));
  const rev = (await review({ ...options, budget: options.budget, maxUnits: options.maxUnits, skipCodex: options.skipCodex, skipGrok: options.skipGrok })) ?? {};
  const rawCanonical = normalizeFindings(rev.findings ?? [], {});
  const governance = deps.governance ?? loadGovernance(root);
  const canonical = applyGovernance(rawCanonical, governance, deps.nowIso ? deps.nowIso() : nowIso());

  // Coverage state per file class. Non-JS classes have no agent detector, so their
  // deepest available coverage IS the static pass -> count them done (state
  // "reviewed") but surface them as static-only. A JS file the agent did not review
  // stays "parsed" (NOT done), so a hot mandatory JS file keeps the gate honest
  // (indeterminate) while a fully-reviewed mandatory surface lets the gate reach
  // pass/fail.
  const reviewed = new Set(rev.reviewed ?? []);
  const units = inv.map((f) => {
    let state;
    if (reviewed.has(f.id)) state = "reviewed";
    else if (f.fileClass === "js") state = "parsed";
    else state = "reviewed"; // static-only class: no deeper detector exists
    return { file: f.id, lens: null, state, mandatory: mandIds.has(f.id), requiresVerification: false };
  });
  // Mandatory JS files the agent review did not reach — the explicit gap that keeps
  // the gate indeterminate until coverage is raised.
  const mandatoryUnreviewed = inv.filter((f) => mandIds.has(f.id) && f.fileClass === "js" && !reviewed.has(f.id)).map((f) => f.id);

  const report = assembleReport(canonical, units, {
    generatedAt: deps.nowIso ? deps.nowIso() : nowIso(),
    target: { root, base: options.base ?? null },
    provenance: {
      models: { codex: options.codexModel ?? null, grok: options.grokModel ?? null, claude: options.claudeModel ?? null },
      budgetSpent: rev.coverage?.budgetSpent ?? null,
      mandatoryReasons: mand.reasons
    },
    verificationComplete: canonical.every((f) => f.lifecycle !== "verification_required"),
    confirmedCount: canonical.filter((f) => f.lifecycle === "confirmed").length,
    refutedFp: 0
  });
  report.mandatorySurface = { count: mand.ids.length, reasons: mand.reasons };
  report.mandatoryUnreviewed = mandatoryUnreviewed;
  return report;
}
