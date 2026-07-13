import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir, writeFileAtomic } from "./state.mjs";
import { hashLite } from "./util.mjs";
import { NOOP_REPORTER } from "./progress.mjs";
import { readUsageSnapshot } from "./usage-guard.mjs";
import { MAX_AUTONOMOUS_WAIT_MS, evaluateBetweenPassGuards } from "./audit-loop-guards.mjs";

// Audit V4 - the `--endless` mode. It runs BOUNDED review passes over the project
// and keeps going until the returns diminish (K consecutive passes add nothing
// new), a finite total agent-call budget is spent, or a max-pass ceiling is hit -
// whichever comes first. It is deliberately a REVIEW/PROPOSE loop that never edits
// code: looped AUTO-fix lives in the separately-gated `audit fix --loop` (M3, on an
// isolated integration branch with per-fix + integration test gates), not here.
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
  const reporter = options.reporter ?? NOOP_REPORTER;
  const review = deps.review;
  if (typeof review !== "function") throw new Error("runEndless requires deps.review");
  const checkpoint = deps.checkpoint ?? ((state) => defaultCheckpoint(cwd, state));
  // --usage-ceiling / --pause-at-5h: the SAME two quota guards the fix-loop honours, via the shared
  // pure decision helper (SSOT). endless is REVIEW-ONLY (writes no code), so a pause is a plain
  // checkpoint-resume — no branch to clobber. Absent both → no guard, byte-identical to before.
  // FAIL-SOFT is load-bearing: unknown/unavailable/stale usage NEVER stops or pauses a long run.
  // readUsage is injectable (default binds the real snapshot reader to home + the run-start sinceMs);
  // now/sleep are injectable so an autonomous-pause wait needs no real clock in tests.
  const usageCeiling = options.usageCeiling ?? null;
  const pause5h = options.pause5h && typeof options.pause5h === "object" && options.pause5h.enabled ? options.pause5h : null;
  const readUsage = typeof deps.readUsage === "function"
    ? deps.readUsage
    : () => readUsageSnapshot({ homeDir: os.homedir(), sinceMs: options.usageSince });
  const nowFn = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleepFn = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  const seen = new Set();
  let all = [];
  const passes = [];
  let spent = 0;
  let dryStreak = 0;
  let passNo = 0;
  let stopReason = null;
  // --pause-at-5h machine-readable result (the companion emits the resume contract + exit 75 from it)
  // and the anti-thrash guard: `pauseGuard` remembers the last pause's window signature + the findings
  // count then, so a resume that IMMEDIATELY re-pauses on the SAME 5h window with NO new findings is
  // caught across the exit/resume boundary (persisted in the checkpoint). Mirrors the fix-loop, but the
  // progress metric is accumulated findings (endless writes no code) instead of committed fixes.
  let pauseInfo = null;
  let pauseGuard = null;

  if (options.resume) {
    const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadCheckpoint(cwd);
    if (prior && Array.isArray(prior.findings)) {
      all = prior.findings.slice();
      for (const f of all) seen.add(endlessKey(f));
      spent = Number.isFinite(prior.spent) ? prior.spent : 0;
      passNo = Number.isFinite(prior.passNo) ? prior.passNo : 0;
      dryStreak = Number.isFinite(prior.dryStreak) ? prior.dryStreak : 0;
      // Restore the pause anti-thrash guard so a resume that immediately re-pauses on the SAME 5h
      // window with no progress is caught across the exit/resume boundary (not just within one process).
      if (prior.pauseGuard && typeof prior.pauseGuard === "object") pauseGuard = prior.pauseGuard;
      onProgress(`resumed: ${all.length} findings, ${spent}/${totalBudget} spent, ${passNo} passes done, dry ${dryStreak}/${dryStop}`);
    }
  }

  for (;;) {
    stopReason = endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop });
    if (stopReason) break;

    passNo += 1;
    reporter.phase("review", `pass ${passNo}`);
    reporter.progress({ passesDone: passNo, passesTotal: maxPasses });
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
    reporter.budget(spent, totalBudget);
    reporter.findings(fresh); // fold this pass's NEW findings into the live per-lens matrix
    // B5 (cell-aware convergence): a zero-fresh pass only advances the dry streak when the review's
    // scheduled cells were all reviewed. Prefer the grouped path's passComplete (transient-completable)
    // over the strict `complete` — capped/unsupplied force `complete` false PERSISTENTLY, which would
    // stop the streak from ever advancing (council R9). Absent info (per-file path) counts as complete.
    // M8 parity with the fix loop (council Grok P2): the completeness critic (--completeness-critic) also
    // gates the endless dry streak — a pass it judges under-examined (completenessComplete === false) must
    // not converge. undefined (critic off / infra-degraded) stays non-blocking → default path unchanged.
    const coverageComplete =
      (res?.coverage?.passComplete ?? res?.coverage?.complete) !== false && res?.coverage?.completenessComplete !== false;
    dryStreak = fresh.length === 0 && coverageComplete ? dryStreak + 1 : 0;
    passes.push({ pass: passNo, found: passFindings.length, fresh: fresh.length, spent });
    onProgress(`  pass ${passNo}: +${fresh.length} new (total ${all.length}); dry ${dryStreak}/${dryStop}`);
    checkpoint({ passNo, findings: all, passes, spent, dryStreak, pauseGuard, stopReason: null, done: false });

    // C (codex-4): if THIS pass already tripped a terminal stop (max passes / budget / diminishing
    // returns), break now WITHOUT running the between-pass ceiling/pause guards — the run is ending
    // regardless, so an exit-75 pause or a multi-hour autonomous sleep on an already-terminal final pass
    // is pointless. The guards below matter only when ANOTHER pass would actually execute. (Same
    // stopReason the next loop head would compute — behaviour is identical minus the wasted guard.)
    const terminalNow = endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop });
    if (terminalNow) {
      stopReason = terminalNow;
      break;
    }

    // Between passes: honor --usage-ceiling on a CONFIRMED provider-quota breach (weekly HARD stop),
    // via the shared pure decision (SSOT with the fix-loop). FAIL-SOFT — a usage-read failure is treated
    // as "not breached" (the loop continues); only an available model at/over its ceiling stops it, never
    // unknown/unavailable usage. Stash the snapshot into progress.json (reporter.usage) so the live
    // dashboard shows real quota without its own I/O.
    if (usageCeiling) {
      try {
        const snap = await readUsage();
        reporter.usage?.(snap, usageCeiling);
        const { ceiling } = evaluateBetweenPassGuards({ usageCeiling, snapshot: snap });
        if (ceiling?.breached) {
          stopReason = `usage-ceiling: ${ceiling.breaches.map((b) => `${b.model} ${b.percent}%≥${b.ceiling}% (${b.window})`).join(", ")}`;
          onProgress(stopReason);
          reporter.line(`⛔ ${stopReason}`);
          break;
        }
      } catch {
        /* fail-soft: a usage-read failure never stops (or crashes) the loop */
      }
    }

    // Between passes: the SOFT --pause-at-5h policy (separate from the weekly ceiling above). On a
    // CONFIRMED 5h breach the loop PAUSES rather than stops terminally — the 5h window resets in hours.
    // endless writes no code, so the resume is a plain checkpoint-resume: non-autonomous → checkpoint a
    // pauseGuard + break, returning `out.pause` for the companion to emit as the contract + exit 75;
    // autonomous+schedulable → wait in-process to the reset then continue. FAIL-SOFT: a read failure
    // never pauses. Progress here = MORE accumulated findings than the last pause carried.
    if (pause5h) {
      try {
        const snap = await readUsage();
        reporter.usage?.(snap); // bare: refresh the live 5h numbers without clobbering any active ceiling
        const nowMs = nowFn();
        const { pause } = evaluateBetweenPassGuards({
          pause5h,
          snapshot: snap,
          nowMs,
          prevWindowSig: pauseGuard?.windowSig ?? null,
          madeProgress: all.length > (pauseGuard?.findingsCount ?? 0),
          pauseIdSeed: `${options.runId ?? ""}|${cwd}|${passNo}`
        });
        if (pause) {
          const blockersDesc = pause.blockers.map((b) => `${b.model} 5h ${b.percent}%≥${b.threshold}%`).join(", ");
          // ANTI-THRASH: a resume that immediately re-pauses on the SAME 5h window with NO new findings
          // since that pause is a spin (a wrong reset time, or the window never actually cleared).
          // Hard-stop for manual attention instead of waiting/exiting into the same loop.
          if (pause.thrash) {
            stopReason = `quota-pause-manual: ${blockersDesc} — resumed but the same 5h window is still over threshold with no progress; stopping for manual attention`;
            pauseInfo = { schedulable: false, resumeAt: null, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), thrash: true, pauseId: pause.pauseId };
            reporter.line(`⏸ ${stopReason}`);
            onProgress(stopReason);
            checkpoint({ passNo, findings: all, passes, spent, dryStreak, pauseGuard, stopReason, done: false });
            break;
          }
          // Remember this pause so the NEXT iteration / resume can detect a no-progress re-pause.
          pauseGuard = { windowSig: pause.windowSig, findingsCount: all.length, passNo };

          // AUTONOMOUS + schedulable: wait IN-PROCESS to the KNOWN future reset, then continue the loop
          // (the next pass re-reads usage). Checkpoint FIRST so a mid-wait process death stays
          // --resume-able. Only a valid, bounded future wait — never an indefinite/absurd sleep.
          if (pause5h.autonomous && pause.schedulable) {
            const resumeMs = Date.parse(pause.resumeAt);
            const waitMs = Number.isFinite(resumeMs) ? Math.max(0, resumeMs - nowMs) : NaN;
            if (Number.isFinite(waitMs) && waitMs <= MAX_AUTONOMOUS_WAIT_MS) {
              checkpoint({ passNo, findings: all, passes, spent, dryStreak, pauseGuard, stopReason: null, done: false });
              reporter.line(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
              onProgress(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
              await sleepFn(waitMs);
              continue; // resume the loop in-process; do NOT exit
            }
            // Not a valid bounded wait → fall through to the manual/exit path (never a blind sleep).
          }

          // NON-autonomous (or autonomous-but-unschedulable): clean stop between passes carrying a
          // resume contract. The companion emits the contract + exit 75 from out.pause; endless writes
          // no code, so a --resume is a plain checkpoint resume.
          stopReason = pause.schedulable
            ? `quota-pause: ${blockersDesc} — resume ${pause.resumeAt}`
            : `quota-pause-manual: ${blockersDesc} — reset time not schedulable, resume manually`;
          pauseInfo = { schedulable: pause.schedulable, resumeAt: pause.resumeAt, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), pauseId: pause.pauseId };
          reporter.line(`⏸ ${stopReason}`);
          onProgress(stopReason);
          checkpoint({ passNo, findings: all, passes, spent, dryStreak, pauseGuard, stopReason, done: false });
          break;
        }
        // Not paused → progressed past any prior pause on this window; clear the guard so a LATER,
        // legitimate pause on the same window (after real work) isn't misread as a thrash.
        pauseGuard = null;
      } catch {
        /* fail-soft: a usage-read failure never pauses (or crashes) the loop */
      }
    }
  }

  checkpoint({ passNo, findings: all, passes, spent, dryStreak, pauseGuard, stopReason, done: true });
  const result = { findings: all, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak };
  // `pause` is present ONLY when a NON-autonomous (or autonomous-but-unschedulable) pause actually
  // STOPPED the run — the companion turns it into the resume contract + exit 75. An autonomous wait
  // that resumed in-process and later converged leaves pauseInfo null (a normal terminal result).
  if (pauseInfo) result.pause = pauseInfo;
  return result;
}
