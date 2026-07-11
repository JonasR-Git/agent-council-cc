// Audit M3 - the `audit fix --loop`: a fix-until-dry AUTONOMOUS loop. Where
// audit-endless is deliberately review/propose-only, this one closes the loop: each
// pass reviews, applies Tier-0 verdict gating (pruning + surfacing), fixes the
// actionable localized set on the isolated branch, then RE-SCOPES the next pass to the
// files that actually changed (diff-scoped re-review). It stops on the same bounded
// conditions as endless - K dry passes (a pass that commits no NEW fix), a finite agent
// budget, or a max-pass ceiling - so an autonomous loop can never run away. Every side
// effect (review, gate, fix, checkpoint) is injectable, so the control flow, dedupe,
// re-scoping and resume are testable without agents or a repo. The real deps compose
// runAuditReview + detectLogical/applyTierGating + runAuditFix (wired at the CLI).

import fs from "node:fs";
import path from "node:path";

import { endlessStopReason } from "./audit-endless.mjs";
import { applyTierGating, orderByTier } from "./audit-tiers.mjs";
import { resolveStateDir, writeFileAtomic } from "./state.mjs";

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

/** Cross-pass dedupe key for a committed fix: file + finding title (line-independent). */
export function fixKey(fixed) {
  const file = String(fixed?.file ?? fixed?.finding?.file ?? "").toLowerCase().replace(/\\/g, "/").trim();
  const title = String(fixed?.finding?.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${file}::${title}`;
}

function checkpointFile(cwd) {
  return path.join(resolveStateDir(cwd), "audit-fixloop.json");
}

/** Read a prior fix-loop checkpoint (or null) so an interrupted run can resume. */
export function loadFixLoopCheckpoint(cwd) {
  try {
    return JSON.parse(fs.readFileSync(checkpointFile(cwd), "utf8"));
  } catch {
    return null;
  }
}

function defaultCheckpoint(cwd, state) {
  try {
    writeFileAtomic(checkpointFile(cwd), `${JSON.stringify(state)}\n`);
  } catch {
    /* checkpoint is best-effort; a write failure must not abort the run */
  }
}

/**
 * Default gate: Tier-0 verdict gating over the pass findings. `actionable` is the
 * process+redirect set, tier-ordered (Structure -> Correctness -> Quality) so a bug is
 * fixed once post-consolidation; `surfaced` are the serious findings parked behind a
 * remove?/redirect (the report must foreground them). Without a verdict map nothing is
 * pruned (everything is actionable) — the honest default until Tier 0 is wired in.
 */
export function gateFindings(findings, verdictMap = {}) {
  const g = applyTierGating(findings, verdictMap);
  return {
    actionable: orderByTier([...g.process, ...g.redirected]),
    surfaced: g.surfaced,
    skipped: g.skipped,
    suppressed: g.suppressed
  };
}

/**
 * Run the fix-until-dry loop. `deps.review({budget, pass, changedFiles})` returns
 * `{ findings, coverage:{budgetSpent} }`; `deps.fix(actionable, {budget, pass, branch})`
 * returns `{ fixed:[], failed:[], branch, changedFiles:[], spent }`. `deps.gate` may
 * override the Tier-0 gating (default: gateFindings with options.verdictMap).
 * Accumulates fixed/failed/proposed across passes, dedupes committed fixes, re-scopes
 * each pass to the previous pass's changed files, checkpoints progress, and (with
 * options.resume) continues a prior run instead of re-spending the budget.
 */
export async function runFixLoop(cwd, options = {}, deps = {}) {
  const maxPasses = clamp(options.maxPasses ?? 8, 1, 1000);
  const dryStop = clamp(options.dryStreak ?? 2, 1, 100);
  const totalBudget = clamp(options.budget ?? 60, 2, 100000);
  const perPassBudget = clamp(options.perPassBudget ?? Math.max(4, Math.round(totalBudget / Math.min(maxPasses, 4))), 2, totalBudget);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const review = deps.review;
  const fix = deps.fix;
  if (typeof review !== "function") throw new Error("runFixLoop requires deps.review");
  if (typeof fix !== "function") throw new Error("runFixLoop requires deps.fix");
  const gate = deps.gate ?? ((findings) => gateFindings(findings, options.verdictMap ?? {}));
  const checkpoint = deps.checkpoint ?? ((state) => defaultCheckpoint(cwd, state));

  const fixedAll = [];
  const failedAll = [];
  const proposedAll = [];
  const passes = [];
  const seenFixed = new Set();
  let spent = 0;
  let dryStreak = 0;
  let passNo = 0;
  let stopReason = null;
  let changedFiles = null; // null = full scope on the first pass
  let branch = null;

  if (options.resume) {
    const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadFixLoopCheckpoint(cwd);
    if (prior && Array.isArray(prior.fixed)) {
      fixedAll.push(...prior.fixed);
      for (const f of prior.fixed) seenFixed.add(fixKey(f));
      if (Array.isArray(prior.proposed)) proposedAll.push(...prior.proposed);
      spent = Number.isFinite(prior.spent) ? prior.spent : 0;
      passNo = Number.isFinite(prior.passNo) ? prior.passNo : 0;
      dryStreak = Number.isFinite(prior.dryStreak) ? prior.dryStreak : 0;
      branch = prior.branch ?? null;
      onProgress(`resumed: ${fixedAll.length} fixed, ${spent}/${totalBudget} spent, ${passNo} passes, dry ${dryStreak}/${dryStop}`);
    }
  }

  const charge = (amount) => {
    spent += Math.min(Math.max(0, Number.isFinite(amount) ? amount : 0), totalBudget - spent);
  };

  for (;;) {
    stopReason = endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop });
    if (stopReason) break;

    passNo += 1;
    const passBudget = Math.min(perPassBudget, totalBudget - spent);
    onProgress(`pass ${passNo}: review+fix (budget ${passBudget}, ${spent}/${totalBudget}, dry ${dryStreak}/${dryStop})…`);

    let rev;
    try {
      rev = await review({ budget: passBudget, pass: passNo, changedFiles });
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err) });
      stopReason = `review error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    const findings = rev?.findings ?? [];
    charge(rev?.coverage?.budgetSpent);

    const gated = gate(findings);
    proposedAll.push(...(gated.surfaced ?? []));

    let fx;
    try {
      fx = await fix(gated.actionable, { budget: Math.max(1, passBudget), pass: passNo, branch });
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err) });
      stopReason = `fix error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    branch = fx?.branch ?? branch;
    charge(fx?.spent);

    const freshFixed = (fx?.fixed ?? []).filter((f) => {
      const k = fixKey(f);
      if (seenFixed.has(k)) return false;
      seenFixed.add(k);
      return true;
    });
    fixedAll.push(...freshFixed);
    failedAll.push(...(fx?.failed ?? []));
    // Re-scope the NEXT pass to what actually changed (diff-scoped re-review); loop cost
    // decays as the change set shrinks. Empty -> next pass is a full re-scope (null).
    const changed = Array.isArray(fx?.changedFiles) && fx.changedFiles.length ? fx.changedFiles : freshFixed.map((f) => f.file).filter(Boolean);
    changedFiles = changed.length ? changed : null;
    dryStreak = freshFixed.length === 0 ? dryStreak + 1 : 0;

    passes.push({ pass: passNo, reviewed: findings.length, actionable: gated.actionable.length, fixed: freshFixed.length, failed: (fx?.failed ?? []).length, spent });
    onProgress(`  pass ${passNo}: fixed ${freshFixed.length} (total ${fixedAll.length}); dry ${dryStreak}/${dryStop}`);
    checkpoint({ passNo, branch, fixed: fixedAll, proposed: proposedAll, passes, spent, dryStreak, stopReason: null, done: false });
  }

  checkpoint({ passNo, branch, fixed: fixedAll, proposed: proposedAll, passes, spent, dryStreak, stopReason, done: true });
  return { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak };
}
