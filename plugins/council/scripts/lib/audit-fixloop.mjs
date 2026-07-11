// Audit M3 - the `audit fix --loop`: a fix-until-dry AUTONOMOUS loop. Where
// audit-endless is review/propose-only, this one closes the loop: each pass reviews,
// applies Tier-0 verdict gating (pruning + surfacing), fixes the actionable localized
// set on the isolated branch (continued across passes via stayOnBranch), then RE-SCOPES
// the next pass to the files that changed PLUS their blast radius (deps.expandScope).
// It stops on bounded conditions - K dry passes (the REVIEW found nothing new), K
// stalled passes (findings remain but none are auto-applicable), a finite agent budget,
// a max-pass ceiling, or a structured fix blocker (dirty tree / lock / integration red)
// - so an autonomous loop can never run away or falsely report convergence. Every side
// effect (review/gate/fix/expandScope/checkpoint) is injectable and unit-tested.

import fs from "node:fs";
import path from "node:path";

import { dedupeNew, endlessStopReason } from "./audit-endless.mjs";
import { applyTierGating, orderByTier } from "./audit-tiers.mjs";
import { fingerprintFinding } from "./ledger.mjs";
import { resolveStateDir, writeFileAtomic } from "./state.mjs";

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

/** Cross-pass dedupe key for a committed fix. Prefers the AST-anchored fingerprint the
 *  rest of the pipeline already uses (ledger/tier gating); else the ledger's own key
 *  (file+category+line-bucket+title-hash) so distinct same-file bugs don't collapse. */
export function fixKey(fixed) {
  if (fixed?.finding?.fingerprint) return String(fixed.finding.fingerprint);
  const finding = { ...(fixed?.finding ?? {}), file: fixed?.finding?.file ?? fixed?.file };
  return fingerprintFinding(finding);
}

