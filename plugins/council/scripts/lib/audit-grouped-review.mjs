// M7 wiring — the six-eyes GROUPED review path. Where runAuditReview reviews each hotspot FILE once
// with all lenses at once, runGroupedReview reviews each (file × lens-GROUP × chunk) CELL with all
// three models (B1 groups + B3 chunks + B2 finders + B4 matrix), so every defect class gets its own
// deep focused pass and coverage is measured cell-granularly. It is OPT-IN (--groups <preset>) and
// self-contained — the existing per-file path is untouched. Produces coverage.complete (six-eyes)
// which B5's loop-until-dry guard consumes. NOTE: today runGroupedReview is wired ONLY into one-shot
// `audit review --groups`; the fix/endless loops still call runAuditReview (per-file), so a loop run
// does NOT yet drive convergence off cell coverage — that loop wiring is future work (council O1).
import fs from "node:fs";
import path from "node:path";

import { resolveLensGroups } from "./audit-lens-groups.mjs";
import { chunkSource } from "./audit-group-prompt.mjs";
import { DEFAULT_MAX_CELLS, capCells, enumerateCells, makeCellReviewer, runCellMatrix } from "./audit-cell-scheduler.mjs";
import { reviewerActive, selectUnits } from "./audit-review.mjs";
import { tierOfLens } from "./audit-tiers.mjs";
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
  const progress = typeof options.onProgress === "function" ? options.onProgress : null;

  if (models.length === 0 || files.length === 0 || groups.length === 0) {
    // Distinguish WHY nothing ran so the report doesn't misdiagnose an empty scope as "no reviewer"
    // (council Grok P2): no reachable seat vs no hotspot units vs no groups are different operator fixes.
    const ranReason = models.length === 0 ? "no reachable reviewer — nothing dispatched" : files.length === 0 ? "no hotspot units selected" : "no lens groups resolved";
    return { findings: [], refuted: [], reviewed: [], coverage: { complete: false, ran: false, ranReason, reviewers: reviewerMap(backends, options), groupPreset: options.lensGroups ?? "fine", groups: groups.length, unitsSelected: files.length, cellsScheduled: 0 } };
  }

  // Read each file ONCE (cache). A file too large to slurp (> READ_MAX_BYTES) OR unreadable is
  // recorded UNSUPPLIED and yields NO cells: an empty chunk would otherwise become a real cell that a
  // reviewer marks "done" with zero findings → a SILENT false-clean that still counted toward
  // six-eyes complete (council Grok P1 / Claude P2). Unsupplied files force complete:false and are
  // surfaced. A genuinely 0-byte file is trivially clean (no cells, not unsupplied). statSize/readFile
  // are injectable for deterministic tests.
  const statSize = deps.statSize ?? ((p) => fs.statSync(p).size);
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const chunkCache = new Map();
  const unsupplied = [];
  const chunksOf = (file) => {
    if (chunkCache.has(file)) return chunkCache.get(file);
    let chunks = [];
    try {
      const p = path.join(root, file);
      if (statSize(p) > READ_MAX_BYTES) unsupplied.push(file);
      else {
        const text = readFile(p);
        chunks = text ? chunkSource(text) : []; // 0-byte file → trivially clean, no cells
      }
    } catch {
      unsupplied.push(file); // unreadable → surfaced + forces incomplete, never a fake-done empty cell
    }
    chunkCache.set(file, chunks);
    return chunks;
  };
  const factsOf = (file) => factsFor(model, file);

  const allCells = enumerateCells(files, groups, models, chunksOf, factsOf);
  // enumerateCells forces ≥1 chunk PER FILE, so a file that produced NO real chunk would still get
  // real null-source cells — wasted spawns that could mark a triple "done" with nothing reviewed.
  // Drop cells for any such file: UNSUPPLIED files (oversize/unreadable — also force complete:false +
  // surfaced below) AND a legitimately empty 0-byte file (vacuously clean, contributes no cells and
  // does NOT force incomplete). Council round-2 (Grok): the earlier filter dropped only unsupplied.
  const noContent = new Set(files.filter((f) => (chunkCache.get(f)?.length ?? 0) === 0));
  const supplied = noContent.size ? allCells.filter((c) => !noContent.has(c.file)) : allCells;
  const { cells, dropped, capped } = capCells(supplied, options.maxCells ?? DEFAULT_MAX_CELLS);

  // Surface the planned cost BEFORE spending it (council Grok P1 / Claude nit): a grouped run can
  // dispatch ~1000+ paid spawns; the operator sees the count (and any cap / oversize skip) up front.
  if (progress) {
    progress(
      `  grouped review: ${models.length} seat(s) × ${groups.length} group(s) × ${files.length - noContent.size} file(s) → ${supplied.length} cell(s)` +
        `${capped ? `, capped to ${cells.length} (${dropped} deferred — raise --max-cells)` : ""}` +
        `${unsupplied.length ? `; ${unsupplied.length} file(s) too large or unreadable → coverage PARTIAL` : ""}`
    );
  }

  const reviewCell = deps.reviewCell ?? makeCellReviewer(cwd, backends, options);
  const runMatrix = deps.runMatrix ?? runCellMatrix;
  const matrixOut = await runMatrix(cells, reviewCell, {
    models,
    maxInflight: options.maxInflight,
    retryOnLimit: options.retryOnLimit,
    sleep: deps.sleep,
    onRetry: progress ? ({ attempt, ms }) => progress(`  cell rate-limited — backing off ${Math.round(ms / 1000)}s (retry ${attempt})…`) : undefined
  });

  // Merge + scope + ledger — the SAME post-processing the per-file path (runAuditReview) runs, so
  // downstream (normalize → tierOfLens → fix eligibility) treats grouped findings identically. Cell
  // findings carry `.agent` (the raising model), so grouping into one doc PER MODEL lets mergeFindings
  // detect true six-eyes consensus (a defect seen by ≥2 seats).
  const cellFindings = matrixOut.findings ?? [];
  // The group-authoritative lens (B5-stamped on each cell finding) must survive merge: mergeFindings
  // buckets do NOT carry `lens`, so without re-stamping the consumer's normalizeFindings would
  // re-derive it from the model-supplied CATEGORY — discarding the group's deliberate attribution and
  // mis-tiering e.g. a security-group finding the model labelled "bug" into Correctness (council
  // Claude P2). Key by finding id (buckets keep `ids`) → exact, no title fuzz.
  const lensById = new Map();
  for (const f of cellFindings) if (f?.id && f?.lens) lensById.set(String(f.id), f.lens);
  const relens = (f) => {
    const lenses = (f.ids ?? []).map((id) => lensById.get(String(id))).filter(Boolean);
    if (!lenses.length) return f;
    // Conflict rule (council Codex R1-3 + Grok round-2): when a bucket merges findings surfaced under
    // DIFFERENT lens groups, keep the most FOUNDATIONAL lens (lowest tier — logical/structure before
    // quality). On a TIER TIE, keep security_secrets — the lens the P0 live-hole override keys on — so
    // a security attribution never loses to a same-tier generic lens by mere id order.
    const lens = lenses.reduce((best, l) => {
      const tl = tierOfLens(l);
      const tb = tierOfLens(best);
      if (tl !== tb) return tl < tb ? l : best;
      if (best === "security_secrets" || l === "security_secrets") return best === "security_secrets" ? best : l;
      return best;
    });
    return { ...f, lens };
  };

  const byAgent = new Map();
  for (const f of cellFindings) {
    const a = f?.agent ?? "grouped";
    if (!byAgent.has(a)) byAgent.set(a, []);
    byAgent.get(a).push(f);
  }
  const docs = [...byAgent.entries()].map(([agent, findings]) => ({ agent, findings, parseOk: true }));
  const merged = mergeFindings(docs);
  const relensedAll = merged.all.map(relens);
  let scoped = annotateScopes({ all: relensedAll, consensus: relensedAll.filter((f) => f.consensus), unique: relensedAll.filter((f) => !f.consensus) });
  if (options.ledger !== false) scoped = recordAndAnnotate(cwd, options.jobId ?? "grouped-review", scoped, options.nowIso ?? nowIso());

  // Per-file review outcome from the matrix results (a file is REVIEWED when ≥1 of its cells
  // succeeded) so coverage mirrors runAuditReview's unitsReviewed/unitsAttempted/unitsFailed keys —
  // the loop's ran-detection keys on unitsReviewed (council Grok P2). Results are absent when
  // runMatrix is injected in a test → fall back to "all attempted files reviewed".
  const results = Array.isArray(matrixOut.results) ? matrixOut.results : [];
  const reviewedSet = new Set(results.filter((r) => r?.ok === true).map((r) => r?.cell?.file).filter(Boolean));
  // A file with NO content (unsupplied OR a vacuously-clean 0-byte file) had no cells, so it is not a
  // real review target — exclude it from attempted so an empty file is not miscounted as unitsFailed
  // while coverage claims complete (council Opus O3).
  const attempted = files.filter((f) => !noContent.has(f));
  const reviewedFiles = results.length ? attempted.filter((f) => reviewedSet.has(f)) : attempted;

  // capped OR an unsupplied (oversize/unreadable) file → never full coverage. When there were 0 cells
  // to schedule AND nothing was unsupplied (every selected file was vacuously empty), the run IS
  // vacuously complete — sixEyesComplete([]) is fail-closed false, so special-case it (council Codex C1).
  const complete = capped || unsupplied.length > 0 ? false : cells.length === 0 ? true : Boolean(matrixOut.complete);
  return {
    findings: scoped.all,
    refuted: scoped.refuted ?? [],
    reviewed: reviewedFiles,
    coverage: {
      complete,
      ran: true,
      groupPreset: options.lensGroups ?? "fine",
      reviewers: reviewerMap(backends, options),
      unitsSelected: files.length,
      unitsReviewed: reviewedFiles.length,
      unitsAttempted: attempted.length,
      unitsFailed: attempted.length - reviewedFiles.length,
      filesUnsupplied: unsupplied,
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
