// M7/B4 — cell-granular coverage matrix + bounded scheduler for the six-eyes finder.
//
// A review CELL is the atomic unit of work: (model × lens-group × file × chunk). The finder is
// six-eyes complete for a (group, file, chunk) TRIPLE only when ALL active models have reviewed
// it. This module enumerates the cells (from B1 groups + B3 chunks + B2's three models), runs them
// through a MANDATORY concurrency semaphore (else N files × 30 groups × 3 models fans out thousands
// of concurrent CLI spawns), retries a rate-limited cell in isolation (one throttled cell can't
// fail the run), and tracks completion in a coverage matrix. Convergence over the matrix is B5.
import { buildGroupPrompt } from "./audit-group-prompt.mjs";
import { runCodexStructured, runGrokStructured } from "./agents.mjs";
import { runClaudeStructured } from "./claude-agent.mjs";
import { isRateLimitError, retryOnRateLimit } from "./audit-retry.mjs";
import { parseAgentFindings } from "./findings.mjs";

export const DEFAULT_MAX_INFLIGHT = 6; // mandatory concurrency cap (target 4–8)
export const DEFAULT_MAX_CELLS = 4000; // total-cell backstop for capCells (a cost guard; B5 sets policy)
const MAX_INFLIGHT_CEILING = 16;

// Cell/triple keys are a JSON array of their dimensions — unambiguous + collision-free (JSON
// escaping keeps a path containing any separator distinct) AND printable, so this stays a normal
// text .mjs. A raw NUL separator (an earlier approach) made git treat the file as BINARY → no
// reviewable diffs (council B4, Claude seat).
/** Stable key for a cell (model × groupId × file × chunkIndex). */
export function cellKey(cell) {
  return JSON.stringify([cell.model, cell.groupId, cell.file, cell.chunk]);
}

/**
 * Enumerate review cells: one per (model, groupId, file, chunkIndex). `chunksOf(file)` returns the
 * file's chunk array (from chunkSource); optional `factsOf(file)` attaches per-file static facts to
 * each cell so buildGroupPrompt can surface them (council B4 grok-4). Deterministic order
 * (file → group → chunk → model) so a run is reproducible and resumable. A file with 0 chunks still
 * yields 1 cell per (group,model) so an empty/unreadable file is visibly covered, not silently skipped.
 */
export function enumerateCells(files, groups, models, chunksOf, factsOf = null) {
  const cells = [];
  for (const file of files) {
    const chunks = chunksOf(file) ?? [];
    const nChunks = Math.max(1, chunks.length);
    const facts = typeof factsOf === "function" ? factsOf(file) : undefined;
    for (const group of groups) {
      for (let c = 0; c < nChunks; c += 1) {
        for (const model of models) {
          cells.push({ model, groupId: group.id, group, file, chunk: c, chunkTotal: nChunks, chunkData: chunks[c] ?? null, facts });
        }
      }
    }
  }
  return cells;
}

/**
 * Bound the TOTAL cell count (concurrency is capped separately). files × 30 groups × chunks × 3
 * models can reach thousands of paid model calls, so a run must have a total backstop the way the
 * fix loop caps total writes with maxFixes (council B4 grok-2). Truncation is EXPLICIT: returns
 * `{ cells, dropped, capped }` so the caller can log what was left for a later pass — never a silent cap.
 */
export function capCells(cells, maxCells = DEFAULT_MAX_CELLS) {
  const cap = Number.isFinite(maxCells) && maxCells > 0 ? Math.floor(maxCells) : DEFAULT_MAX_CELLS;
  if (cells.length <= cap) return { cells, dropped: 0, capped: false };
  return { cells: cells.slice(0, cap), dropped: cells.length - cap, capped: true };
}

