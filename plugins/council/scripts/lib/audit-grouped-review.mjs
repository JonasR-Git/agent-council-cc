// M7 wiring — the six-eyes GROUPED review path. Where runAuditReview reviews each hotspot FILE once
// with all lenses at once, runGroupedReview reviews each (file × lens-GROUP × chunk) CELL with all
// three models (B1 groups + B3 chunks + B2 finders + B4 matrix), so every defect class gets its own
// deep focused pass and coverage is measured cell-granularly. It is OPT-IN (--groups <preset>) and
// self-contained — the existing per-file path is untouched. Produces coverage.complete (six-eyes)
// which B5's loop-until-dry consumes, so an endless/fix run keeps going until the matrix is whole.
import fs from "node:fs";
import path from "node:path";

import { resolveLensGroups } from "./audit-lens-groups.mjs";
import { chunkSource } from "./audit-group-prompt.mjs";
import { DEFAULT_MAX_CELLS, capCells, enumerateCells, makeCellReviewer, runCellMatrix } from "./audit-cell-scheduler.mjs";
import { activeReviewerCount, reviewerActive, selectUnits } from "./audit-review.mjs";
import { mergeFindings } from "./findings.mjs";
import { annotateScopes } from "./scope.mjs";
import { recordAndAnnotate } from "./ledger.mjs";
import { nowIso, workspaceRoot } from "./state.mjs";

const READ_MAX_BYTES = 2_000_000; // don't slurp a giant file into a chunker

/** The active finder models for this run (the three seats, minus any skipped/unavailable). */
export function activeModels(backends, options = {}) {
  return ["codex", "grok", "claude"].filter((m) => reviewerActive(m, backends, options));
}

/** Static-facts string for a file, mirroring buildUnitPrompt's facts line (for the cell prompt). */
function factsFor(model, unitId) {
  const f = (model?.files ?? []).find((x) => x.id === unitId);
  return f
    ? `loc=${f.loc} branches=${f.branches} maxNesting≈${f.maxNesting} fan-in=${f.fanIn} fan-out=${f.fanOut} churn=${f.churn} smells=${f.smellCount} tested=${f.tested} hotspot=${f.hotspot}`
    : "(no static facts)";
}

/**
 * Run the grouped six-eyes review. `deps.runMatrix` is injectable for tests (defaults to the real
 * runCellMatrix + makeCellReviewer). Returns the same shape as runAuditReview: { findings, refuted,
 * reviewed, coverage } — coverage carries `complete` (six-eyes over every scheduled cell), the group
 * preset, cells scheduled/dropped, and the matrix summary, so the loop + report can consume it.
 */
export async function runGroupedReview(cwd, model, backends, options = {}, deps = {}) {
  const root = workspaceRoot(cwd);
  const models = activeModels(backends, options);
  const groups = resolveLensGroups(options.lensGroups ?? "fine");
  const files = selectUnits(model, { maxUnits: options.maxUnits ?? 12, offset: options.unitOffset ?? 0 });

  if (models.length === 0 || files.length === 0 || groups.length === 0) {
    return { findings: [], refuted: [], reviewed: [], coverage: { complete: false, ran: false, reviewers: reviewerMap(backends, options), groupPreset: options.lensGroups ?? "fine", groups: groups.length, unitsSelected: files.length, cellsScheduled: 0 } };
  }

  // chunk each file ONCE (cache) so enumerateCells doesn't re-read; a file's chunk count drives its
  // cell count. factsOf attaches the static facts per file.
  const chunkCache = new Map();
  const chunksOf = (file) => {
    if (chunkCache.has(file)) return chunkCache.get(file);
    let text = "";
    try {
      const p = path.join(root, file);
      if (fs.statSync(p).size <= READ_MAX_BYTES) text = fs.readFileSync(p, "utf8");
    } catch {
      /* unreadable → 0 chunks → still one visible cell per (group,model) */
    }
    const chunks = chunkSource(text);
    chunkCache.set(file, chunks);
    return chunks;
  };
  const factsOf = (file) => factsFor(model, file);

  const allCells = enumerateCells(files, groups, models, chunksOf, factsOf);
  const { cells, dropped, capped } = capCells(allCells, options.maxCells ?? DEFAULT_MAX_CELLS);

  const reviewCell = deps.reviewCell ?? makeCellReviewer(cwd, backends, options);
  const runMatrix = deps.runMatrix ?? runCellMatrix;
  const matrixOut = await runMatrix(cells, reviewCell, {
    models,
    maxInflight: options.maxInflight,
    retryOnLimit: options.retryOnLimit,
    sleep: deps.sleep,
    onRetry: options.onProgress ? ({ attempt, ms }) => options.onProgress(`  cell rate-limited — backing off ${Math.round(ms / 1000)}s (retry ${attempt})…`) : undefined
  });

  // Merge + scope + ledger — the SAME post-processing the per-file path (runAuditReview) runs, so
  // downstream (normalize → tierOfLens → fix eligibility) treats grouped findings identically. We do
  // NOT normalize here: runAuditReview returns findings.mjs-shape and the consumer (fixloop-deps /
  // one-shot audit) stamps lens/tier via normalizeFindings — mirroring that keeps the two paths
  // interchangeable. Cell findings carry `.agent` (the model that raised them), so grouping them into
  // one doc PER MODEL lets mergeFindings detect true six-eyes consensus (a defect seen by ≥2 seats).
  const byAgent = new Map();
  for (const f of matrixOut.findings ?? []) {
    const a = f?.agent ?? "grouped";
    if (!byAgent.has(a)) byAgent.set(a, []);
    byAgent.get(a).push(f);
  }
  const docs = [...byAgent.entries()].map(([agent, findings]) => ({ agent, findings, parseOk: true }));
  const merged = mergeFindings(docs);
  let scoped = annotateScopes({ all: merged.all, consensus: merged.consensus, unique: merged.unique });
  if (options.ledger !== false) scoped = recordAndAnnotate(cwd, options.jobId ?? "grouped-review", scoped, options.nowIso ?? nowIso());

  const complete = capped ? false : Boolean(matrixOut.complete); // a capped run never claims full coverage
  return {
    findings: scoped.all,
    refuted: scoped.refuted ?? [],
    reviewed: files,
    coverage: {
      complete,
      ran: true,
      groupPreset: options.lensGroups ?? "fine",
      reviewers: reviewerMap(backends, options),
      unitsSelected: files.length,
      groups: groups.length,
      cellsScheduled: cells.length,
      cellsDropped: dropped,
      capped,
      // the grouped path bounds cost by the CELL count (maxCells), not an agent-call budget — the
      // matrix summary reports how many of those cells actually completed vs failed.
      matrix: matrixOut.matrix?.summary?.() ?? null
    }
  };
}

function reviewerMap(backends, options) {
  return {
    codex: reviewerActive("codex", backends, options),
    grok: reviewerActive("grok", backends, options),
    claude: reviewerActive("claude", backends, options)
  };
}

export { activeReviewerCount };
