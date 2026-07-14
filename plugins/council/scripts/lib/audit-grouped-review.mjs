// M7 wiring — the six-eyes GROUPED review path. Where runAuditReview reviews each hotspot FILE once
// with all lenses at once, runGroupedReview reviews each (file × lens-GROUP × chunk) CELL with all
// three models (B1 groups + B3 chunks + B2 finders + B4 matrix), so every defect class gets its own
// deep focused pass and coverage is measured cell-granularly. It is OPT-IN (--groups <preset>) and
// self-contained — the existing per-file path is untouched. Produces `complete` (strict six-eyes, for
// the one-shot report) + `passComplete` (scheduled cells reviewed, for the loop convergence guard).
// Wired into BOTH the one-shot `audit review --groups` AND the fix/endless loops (R9): a
// `audit fix --loop --groups` / `audit endless --groups` run drives its dry/tier convergence off
// passComplete, with each pass's cells capped to its per-pass agent-call budget.
import fs from "node:fs";
import path from "node:path";

import { resolveLensGroups } from "./audit-lens-groups.mjs";
import { cellSweepKey, scopeGroupsForTier } from "./audit-tier-sweep.mjs";
import { chunkSource } from "./audit-group-prompt.mjs";
import { DEFAULT_MAX_CELLS, capCells, cellKey, enumerateCells, makeCellReviewer, runCellMatrix } from "./audit-cell-scheduler.mjs";
import { makeBudget, reviewerActive, selectUnits } from "./audit-review.mjs";
import { activeSeatNames, allSeatNames, makeSeatRunners } from "./seats.mjs";
import { runCompletenessAssessment } from "./completeness-critic.mjs";
import { tierOfLens } from "./audit-tiers.mjs";
import { mergeFindings } from "./findings.mjs";
import { annotateScopes } from "./scope.mjs";
import { recordAndAnnotate } from "./ledger.mjs";
import { buildEvidence } from "./deliberate.mjs";
import { shouldVerify, verifyFindings } from "./verify.mjs";
import { nowIso, workspaceRoot } from "./state.mjs";
import { NOOP_REPORTER } from "./progress.mjs";

// SSOT (Wave 2 G): the review-eligibility size ceiling. EXPORTED so the sweep manifest builder
// (audit-fixloop-deps) imports the SAME constant AND the same `>` comparison — manifest eligibility and
// review eligibility can then never drift (a drift would silently OWE or under-owe a boundary-size file).
export const READ_MAX_BYTES = 2_000_000; // don't slurp a giant file into a chunker
// Ceiling on the refutation fan-out per pass. Each refutation is one PAID agent call ON TOP of the
// cells (the grouped path prices its work in cells, and the caller's cell cap already claimed that
// budget), so a pass surfacing a hundred single-agent P0/P1s must not silently double its bill. Any
// target beyond the ceiling is simply left UNVERIFIED — verifyFindings KEEPS a budget-starved finding
// (fail-closed: a missing verifier never erases a finding, it only leaves it unconfirmed).
const VERIFY_MAX_CALLS = 24;

/** The active finder models for this run (the three seats, minus any skipped/unavailable). */
export function activeModels(backends, options = {}) {
  return activeSeatNames(backends, options);
}

/** Static-facts string for a file, mirroring buildUnitPrompt's facts line (for the cell prompt). */
function factsFor(model, unitId) {
  const f = (model?.files ?? []).find((x) => x.id === unitId);
  return f
    ? `loc=${f.loc} branches=${f.branches} maxNesting≈${f.maxNesting} fan-in=${f.fanIn} fan-out=${f.fanOut} churn=${f.churn} smells=${f.smellCount} tested=${f.tested} hotspot=${f.hotspot}`
    : "(no static facts)";
}

