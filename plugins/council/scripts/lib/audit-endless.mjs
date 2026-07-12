import fs from "node:fs";
import path from "node:path";

import { resolveStateDir, writeFileAtomic } from "./state.mjs";
import { hashLite } from "./util.mjs";

// Audit V4 - the `--endless` mode. It runs BOUNDED review passes over the project
// and keeps going until the returns diminish (K consecutive passes add nothing
// new), a finite total agent-call budget is spent, or a max-pass ceiling is hit -
// whichever comes first. It is deliberately a REVIEW/PROPOSE loop, not an endless
// auto-fix loop: editing code in an unbounded loop is exactly the runaway the
// council warned about, so auto-fix stays the explicit, one-shot `audit fix`.
//
// Progressive coverage: the caller advances the reviewed unit window each pass
// (offset), so pass N reviews the NEXT band of hotspots rather than re-rolling the
// same top-N. Cross-pass dedupe uses a TIGHT in-run key (file+category+full-title
// hash, no volatile line bucket) so distinct findings are not collapsed and the
// same finding at a drifting line does not read as "new".
//
// Every side effect (the per-pass review, the checkpoint write/read) is injectable,
// so the loop's stop conditions, dedupe and resume are testable without agents.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

/** Tight in-run dedupe key: exact file + category + full-title hash (no line). */
export function endlessKey(f) {
  const file = String(f?.file ?? "").toLowerCase().replace(/\\/g, "/").trim();
  const cat = String(f?.category ?? "other").toLowerCase().trim();
  const title = String(f?.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${file}::${cat}::h${hashLite(title)}`;
}

/**
 * Keep only findings whose key hasn't been seen before; record the new ones in
 * `seen`. The tight key avoids both false drops (distinct issues collapsing) and
 * false "fresh" (same issue at a shifted line). Pure (mutates seen).
 */
export function dedupeNew(findings, seen) {
  const fresh = [];
  for (const f of findings ?? []) {
    const key = endlessKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(f);
  }
  return fresh;
}

/** Why the endless loop should stop before another pass, or null to continue. Pure. */
export function endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop }) {
  if (passNo >= maxPasses) return `reached max passes (${maxPasses})`;
  if (spent >= totalBudget) return `budget exhausted (${spent}/${totalBudget} agent calls)`;
  if (dryStreak >= dryStop) return `diminishing returns — ${dryStreak} consecutive passes found nothing new`;
  return null;
}

function checkpointFile(cwd) {
  return path.join(resolveStateDir(cwd), "audit-endless.json");
}

/** Read a prior checkpoint (or null). Used to resume an interrupted run. */
export function loadCheckpoint(cwd) {
  try {
    return JSON.parse(fs.readFileSync(checkpointFile(cwd), "utf8"));
  } catch {
    return null;
  }
}

function defaultCheckpoint(cwd, state) {
  try {
    // Atomic write (tmp + rename) so a crash mid-write cannot leave corrupt JSON
    // that a later --resume would choke on.
    writeFileAtomic(checkpointFile(cwd), `${JSON.stringify(state)}\n`);
  } catch {
    /* checkpoint is best-effort; a write failure must not abort the run */
  }
}

/**
 * Run bounded review passes until a stop condition trips. `deps.review({budget,
 * pass})` returns `{ findings, coverage:{budgetSpent} }` for one pass; `deps.checkpoint`
 * persists progress. With `options.resume`, prior state (findings/spent/passNo/
 * dryStreak) is seeded from the last checkpoint so an interrupted run continues
 * instead of re-spending the whole budget. Returns accumulated unique findings +
 * a per-pass log + the stop reason.
 */
export async function runEndless(cwd, options = {}, deps = {}) {
  const maxPasses = clamp(options.maxPasses ?? 10, 1, 1000);
  const dryStop = clamp(options.dryStreak ?? 2, 1, 100);
  const totalBudget = clamp(options.budget ?? 60, 2, 100000);
  const perPassBudget = clamp(options.perPassBudget ?? Math.max(4, Math.round(totalBudget / Math.min(maxPasses, 4))), 2, totalBudget);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const review = deps.review;
  if (typeof review !== "function") throw new Error("runEndless requires deps.review");
  const checkpoint = deps.checkpoint ?? ((state) => defaultCheckpoint(cwd, state));

  const seen = new Set();
  let all = [];
  const passes = [];
  let spent = 0;
  let dryStreak = 0;
  let passNo = 0;
  let stopReason = null;

  if (options.resume) {
    const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadCheckpoint(cwd);
    if (prior && Array.isArray(prior.findings)) {
      all = prior.findings.slice();
      for (const f of all) seen.add(endlessKey(f));
      spent = Number.isFinite(prior.spent) ? prior.spent : 0;
      passNo = Number.isFinite(prior.passNo) ? prior.passNo : 0;
      dryStreak = Number.isFinite(prior.dryStreak) ? prior.dryStreak : 0;
      onProgress(`resumed: ${all.length} findings, ${spent}/${totalBudget} spent, ${passNo} passes done, dry ${dryStreak}/${dryStop}`);
    }
  }

  for (;;) {
    stopReason = endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop });
    if (stopReason) break;

    passNo += 1;
    const passBudget = Math.min(perPassBudget, totalBudget - spent);
    onProgress(`pass ${passNo}: reviewing (budget ${passBudget}, ${spent}/${totalBudget} spent, dry ${dryStreak}/${dryStop})…`);
    let res;
    try {
      res = await review({ budget: passBudget, pass: passNo });
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err), found: 0, fresh: 0, spent });
      stopReason = `review error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    const passFindings = res?.findings ?? [];
    // Charge the budget by what the pass actually spent; fall back to its allotment
    // when unreported, and hard-clamp so `spent` can never exceed the total budget.
    const passSpent = Number.isFinite(res?.coverage?.budgetSpent) ? res.coverage.budgetSpent : passBudget;
    spent += Math.min(Math.max(1, passSpent), totalBudget - spent);
    const fresh = dedupeNew(passFindings, seen);
    all.push(...fresh);
    // B5 (cell-aware convergence): a zero-fresh pass only advances the dry streak when the
    // review's six-eyes COVERAGE is complete. If cells are still unreviewed (coverage.complete
    // === false), "found nothing new" is not real convergence — there is work left — so the
    // streak resets. Absent coverage info (undefined, the pre-cell-matrix path) counts as complete.
    const coverageComplete = res?.coverage?.complete !== false;
    dryStreak = fresh.length === 0 && coverageComplete ? dryStreak + 1 : 0;
    passes.push({ pass: passNo, found: passFindings.length, fresh: fresh.length, spent });
    onProgress(`  pass ${passNo}: +${fresh.length} new (total ${all.length}); dry ${dryStreak}/${dryStop}`);
    checkpoint({ passNo, findings: all, passes, spent, dryStreak, stopReason: null, done: false });
  }

  checkpoint({ passNo, findings: all, passes, spent, dryStreak, stopReason, done: true });
  return { findings: all, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak };
}