/** Dedupe key for a surfaced proposal (same basis as fixKey). */
function proposedKey(f) {
  if (f?.fingerprint) return String(f.fingerprint);
  return fingerprintFinding({ file: f?.file ?? f?.location?.path, title: f?.title, category: f?.category, line: f?.line ?? f?.location?.startLine });
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
 * fixed once post-consolidation; `surfaced` are serious findings parked behind a
 * remove?/redirect (the report must foreground them). Without a verdict map nothing is
 * pruned — the honest default until Tier 0 is wired in.
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
 * Run the fix-until-dry loop. Deps: `review({budget,pass,changedFiles})` ->
 * `{findings, coverage:{budgetSpent}}`; `fix(actionable, {budget,pass,branch,stayOnBranch})`
 * -> `{ok, error?, branch, fixed:[], failed:[], changedFiles:[], spent, integrationFailed}`
 * (the runAuditFix shape); optional `gate(findings,ctx)`, `verdictsFor(findings,ctx)`
 * (per-pass Tier-0 re-map), `expandScope(changedFiles)` (blast-radius: changed ∪
 * dependents ∪ dup peers), `checkpoint`, `loadCheckpoint`.
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
  const verdictsFor = typeof deps.verdictsFor === "function" ? deps.verdictsFor : () => options.verdictMap ?? {};
  const gate = deps.gate ?? ((findings, ctx) => gateFindings(findings, verdictsFor(findings, ctx) ?? {}));
  const expandScope = typeof deps.expandScope === "function" ? deps.expandScope : (x) => x;
  const checkpoint = deps.checkpoint ?? ((state) => defaultCheckpoint(cwd, state));

  const fixedAll = [];
  const failedAll = [];
  const proposedAll = [];
  const passes = [];
  const seenFixed = new Set();
  const seenProposed = new Set();
  const seenReview = new Set();
  let spent = 0;
  let dryStreak = 0;
  let stalledStreak = 0;
  let passNo = 0;
  let stopReason = null;
  let changedFiles = null; // null = full scope on the first pass
  let branch = null;

  if (options.resume) {
    const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadFixLoopCheckpoint(cwd);
    if (prior && Array.isArray(prior.fixed)) {
      fixedAll.push(...prior.fixed);
      for (const f of prior.fixed) seenFixed.add(fixKey(f));
      if (Array.isArray(prior.failed)) failedAll.push(...prior.failed);
      if (Array.isArray(prior.proposed)) for (const p of prior.proposed) {
        const k = proposedKey(p);
        if (!seenProposed.has(k)) { seenProposed.add(k); proposedAll.push(p); }
      }
      if (Array.isArray(prior.passes)) passes.push(...prior.passes);
      // Clamp untrusted checkpoint numerics into range so a corrupt/negative value can't
      // bypass the budget or pass ceiling.
      spent = clamp(prior.spent ?? 0, 0, totalBudget);
      passNo = clamp(prior.passNo ?? 0, 0, maxPasses);
      dryStreak = clamp(prior.dryStreak ?? 0, 0, dryStop);
      branch = prior.branch ?? null;
      // Restore the scope so a resumed run doesn't jump straight to a stale full-scope
      // window offset (which would review off-the-end and falsely read "dry").
      if (Array.isArray(prior.changedFiles) && prior.changedFiles.length) changedFiles = prior.changedFiles;
      onProgress(`resumed: ${fixedAll.length} fixed, ${spent}/${totalBudget} spent, ${passNo} passes, dry ${dryStreak}/${dryStop}`);
    }
  }

  // Tier-0 proposals (dead modules, over-layered indirection) the caller ran the detector
  // for once — surface them alongside the fixer's rejected set (they never gate below the
  // confidence floor, but a human should see them).
  for (const p of options.logicalProposals ?? []) {
    const f = { file: p?.location?.path ?? p?.file, title: p?.title, severity: p?.severity, category: p?.category, rejectedReason: `Tier-0: ${p?.verdict ?? "review"}` };
    const k = proposedKey(f);
    if (!seenProposed.has(k)) {
      seenProposed.add(k);
      proposedAll.push(f);
    }
  }

  // Charge the budget by what a phase actually spent, falling back to its allotment and
  // flooring so an under-reporting dep can't make the budget cap a silent no-op.
  const charge = (amount, fallback) => {
    const a = Number.isFinite(amount) ? amount : fallback;
    spent += Math.min(Math.max(0, a), totalBudget - spent);
  };

  for (;;) {
    stopReason = endlessStopReason({ passNo, spent, dryStreak }, { maxPasses, totalBudget, dryStop });
    if (!stopReason && stalledStreak >= dryStop) stopReason = `stalled — actionable findings remain but none are auto-applicable (${stalledStreak} passes)`;
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
    charge(rev?.coverage?.budgetSpent, Math.max(1, passBudget)); // a review always costs >= 1
    const freshFindings = dedupeNew(findings, seenReview);

    const gated = gate(findings, { changedFiles, pass: passNo });
    for (const p of gated.surfaced ?? []) {
      const k = proposedKey(p);
      if (!seenProposed.has(k)) {
        seenProposed.add(k);
        proposedAll.push(p);
      }
    }

    let fx;
    try {
      fx = await fix(gated.actionable, { budget: Math.max(1, Math.min(perPassBudget, totalBudget - spent)), pass: passNo, branch, stayOnBranch: true });
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err) });
      stopReason = `fix error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    // A structured (non-throw) blocker from runAuditFix (dirty tree / lock / branch
    // collision / integration red) must surface as the real reason, not "dry".
    if (fx && (fx.ok === false || fx.integrationFailed)) {
      passes.push({ pass: passNo, error: fx.error ?? "integration failed" });
      stopReason = `fix blocked on pass ${passNo}: ${fx.error ?? "integration run went red — branch may be discarded"}`;
      branch = fx.branch ?? branch;
      break;
    }
    branch = fx?.branch ?? branch;
    charge(fx?.spent, gated.actionable.length ? Math.max(1, gated.actionable.length) : 0);

    const freshFixed = (fx?.fixed ?? []).filter((f) => {
      const k = fixKey(f);
      if (seenFixed.has(k)) return false;
      seenFixed.add(k);
      return true;
    });
    fixedAll.push(...freshFixed);
    failedAll.push(...(fx?.failed ?? []));
    // Surface what the fixer deliberately did NOT touch (propose-only / cross-cutting /
    // protected) as proposals — otherwise the whole "found but not auto-fixed" product is
    // invisible in the report (§6 automation-bias counter).
    for (const r of fx?.rejected ?? []) {
      const f = { ...(r.finding ?? {}), rejectedReason: r.reason };
      const k = proposedKey(f);
      if (!seenProposed.has(k)) {
        seenProposed.add(k);
        proposedAll.push(f);
      }
    }

    // Re-scope the NEXT pass to what changed PLUS its blast radius (dependents + dup
    // peers via deps.expandScope); empty -> full re-scope (null). This is what keeps the
    // loop from going "dry" while a regression sits in an unreviewed dependent.
    const changed = Array.isArray(fx?.changedFiles) && fx.changedFiles.length ? fx.changedFiles : freshFixed.map((f) => f.file).filter(Boolean);
    const expanded = changed.length ? expandScope(changed) ?? changed : [];
    changedFiles = expanded.length ? expanded : null;

    // Honest convergence: dry when the REVIEW found nothing new; stalled when new
    // findings exist but none could be auto-applied this pass.
    dryStreak = freshFindings.length === 0 ? dryStreak + 1 : 0;
    stalledStreak = freshFindings.length > 0 && freshFixed.length === 0 ? stalledStreak + 1 : 0;

    passes.push({ pass: passNo, reviewed: findings.length, fresh: freshFindings.length, actionable: gated.actionable.length, fixed: freshFixed.length, failed: (fx?.failed ?? []).length, spent });
    onProgress(`  pass ${passNo}: fixed ${freshFixed.length} (total ${fixedAll.length}); dry ${dryStreak}/${dryStop}, stalled ${stalledStreak}/${dryStop}`);
    checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, dryStreak, stopReason: null, done: false });
  }

  checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, dryStreak, stopReason, done: true });
  return { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak };
}