/**
 * Run the grouped six-eyes review. `deps.runMatrix` / `deps.verifyFindings` are injectable for tests
 * (they default to the real runCellMatrix + makeCellReviewer / the real adversarial verifier). Returns
 * the same shape as runAuditReview: { findings, refuted, reviewed, coverage } — `refuted` is the
 * adversarial verifier's low-confidence bucket (those findings ALSO stay in `findings`, annotated), and
 * coverage carries `complete` (six-eyes over every scheduled cell), the group preset, cells
 * scheduled/dropped, refutedCount, and the matrix summary, so the loop + report can consume it.
 */
export async function runGroupedReview(cwd, model, backends, options = {}, deps = {}) {
  const root = workspaceRoot(cwd);
  const models = activeModels(backends, options);
  // BB1 (Wave 1 Stage 2): OPTIONAL tier-scoping. Resolve the full preset (unchanged), then — only when
  // an explicit `options.tier` is supplied — project each group onto that tier's lenses by INTERSECTION
  // (scopeGroupsForTier) BEFORE enumeration, so a tier-scoped pass enumerates ONLY that tier's lenses.
  // `tier == null/undefined` skips this entirely ⇒ enumeration is byte-identical to today (backward
  // compat). `tier` may be 0 (a real tier), so the guard is `!= null`, never a truthiness check.
  const baseGroups = resolveLensGroups(options.lensGroups ?? "fine");
  const groups = options.tier != null ? scopeGroupsForTier(baseGroups, options.tier) : baseGroups;
  // NOTE (Brocken B): honors the progressive `unitOffset` window, so it MUST stay a STATIC hotspot sort —
  // NO findingCounts here (a moving window over a dynamic sort could skip a file). Front-loading lives only
  // in the epoch-sweep pending scheduler (orderPendingFiles), where the durable ledger guarantees the drain.
  const files = selectUnits(model, { maxUnits: options.maxUnits ?? 12, offset: options.unitOffset ?? 0 });
  const progress = typeof options.onProgress === "function" ? options.onProgress : null;
  const reporter = options.reporter ?? NOOP_REPORTER;

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
  // WAVE 2 (epoch-sweep): the durable run-wide coverage cursor (sweep mode only, else null). Declared
  // HERE because the A-fix pending filter below needs it BEFORE capCells; the markDone side (onCell) uses
  // the same object.
  const sweep = options.sweep ?? null;
  // WAVE 2 (A — THE P0 FIX): in sweep mode, DROP cells already DONE in the durable ledger BEFORE capCells.
  // capCells takes a deterministic PREFIX rounded to whole triples. If it prefixes over the FULL cell set,
  // a file with more cells than maxCells re-schedules the SAME done prefix EVERY pass while cells past the
  // cap stay pending FOREVER → tierPending never reaches 0 → the tier never advances (the P0). Filtering to
  // PENDING cells first makes the cap's whole-triple budget land on UN-reviewed cells, so successive passes
  // DRAIN the tail (⌈cells/maxCells⌉ passes) with NO re-review of done cells (no waste). The SAME
  // cellSweepKey builder the ledger's done-rows use ⇒ a done cell is dropped byte-exactly. A PARTIAL triple
  // (some seats done, some pending) is CORRECT to schedule — its pending cell(s) COMPLETE the triple
  // against the durable done-rows; capCells' whole-triple rounding still applies to the pending set (it
  // never schedules a fraction that can't complete this pass, and the pending tail shrinks each pass).
  const pending =
    sweep && sweep.cursor && typeof sweep.cursor.isDone === "function"
      ? supplied.filter(
          (c) =>
            !sweep.cursor.isDone(
              cellSweepKey({
                epochHash: sweep.epochHash,
                tier: options.tier,
                group: c.group,
                seat: c.model,
                reviewerSet: sweep.reviewerSet,
                file: c.file,
                chunkIndex: c.chunk,
                chunkText: c.chunkData?.text ?? ""
              })
            )
        )
      : supplied;
  // Pass the ACTIVE seat count explicitly (council Grok P2): capCells caps on TRIPLE boundaries, and
  // inferring the model count from the cell slice alone would mis-round if the enumeration order ever
  // changed or a test injected a partial list — planning an uncompletable triple again.
  const { cells, dropped, capped } = capCells(pending, options.maxCells ?? DEFAULT_MAX_CELLS, { modelCount: models.length });

  // Surface the planned cost BEFORE spending it (council Grok P1 / Claude nit): a grouped run can
  // dispatch ~1000+ paid spawns; the operator sees the count (and any cap / oversize skip) up front.
  if (progress) {
    progress(
      `  grouped review: ${models.length} seat(s) × ${groups.length} group(s) × ${files.length - noContent.size} file(s) → ${pending.length} cell(s)` +
        `${capped ? `, capped to ${cells.length} (${dropped} deferred — raise --max-cells)` : ""}` +
        `${unsupplied.length ? `; ${unsupplied.length} file(s) too large or unreadable → coverage PARTIAL` : ""}`
    );
  }

  const reviewCell = deps.reviewCell ?? makeCellReviewer(cwd, backends, options);
  const runMatrix = deps.runMatrix ?? runCellMatrix;
  // B/C: the optional mid-pass guard (checkpoint-and-resume quota guard + durable reviewed-cell cursor)
  // and the durable findings appender (the SSOT the gate reads + the dashboard tails). Both are injected
  // by the loop; when absent (a plain one-shot review, or a unit test) the path is byte-identical.
  const guard = options.reviewGuard ?? deps.reviewGuard ?? null;
  const appender = options.findingsAppender ?? deps.findingsAppender ?? null;
  // WAVE 2 (epoch-sweep): the durable run-wide coverage cursor. When present (sweep mode only), a
  // reviewed cell's DONE-key is appended to the ledger AFTER its findings are durably flushed. The key
  // is built through `cellSweepKey` — THE SAME builder `expectedKeys` uses — from the cell's scoped
  // group object, seat, the frozen reviewer set, file, chunk index, and chunk text, so a reviewed
  // cell's done-key is byte-identical to the key coverage expects for it (the Wave 2 invariant).
  // (`sweep` is declared above the cell enumeration — the A-fix pending filter reads it before capCells.)
  let sweepError = null; // set if cursor.markDone THROWS (fsync failure) → the loop hard-stops sweep mode
  // WAVE 3 (findings-store staleness): in sweep mode each reviewed cell's SWEEP KEY (computed once in
  // onCell) is passed to the durable appender so its findings are STAMPED with their source cell identity.
  // The loop then EXCLUDES any stored finding whose stamped key is no longer an expected key under the
  // current sealed manifest/epoch (its chunk content moved), so the append-only store stops re-offering a
  // stale finding forever. Backward-tolerant: a non-sweep run passes no key ⇒ unstamped, always-current.
  // Cell-granular live progress (the FINEST resolution): after each cell completes, fold its findings
  // into the per-lens matrix and advance unitsDone. The grouped path is the one place a completed unit
  // is a single (file, group, model) cell, so the dashboard's Findings-by-lens table fills fastest here.
  reporter.progress({ unitsDone: 0, unitsTotal: cells.length });
  let cellsDone = 0;
  const matrixOut = await runMatrix(cells, reviewCell, {
    models,
    maxInflight: options.maxInflight,
    retryOnLimit: options.retryOnLimit,
    sleep: deps.sleep,
    guard,
    onRetry: progress ? ({ attempt, ms }) => progress(`  cell rate-limited — backing off ${Math.round(ms / 1000)}s (retry ${attempt})…`) : undefined,
    onCell: (r) => {
      cellsDone += 1;
      reporter.progress({ unitsDone: cellsDone, unitsTotal: cells.length });
      if (r && r.ok === true && Array.isArray(r.findings) && r.findings.length) {
        reporter.findings(r.findings, r.cell?.model ? { seat: r.cell.model } : undefined);
      }
      // C then B (ORDER MATTERS): flush this cell's findings to the durable store FIRST (fsync), THEN
      // mark the cell done in the resume cursor. A crash between the two re-reviews the cell (findings
      // re-appended, deduped) instead of skipping an unrecorded one — no lost finding, no double count.
      // A resume-SKIPPED cell (r.skipped) already recorded its findings + cursor key in the prior pass.
      if (r && r.ok === true && r.skipped !== true) {
        // A failed durable flush must NOT mark the cell done — else --resume skips it and its findings
        // are lost forever (the unsafe direction the design forbids). Only mark done when there was
        // nothing to flush OR the flush actually succeeded; a throw => re-review the cell on resume.
        // WAVE 3 (correction E): the reviewed cell's SWEEP KEY, computed ONCE (sweep mode only) INSIDE a try
        // that sets sweepError on throw — RESTORING the fail-closed hard-stop. It is used BOTH to STAMP this
        // cell's durable findings (source-cell identity for the staleness exclusion) AND to mark the cell done
        // below — the SAME cellSweepKey builder expectedKeys uses, so the two are byte-identical. A throw here
        // (a malformed cell) must HARD-STOP sweep mode via sweepError, NOT be swallowed by the scheduler
        // (onCell throws are swallowed) into a silently-pending cell that spins with its findings unappended.
        let sweepKey = null;
        if (sweep && sweep.cursor && r.cell && sweepError === null) {
          try {
            sweepKey = cellSweepKey({
              epochHash: sweep.epochHash,
              tier: options.tier,
              group: r.cell.group,
              seat: r.cell.model,
              reviewerSet: sweep.reviewerSet,
              file: r.cell.file,
              chunkIndex: r.cell.chunk,
              chunkText: r.cell.chunkData?.text ?? ""
            });
          } catch (err) {
            sweepError = String(err?.message ?? err);
          }
        }
        let flushed = true;
        if (appender && Array.isArray(r.findings) && r.findings.length) {
          try {
            appender.append(r.findings, { pass: options.pass, sweepCellKey: sweepKey, epochHash: sweep?.epochHash ?? null });
          } catch {
            flushed = false; // REVIEW is best-effort, but the cursor must reflect the durable truth
          }
        }
        if (flushed && guard && r.cell) guard.markDone(cellKey(r.cell));
        // WAVE 2: durable coverage ledger. ORDER IS LOAD-BEARING — the durable findings flush (fsync)
        // above ran FIRST; only now (and only if it succeeded) do we append the cell's DONE-key. A crash
        // between the two leaves the cell PENDING → re-reviewed (findings re-appended, deduped), never a
        // false-done with lost findings. markDone fsyncs the ledger and THROWS on a persistence failure;
        // we capture it (onCell throws are swallowed by the scheduler) so the loop can hard-stop sweep
        // mode instead of silently under-covering. After the first error we stop appending (a persistent
        // fsync failure must not spam) — the pass finishes its in-flight cells and the loop then stops.
        if (flushed && sweepKey && sweep && sweep.cursor && sweepError === null) {
          try {
            sweep.cursor.markDone(sweepKey, { pass: options.pass });
          } catch (err) {
            sweepError = String(err?.message ?? err);
          }
        }
      }
    }
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

  // A1: adversarial REFUTATION — the SAME pass the per-file path runs (runAuditReview), which the
  // grouped path never had: it returned `refuted: []` unconditionally, so no model ever challenged a
  // grouped finding, every single-agent P0/P1 stayed lifecycle "verification_required" forever and the
  // report gate could never settle. A P0/P1 SINGLE-agent finding is re-checked by a seat that did NOT
  // raise it (consensus is protected — one refuter never overturns independent agreement).
  // ANNOTATE-ONLY (demote:false), exactly like the audit path: a refuted finding stays VISIBLE in
  // `.all` carrying its `verified` annotation and is only DEPRIORITIZED downstream (evidenceState
  // "refuted" is the WEAKEST state, never the strongest) — the refuter is a biased single-seat signal,
  // so it must inform, not erase. Default-on; disable with verifyAudit:false. Needs ≥2 reachable seats
  // (a finding is never refuted by its own author). Best-effort: a verifier failure never drops the
  // review. deps.verifyFindings/deps.buildEvidence are injectable so tests need no CLI.
  let refutedCount = 0;
  let verifySpent = 0;
  if (options.verifyAudit !== false && models.length > 1) {
    const targets = (scoped.all ?? []).filter((f) => shouldVerify(f, options.verifySeverities ?? ["P0", "P1"]));
    if (targets.length) {
      // Refutation spend gets its OWN finite budget: options.budget on this path is the loop's
      // per-pass CELL allowance (a NUMBER, not a budget object — and `--budget` does not bound a
      // grouped run at all; --max-cells does). Cap it at VERIFY_MAX_CALLS and CHARGE what it spends
      // into coverage.budgetSpent, so the loop's accounting sees every paid call (council: the
      // completeness critic is charged the same way).
      const cap = Math.max(0, Math.floor(options.verifyMaxCalls ?? VERIFY_MAX_CALLS));
      const verifyBudget = makeBudget(cap);
      const verify = deps.verifyFindings ?? verifyFindings;
      const evidenceOf = deps.buildEvidence ?? buildEvidence;
      if (progress) progress(`  refutation: re-checking ${targets.length} single-agent P0/P1 finding(s) with an independent seat (≤${cap} call(s))…`);
      try {
        const vr = await verify(cwd, backends, { ...options, demote: false, budget: verifyBudget }, scoped, evidenceOf, root);
        scoped = vr.merged ?? scoped;
        refutedCount = vr.refutedCount ?? 0;
      } catch {
        /* refutation is best-effort — a verifier failure must never drop the review */
      }
      verifySpent = verifyBudget.spent;
      if (progress) progress(`  refutation: ${refutedCount} refuted (${verifySpent} verifier call(s) charged)`);
    }
  }

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
  // The results-absent fallback ("assume every attempted file was reviewed") exists ONLY for an injected
  // test runMatrix. It must key on whether any CELL WAS SCHEDULED — not on results.length — else a pass
  // that scheduled ZERO cells (a budget tail below the seat count → capCells keeps 0 whole triples)
  // reports unitsReviewed = ALL files while nothing was reviewed (council Fable P1).
  const reviewedFiles = cells.length === 0 ? [] : results.length ? attempted.filter((f) => reviewedSet.has(f)) : attempted;

  // TWO completeness signals (council R9 Codex/Claude P1):
  //  - `complete` (STRICT, for the one-shot report): capped OR an unsupplied file → never full six-eyes
  //    coverage; 0 cells with nothing unsupplied = vacuously complete.
  //  - `passComplete` (for the LOOP's convergence guard): were all SCHEDULED cells reviewed by all
  //    seats? This is TRANSIENT-completable — a failed cell (rate-limit) flips it false so the loop
  //    keeps going + retries, but a PERSISTENT cap/unsupplied does NOT force it false (those are
  //    surfaced as caveats, not re-reviewable work) — else the loop could NEVER converge, re-hitting
  //    the same cap every pass and burning to max-passes. Pass-local by nature (this window's cells);
  //    whole-project cell coverage across passes is a deliberate future enhancement.
  // A ZERO-CELL pass is only vacuously complete when there was genuinely NOTHING to schedule. When cells
  // were DROPPED (the budget tail fell below the active-seat count, so capCells could not keep even one
  // whole triple), the work still exists and was simply not affordable — reporting passComplete:true then
  // let the loop spin identical zero-review passes, charge 0 budget, and finally claim DRY CONVERGENCE
  // over work it never looked at (council Fable P1). Fail-closed: unaffordable work is INCOMPLETE.
  const nothingSchedulable = cells.length === 0 && dropped === 0;
  const passComplete = cells.length === 0 ? nothingSchedulable : Boolean(matrixOut.complete);
  const complete = capped || unsupplied.length > 0 ? false : passComplete;
  // Surface WHY a pass reviewed nothing so the operator (and the loop's stop reason) can tell an empty
  // scope apart from a starved one.
  const starved = cells.length === 0 && dropped > 0;

  // M8 completeness critic (OPT-IN via --completeness-critic): augment the STRUCTURAL passComplete with
  // a THOROUGHNESS judgement — the incomplete (failed/unreviewed) SCHEDULED triples + ONE model critic
  // call ("what defect class looks under-examined?"). Its coverageComplete ANDs into the loop's dry-streak
  // gate so a pass judged incomplete keeps the run hunting. Deadlock-safe: it uses runCompletenessAssessment's
  // coverageComplete (structure+critic, NO dry streak), and an infra failure degrades to undefined
  // (unknown → does not block).
  //
  // We DELIBERATELY do NOT pass expectedGroups/expectedFiles here (council Codex/Claude P2): the structural
  // gap check is PER-PASS, and a capped pass (capCells drops tail files) or a selected 0-byte file would
  // then be flagged "missing" PERSISTENTLY → completenessComplete=false every pass → the loop could never
  // converge (re-opening exactly the persistent-false the R9 passComplete design avoids). The cap/unsupplied
  // are surfaced as caveats elsewhere (capped/filesUnsupplied), not treated as re-reviewable gaps. So the
  // structural signal is just the incomplete SCHEDULED triples (failed cells) — the same set passComplete
  // keys on — plus the critic. Whole-project "class never hunted" detection belongs to a future
  // whole-project matrix, not this per-pass window. Reserves ONE agent call; skipped when off / nothing ran.
  let completeness = null;
  if (options.completenessCritic && cells.length > 0 && models.length > 0) {
    const incompleteN = matrixOut.matrix?.incompleteTriples?.(matrixOut.triples ?? [])?.length ?? "?";
    const coverageSummary = [
      `groups=${groups.length} files=${files.length - noContent.size} seats=${models.length} cells=${cells.length}${capped ? ` (capped, ${dropped} deferred)` : ""}`,
      unsupplied.length ? `filesUnsupplied=${unsupplied.length}` : "",
      `incompleteTriples=${incompleteN}`,
      `findings=${scoped.all.length}`
    ].filter(Boolean).join("; ");
    // One critic call, routed through the first active seat's runner (model-agnostic; the critic judges
    // coverage, not code). Injectable so tests need no CLI.
    const runCritic = deps.runCritic ?? (() => {
      const runners = makeSeatRunners(cwd, backends, options);
      const run = runners[models[0]];
      return run ? (prompt) => run(prompt).then((r) => (r && !r.skipped && r.status === 0 ? r.stdout : "")) : null;
    })();
    if (progress) progress("  completeness critic: judging coverage thoroughness (1 call)…");
    completeness = await runCompletenessAssessment({
      matrix: matrixOut.matrix,
      triples: matrixOut.triples ?? [],
      findings: scoped.all,
      coverageSummary,
      runCritic: typeof runCritic === "function" ? runCritic : undefined
    });
    if (progress && completeness) {
      const verdict = completeness.coverageComplete === true ? "thorough" : completeness.coverageComplete === false ? `gaps (${completeness.gaps.length})` : "unknown (critic unavailable)";
      progress(`  completeness: ${verdict}`);
    }
  }

  return {
    findings: scoped.all,
    refuted: scoped.refuted ?? [],
    reviewed: reviewedFiles,
    coverage: {
      complete,
      passComplete, // the loop convergence signal (scheduled cells done; capped/unsupplied don't block it)
      // M8: the completeness-critic verdict (opt-in). undefined when off / infra-degraded → the loop
      // treats it as non-blocking; false (structural gap or critic-found gap) keeps the run hunting.
      ...(completeness ? { completenessComplete: completeness.coverageComplete, completenessGaps: completeness.gaps, completenessCriticRan: completeness.criticRan } : {}),
      // A STARVED pass (work existed but the budget tail couldn't afford one whole triple) did NOT run —
      // reporting ran:true let the loop count it toward the dry streak and stop as "converged" (Fable P1).
      ran: !starved,
      ...(starved ? { ranReason: `budget tail below the active-seat count — 0 whole triples affordable (${dropped} cell(s) deferred)`, starved: true } : {}),
      // WAVE 2: a durable-ledger persistence failure during markDone. The loop turns this into a hard
      // stop (the sweep's coverage denominator can no longer be trusted). null on a normal pass.
      ...(sweepError ? { sweepError } : {}),
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
      // B: cells the durable cursor RESUME-SKIPPED (0 paid calls — reviewed in a prior interrupted pass)
      // and cells the mid-pass guard QUIESCED before dispatch (0 paid calls). `quiesced` is the breach
      // marker the loop turns into the SAME between-pass hard-stop / pause (SSOT); null on a normal pass.
      cellsSkipped: matrixOut.skipped ?? 0,
      cellsQuiesced: cells.length - (matrixOut.dispatched ?? cells.length) - (matrixOut.skipped ?? 0),
      quiesced: matrixOut.quiesced ?? null,
      capped,
      // How many single-agent P0/P1 findings an independent seat could NOT support (annotate-only: they
      // stay in `findings`, deprioritized, and are also listed under `refuted`).
      refutedCount,
      verifySpent, // paid refutation calls (≤ VERIFY_MAX_CALLS) — surfaced so the extra spend is visible
      // budgetSpent = the cells actually dispatched (each cell is one paid agent call) PLUS the one
      // completeness-critic call when it ran (council Codex/Claude P2: it is a real agent call and must be
      // charged, else the loop overspends its per-pass budget by one and under-reports total spend) PLUS
      // the refutation calls (A1 — same reasoning: a verifier spawn is a paid call). The fix/endless loop
      // charges this against its per-run agent-call budget; makeFixLoopDeps RESERVES one cell for the
      // critic so cells + critic ≤ budget, and the refutation pass is bounded by VERIFY_MAX_CALLS.
      // + EXTRA calls: a parse repair and a rate-limit retry each re-invoke a seat runner, i.e. each is
      // another PAID agent call. Omitting them let a throttled/garbled pass spawn far more calls than it
      // reported (council Grok P1/P2) — the loop then paced itself off a spend figure that was too low.
      // Charge only the cells actually DISPATCHED (a resume-skipped or quiesced cell spent 0 paid calls),
      // plus the critic + refutation + repair/retry extras. matrixOut.dispatched is absent for an injected
      // test runMatrix → fall back to the full cell count (byte-identical to before B).
      budgetSpent: (matrixOut.dispatched ?? cells.length) + (completeness?.criticRan ? 1 : 0) + verifySpent + (Number(matrixOut.extraCalls) || 0),
      // surfaced so the operator can see WHY a pass cost more than its cell count
      extraCalls: Number(matrixOut.extraCalls) || 0,
      repairCalls: Number(matrixOut.repairCalls) || 0,
      retryCalls: Number(matrixOut.retryCalls) || 0,
      // the grouped path bounds per-pass cost by the CELL count (maxCells); the matrix summary reports
      // how many of those cells actually completed vs failed.
      matrix: matrixOut.matrix?.summary?.() ?? null
    }
  };
}

function reviewerMap(backends, options) {
  return Object.fromEntries(allSeatNames(backends).map((s) => [s, reviewerActive(s, backends, options)]));
}