/** Distinct (groupId, file, chunk) triples across a cell list — the units six-eyes is measured on. */
export function triplesOf(cells) {
  const seen = new Set();
  const triples = [];
  for (const c of cells) {
    const k = JSON.stringify([c.groupId, c.file, c.chunk]);
    if (seen.has(k)) continue;
    seen.add(k);
    triples.push({ groupId: c.groupId, file: c.file, chunk: c.chunk });
  }
  return triples;
}

/**
 * A coverage matrix over cells. `markDone`/`markFailed` record per-cell outcomes; a triple is
 * six-eyes complete iff EVERY active model has a DONE cell for it. A once-done cell can't be
 * un-done by a later failure (markFailed no-ops on a done cell) so a retry that eventually
 * succeeds sticks. Pure + serializable. NOTE (council B4 grok-5): `models` is the completeness
 * denominator — pass EXACTLY the models that actually produce cells, or triples that never got a
 * cell for a listed-but-absent model can never complete (fail-closed: they stay incomplete).
 */
export function makeCoverageMatrix(models = []) {
  const activeModels = [...new Set(models)];
  const done = new Set();
  const failed = new Set();
  const isDone = (cell) => done.has(cellKey(cell));
  const tripleComplete = (triple) =>
    activeModels.length > 0 &&
    activeModels.every((m) => done.has(cellKey({ model: m, groupId: triple.groupId, file: triple.file, chunk: triple.chunk })));
  return {
    models: activeModels,
    markDone(cell) {
      const k = cellKey(cell);
      done.add(k);
      failed.delete(k);
    },
    markFailed(cell) {
      const k = cellKey(cell);
      if (!done.has(k)) failed.add(k);
    },
    isDone,
    tripleComplete,
    /** Whole-matrix six-eyes complete: every given triple reviewed by every active model. */
    sixEyesComplete: (triples) => triples.length > 0 && triples.every(tripleComplete),
    incompleteTriples: (triples) => triples.filter((t) => !tripleComplete(t)),
    summary: () => ({ models: activeModels.length, done: done.size, failed: failed.size })
  };
}

/**
 * Run `runCell` over `cells` under a MANDATORY concurrency cap: at most `maxInflight` (clamped
 * 1..16, default 6) in flight at once. Preserves input order in `results`. A cell whose runCell
 * throws resolves to `{ ok:false, error }` — one bad cell never rejects the whole batch.
 */
