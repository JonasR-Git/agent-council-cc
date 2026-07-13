// M7/B4 — cell-granular coverage matrix + bounded scheduler for the six-eyes finder.
//
// A review CELL is the atomic unit of work: (model × lens-group × file × chunk). The finder is
// six-eyes complete for a (group, file, chunk) TRIPLE only when ALL active models have reviewed
// it. This module enumerates the cells (from B1 groups + B3 chunks + B2's three models), runs them
// through a MANDATORY concurrency semaphore (else N files × 30 groups × 3 models fans out thousands
// of concurrent CLI spawns), retries a rate-limited cell in isolation (one throttled cell can't
// fail the run), and tracks completion in a coverage matrix. Convergence over the matrix is B5.
import { buildGroupPrompt } from "./audit-group-prompt.mjs";
import { buildReformatPrompt, runStructuredWithRetry } from "./agents.mjs";
import { makeSeatRunners } from "./seats.mjs";
import { isRateLimitError, retryOnRateLimit } from "./audit-retry.mjs";
import { parseAgentFindings } from "./findings.mjs";
import { categoryToLens } from "./audit-normalize.mjs";

export const DEFAULT_MAX_INFLIGHT = 6; // mandatory concurrency cap (target 4–8)
export const DEFAULT_MAX_CELLS = 4000; // total-cell backstop for capCells (a cost guard; B5 sets policy)
export const DEFAULT_CELL_REPAIR_CALLS = 1; // extra agent calls ONE garbled cell may spend (one-shot reformat)
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
 *
 * The cap lands on a TRIPLE BOUNDARY (council A4). MODEL is enumerateCells' INNERMOST dimension, so a
 * raw slice(0, cap) whose cap is not a multiple of the active-seat count plans a PARTIAL triple: paid
 * calls are spent on a (group,file,chunk) that can NEVER be six-eyes complete → tripleComplete never
 * returns true → passComplete stays false → the fix/endless loop can never converge. That is the
 * COMMON case, not a corner: --completeness-critic sets maxCells = passBudget - 1 (1499 % 3 = 2). So
 * the cap is rounded DOWN to a whole number of triples. A cap BELOW the model count schedules ZERO
 * cells: an honest "nothing could be planned" (dropped tells the caller how much) beats burning paid
 * calls on a triple that can never complete. `modelCount` defaults to the distinct models in `cells`.
 */