export async function scheduleCells(cells, runCell, { maxInflight = DEFAULT_MAX_INFLIGHT } = {}) {
  const limit = Math.max(1, Math.min(MAX_INFLIGHT_CEILING, Number.isFinite(maxInflight) ? Math.floor(maxInflight) : DEFAULT_MAX_INFLIGHT));
  const results = new Array(cells.length);
  let next = 0;
  async function worker() {
    while (next < cells.length) {
      const idx = next;
      next += 1;
      try {
        results[idx] = await runCell(cells[idx], idx);
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, cells.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Wrap a per-cell reviewer with PER-CELL rate-limit retry: a transient 429/529 backs off and
 * retries THIS cell (not the batch), so one throttled cell can't fail the run. `sleep` is
 * injectable for tests; non-rate-limit errors propagate (the scheduler records them as failed).
 */
export function withCellRetry(runCell, { retryOnLimit = true, retries, sleep, onRetry } = {}) {
  if (!retryOnLimit) return runCell;
  return (cell, idx) => retryOnRateLimit(() => runCell(cell, idx), { retries, sleep, onRetry });
}

/**
 * Build a `reviewCell(cell)` that assembles the group+chunk prompt (B3), runs the cell's MODEL as
 * an independent finder (B2), and parses its findings. Injectable per-model runners for tests.
 * Returns `{ ok, cell, findings? , unparsed?, res? }`: ok:false for a skipped/timed-out/errored/
 * unparseable run (fail-closed — a dead backend never manufactures an empty clean review).
 *
 * A THROTTLED backend signals 429/529 via a non-zero exit + stderr text, NOT by throwing, so a bare
 * return would make withCellRetry's retryOnRateLimit a no-op for the real CLIs (council B4 grok-1).
 * Here a rate-limit signal is re-THROWN so the retry actually backs off this cell; a permanent or
 * non-rate-limit failure returns ok:false (recorded failed, not retried).
 */
export function makeCellReviewer(cwd, backends, options = {}, deps = {}) {
  const runners = {
    codex: deps.runCodex ?? ((p) => runCodexStructured(cwd, backends, options, p, "audit")),
    grok: deps.runGrok ?? ((p) => runGrokStructured(cwd, backends, options, p)),
    claude: deps.runClaude ?? ((p) => runClaudeStructured(cwd, backends, options, p))
  };
  return async (cell) => {
    const run = runners[cell.model];
    if (!run) return { ok: false, cell, reason: `no runner for model ${cell.model}` };
    const prompt = buildGroupPrompt(cell.file, cell.group, cell.chunkData, cell.facts ?? "(no static facts)");
    const res = await run(prompt);
    const failedRun = !res || res.skipped || res.timedOut || res.truncated || (res.status != null && res.status !== 0);
    if (failedRun) {
      // A non-skipped run whose stderr/stdout carries a transient rate-limit signal is re-thrown so
      // withCellRetry backs off THIS cell (the CLI exits non-zero on a 429, it does not throw).
      if (res && !res.skipped && isRateLimitError(`${res.stderr ?? ""}\n${res.stdout ?? ""}`)) {
        throw new Error(`cell rate-limited (${cell.model}): ${String(res.stderr ?? "").slice(0, 160)}`);
      }
      return { ok: false, cell, res };
    }
    const doc = parseAgentFindings(res.stdout, cell.model);
    if (!doc.parseOk) return { ok: false, cell, res, unparsed: true };
    // B5: stamp each finding's LENS from the GROUP it was found in — the pass is scoped to exactly
    // one group, so the group's parent lens is authoritative (a model-claimed class would anyway be
    // re-found + tagged by that class's own group pass under six-eyes). Without this, tierOfLens(
    // f.lens) sees undefined → the finding falls into the Quality tier and structure-first per-tier
    // staging silently breaks. Falls back to any model lens only when the group has none.
    const groupLens = cell.group?.lenses?.[0] ?? null;
    const findings = doc.findings.map((f) => ({ ...f, lens: groupLens ?? f.lens ?? null }));
    return { ok: true, cell, findings };
  };
}

/**
 * Schedule the whole cell matrix: run each cell (with per-cell rate-limit retry) under the
 * semaphore, record outcomes into a coverage matrix, and collect the findings. Returns
 * `{ results, matrix, findings, complete, triples }`. A cell result with ok === true marks the
 * matrix DONE; anything else (including an `ok`-less shape) marks it FAILED, symmetric with the
 * findings collection, so a triple is never wrongly reported complete with zero findings
 * (council B4 grok-3). An unreviewed/failed cell keeps its triple incomplete → B5's convergence
 * knows there is still work.
 */
export async function runCellMatrix(cells, reviewCell, { models, maxInflight, retryOnLimit = true, retries, sleep, onRetry } = {}) {
  const matrix = makeCoverageMatrix(models ?? [...new Set(cells.map((c) => c.model))]);
  const runOne = withCellRetry(reviewCell, { retryOnLimit, retries, sleep, onRetry });
  const results = await scheduleCells(
    cells,
    async (cell, idx) => {
      const r = await runOne(cell, idx);
      if (r && r.ok === true) matrix.markDone(cell);
      else matrix.markFailed(cell);
      return r;
    },
    { maxInflight }
  );
  const findings = results.filter((r) => r && r.ok === true && Array.isArray(r.findings)).flatMap((r) => r.findings);
  const triples = triplesOf(cells);
  return { results, matrix, findings, complete: matrix.sixEyesComplete(triples), triples };
}