export function capCells(cells, maxCells = DEFAULT_MAX_CELLS, { modelCount } = {}) {
  const cap = Number.isFinite(maxCells) && maxCells > 0 ? Math.floor(maxCells) : DEFAULT_MAX_CELLS;
  if (cells.length <= cap) return { cells, dropped: 0, capped: false };
  const models =
    Number.isFinite(modelCount) && modelCount > 0 ? Math.floor(modelCount) : new Set(cells.map((c) => c.model)).size || 1;
  const keep = Math.floor(cap / models) * models; // whole triples only — never a partial, uncompletable one
  return { cells: cells.slice(0, keep), dropped: cells.length - keep, capped: true };
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
export async function scheduleCells(cells, runCell, { maxInflight = DEFAULT_MAX_INFLIGHT, onCell = null } = {}) {
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
      // Per-cell completion hook (live cell-granular progress). Fail-soft: a throwing
      // hook must never break the scheduler — the review is the work, telemetry is not.
      if (typeof onCell === "function") {
        try {
          onCell(results[idx], idx);
        } catch {
          /* swallow — telemetry never breaks the batch */
        }
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

// The cell reviewer's reformat schema hint. A reformat re-runs FRESH (the original task is no longer
// in context), so the hint must carry the shape itself. Mirrors the per-file audit path's hint
// (audit-review's FINDINGS_REFORMAT_HINT — module-private there); both parse with parseAgentFindings.
const CELL_REFORMAT_HINT =
  'a findings report JSON object: {"agent","summary","verdict","findings":[{severity,category,title,detail,file,line,confidence}]}';

/**
 * A FINITE repair budget for ONE cell: at most `max` extra agent calls, and only while an optional
 * SHARED budget (deps.repairBudget — a whole-matrix cap) also affords them. runStructuredWithRetry
 * asks canSpend() before every extra call and charge()s it, so with max=1 the cheap reformat is spent
 * and the full reminder re-run is DECLINED: a genuinely one-shot repair, never a per-cell cost blow-up
 * (a systematically garbling seat would otherwise silently triple the paid cost of every one of its
 * cells, and the grouped path bounds cost by CELLS, not by an agent-call budget).
 */
function makeRepairBudget(max, shared = null) {
  let spent = 0;
  return {
    canSpend: (n = 1) => spent + n <= max && (!shared || shared.canSpend(n)),
    charge: (n = 1) => {
      spent += n;
      if (shared) shared.charge(n);
    },
    remaining: () => max - spent,
    get total() {
      return max;
    },
    get spent() {
      return spent;
    }
  };
}

/**
 * A run that can never become a review: absent, skipped, timed out, TRUNCATED (the child was killed
 * mid-output, so the reply is clipped), or a non-zero exit. Fail-closed — and NOT repairable either:
 * a reformat can only reshape content that is actually there.
 */
function failedRun(res) {
  return !res || res.skipped || res.timedOut || res.truncated || (res.status != null && res.status !== 0);
}

/**
 * Build a `reviewCell(cell)` that assembles the group+chunk prompt (B3), runs the cell's MODEL as
 * an independent finder (B2), and parses its findings. Injectable per-model runners for tests.
 * Returns `{ ok, cell, findings? , unparsed?, res?, repairCalls }`: ok:false for a skipped/timed-out/
 * errored/unparseable run (fail-closed — a dead backend never manufactures an empty clean review).
 *
 * A THROTTLED backend signals 429/529 via a non-zero exit + stderr text, NOT by throwing, so a bare
 * return would make withCellRetry's retryOnRateLimit a no-op for the real CLIs (council B4 grok-1).
 * Here a rate-limit signal is re-THROWN so the retry actually backs off this cell; a permanent or
 * non-rate-limit failure returns ok:false (recorded failed, not retried).
 *
 * PARSE REPAIR (council A4): a reply that RAN fine but is merely GARBLED (prose preamble, stray fence,
 * trailing comma) gets the same one-shot reformat the per-file path has long had via
 * runStructuredWithRetry — hand the model its own unparseable reply and ask it to reshape THAT content
 * (no re-analysis). Without it, one malformed reply permanently loses a PAID cell AND keeps its triple
 * six-eyes-incomplete forever, so the loop can never converge. The repair goes through the SAME
 * injected seat runner (tests need no CLI) and is charged to a finite per-cell budget (plus an optional
 * shared deps.repairBudget), surfaced as `repairCalls` so cost accounting stays honest. Only a
 * REPAIRABLE run earns it — a skipped/timed-out/truncated/errored run has no content to reshape, so it
 * costs nothing extra and stays fail-closed. A cell still unparseable after the repair stays ok:false.
 * maxCellRepairCalls:0 restores the old no-repair behaviour exactly.
 */
export function makeCellReviewer(cwd, backends, options = {}, deps = {}) {
  // Runner per seat (built-ins + any configured OpenRouter seats), via the dynamic registry. deps.run*
  // overrides stay honored (existing cell-scheduler tests inject runCodex/runGrok/runClaude).
  const runners = makeSeatRunners(cwd, backends, options, deps);
  const maxRepair =
    Number.isFinite(options.maxCellRepairCalls) && options.maxCellRepairCalls >= 0
      ? Math.floor(options.maxCellRepairCalls)
      : DEFAULT_CELL_REPAIR_CALLS;
  return async (cell) => {
    const run = runners[cell.model];
    if (!run) return { ok: false, cell, reason: `no runner for model ${cell.model}`, repairCalls: 0 };
    const prompt = buildGroupPrompt(cell.file, cell.group, cell.chunkData, cell.facts ?? "(no static facts)");
    const parse = (stdout) => parseAgentFindings(stdout, cell.model);
    let res = await run(prompt);
    let repairCalls = 0;

    if (maxRepair > 0 && !failedRun(res) && parse(res.stdout)?.parseOk === false) {
      const budget = makeRepairBudget(maxRepair, deps.repairBudget ?? null);
      // runStructuredWithRetry issues the task call ITSELF, so serve it the reply we already paid for
      // (once) — the repair then costs exactly the reformat, and its budget declines the full reminder
      // re-run (maxRetries:1 only opens the loop the reformat lives in).
      let served = false;
      const runFor = async (p) => {
        if (served) return run(p);
        served = true;
        return res;
      };
      const out = await runStructuredWithRetry(runFor, prompt, parse, {
        maxRetries: 1,
        reformat: (garbled) => buildReformatPrompt(garbled, { schemaHint: CELL_REFORMAT_HINT }),
        budget
      });
      repairCalls = budget.spent;
      if (out) res = out; // the repaired reply when the reformat parsed, else the original (still fail-closed below)
    }

    if (failedRun(res)) {
      // A non-skipped run whose stderr/stdout carries a transient rate-limit signal is re-thrown so
      // withCellRetry backs off THIS cell (the CLI exits non-zero on a 429, it does not throw).
      if (res && !res.skipped && isRateLimitError(`${res.stderr ?? ""}\n${res.stdout ?? ""}`)) {
        throw new Error(`cell rate-limited (${cell.model}): ${String(res.stderr ?? "").slice(0, 160)}`);
      }
      return { ok: false, cell, res, repairCalls };
    }
    const doc = parse(res.stdout);
    if (!doc.parseOk) return { ok: false, cell, res, unparsed: true, repairCalls };
    // Stamp three authoritative facts from the CELL onto each finding (council fleet P1s):
    //  1. FILE: the cell reviewed a KNOWN file (cell.file). The model may omit/mis-state `file`, so
    //     forcing cell.file prevents lost/wrong targets downstream (Grok G2).
    //  2. ID: model-emitted ids are NOT unique across cells (parseAgentFindings falls back to
    //     `${agent}-${i+1}`, and the prompt shows "x-1"), so a model reviewing one file across many
    //     groups re-emits "codex-1" for the 1st finding of EVERY group. The grouped path re-stamps
    //     the group lens by finding id, so colliding ids cross-contaminate lenses (Opus O3/O8, Grok
    //     G9). Make the id globally unique by prefixing the cell key.
    //  3. LENS: so tierOfLens(f.lens) works. SINGLE-lens group → its lens is authoritative. MULTI-lens
    //     group (tier preset) → keep the model's lens if it's one of the group's; else DERIVE from the
    //     finding category (a security finding in a tier cell must not silently become lenses[0]
    //     =correctness — Codex C1); else fall back to lenses[0].
    const lenses = Array.isArray(cell.group?.lenses) ? cell.group.lenses : [];
    const pickLens = (f) => {
      if (lenses.length === 1) return lenses[0];
      if (f.lens && lenses.includes(f.lens)) return f.lens;
      const derived = categoryToLens(f.category, null);
      if (derived && lenses.includes(derived)) return derived;
      return f.lens ?? lenses[0] ?? null;
    };
    const findings = doc.findings.map((f, i) => ({ ...f, file: cell.file, id: `${cellKey(cell)}#${i}`, lens: pickLens(f) }));
    return { ok: true, cell, findings, repairCalls };
  };
}

/**
 * Schedule the whole cell matrix: run each cell (with per-cell rate-limit retry) under the
 * semaphore, record outcomes into a coverage matrix, and collect the findings. Returns
 * `{ results, matrix, findings, complete, triples, repairCalls }` — `repairCalls` is the EXTRA
 * (reformat) agent calls the parse repair spent across the matrix, so a caller that budgets one call
 * per cell can account for them honestly instead of under-reporting spend. A cell result with ok === true marks the
 * matrix DONE; anything else (including an `ok`-less shape) marks it FAILED, symmetric with the
 * findings collection, so a triple is never wrongly reported complete with zero findings
 * (council B4 grok-3). An unreviewed/failed cell keeps its triple incomplete → B5's convergence
 * knows there is still work.
 */
export async function runCellMatrix(cells, reviewCell, { models, maxInflight, retryOnLimit = true, retries, sleep, onRetry, onCell } = {}) {
  const matrix = makeCoverageMatrix(models ?? [...new Set(cells.map((c) => c.model))]);
  // A rate-limit RETRY re-invokes the seat runner — i.e. it is another PAID agent call (council Grok P2:
  // these were invisible to the budget, so a throttled pass could spawn several times its allowance while
  // reporting only the scheduled-cell count). Count them so the caller can charge them honestly.
  let retryCalls = 0;
  const countRetry = (info) => {
    retryCalls += 1;
    if (typeof onRetry === "function") onRetry(info);
  };
  const runOne = withCellRetry(reviewCell, { retryOnLimit, retries, sleep, onRetry: countRetry });
  const results = await scheduleCells(
    cells,
    async (cell, idx) => {
      // A cell that THROWS (retries exhausted, or a non-rate-limit error) must still be recorded
      // FAILED in the matrix — else scheduleCells' catch records {ok:false} but the triple is left
      // neither done nor failed, so the matrix summary loses the failed cell (council Grok G2 / Codex
      // C1). Catch here and markFailed before returning a normal ok:false result.
      let r;
      try {
        r = await runOne(cell, idx);
      } catch (err) {
        matrix.markFailed(cell);
        return { ok: false, cell, error: String(err?.message ?? err) };
      }
      if (r && r.ok === true) matrix.markDone(cell);
      else matrix.markFailed(cell);
      return r;
    },
    { maxInflight, onCell }
  );
  const findings = results.filter((r) => r && r.ok === true && Array.isArray(r.findings)).flatMap((r) => r.findings);
  const repairCalls = results.reduce((n, r) => n + (Number.isFinite(r?.repairCalls) ? r.repairCalls : 0), 0);
  const triples = triplesOf(cells);
  // extraCalls = every PAID agent call beyond the one-per-scheduled-cell baseline (parse repairs +
  // rate-limit retries). The caller charges these into coverage.budgetSpent so the loop's accounting sees
  // the true spend (council Grok P1/P2).
  return { results, matrix, findings, complete: matrix.sixEyesComplete(triples), triples, repairCalls, retryCalls, extraCalls: repairCalls + retryCalls };
}
