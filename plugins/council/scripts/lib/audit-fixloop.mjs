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
import { retryOnRateLimit } from "./audit-retry.mjs";
import { applyTierGating, orderByTier, tierOfLens } from "./audit-tiers.mjs";
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
 * pruned — the default for a bare caller that injects no map (the CLI threads in
 * detectLogical's Tier-0 verdict map, which DOES gate).
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
  // Rate-limit resilience for unattended runs: on a 429/overload from a review/fix
  // phase, back off + retry instead of stopping the whole loop. Opt-in (--retry-on-limit);
  // a non-rate-limit error still propagates immediately. Sleep is injectable for tests.
  const withLimitRetry = options.retryOnLimit
    ? (fn) => retryOnRateLimit(fn, {
        retries: clamp(options.retryLimit ?? 5, 1, 20),
        sleep: deps.sleep,
        onRetry: ({ attempt, ms }) => onProgress(`rate-limited — backing off ${Math.round(ms / 1000)}s (retry ${attempt}/${clamp(options.retryLimit ?? 5, 1, 20)})…`)
      })
    : (fn) => fn();

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
  // Per-tier convergence (§3): run each tier (0 logical -> 1 structure -> 2 correctness -> 3
  // quality) to dry before advancing, so a Structure consolidation lands before Correctness runs
  // on the consolidated code (a bug is then found once, post-consolidation, not N times across
  // copies). The pure default is OFF so the function contract is stable; the audit-fix CLI defaults
  // it ON (B5, --per-tier) at the call site, where real findings carry a lens (see the wiring).
  const perTier = Boolean(options.perTierConvergence);
  // Start at Tier 1 (Structure), NOT 0 (Logical): tier 0 = logical_sense is propose-only and is
  // NEVER review-sourced (no category maps to it; categoryToLens falls back to correctness), so its
  // proposals arrive once via logicalProposals → proposedAll and never enter gate/actionable.
  // Starting at 0 therefore burned dryStop full review+fix passes of warm-up tax every run once
  // per-tier became the CLI default (council B5 codex P1). Logical proposals are still surfaced.
  const FIRST_TIER = 1;
  let currentTier = FIRST_TIER;
  let tierDryStreak = 0;

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
      // Restore the per-tier staging position so a resume (the M10 supervisor path) continues at the
      // tier it was fixing, not from tier 0 — which would re-walk structure every restart (council
      // B5 grok P2/Claude). Clamped so a corrupt checkpoint can't push currentTier out of range.
      currentTier = clamp(prior.currentTier ?? FIRST_TIER, FIRST_TIER, 4);
      tierDryStreak = clamp(prior.tierDryStreak ?? 0, 0, dryStop);
      stalledStreak = clamp(prior.stalledStreak ?? 0, 0, dryStop);
      branch = prior.branch ?? null;
      // Restore the scope so a resumed run doesn't jump straight to a stale full-scope
      // window offset (which would review off-the-end and falsely read "dry").
      if (Array.isArray(prior.changedFiles) && prior.changedFiles.length) changedFiles = prior.changedFiles;
      // Restore the full-scope window cursor into the deps closure so a resumed FULL pass continues
      // from where it left off instead of re-reviewing offset 0 and missing later units (Codex C2 P1).
      if (deps.windowState && Number.isFinite(prior.windowPasses)) deps.windowState.set(prior.windowPasses);
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
    // Under per-tier staging the GLOBAL dry/stalled streaks are TIER-UNAWARE — they see findings
    // from ALL tiers while `fix` is only offered the CURRENT tier's set, so recurring later-tier
    // findings would make global dry/stalled trip and stop the loop BEFORE those tiers are ever
    // fixed (council B5 grok P1). So while per-tier is staging, global dry/stalled must NOT stop the
    // loop — tier advancement drives progress and the "all tiers converged" reason ends it. Global
    // dry/stalled apply only in flat (non-per-tier) mode.
    // Check per-tier CONVERGENCE first (council Codex C2 P2): a run that advances past the last tier
    // on the SAME iteration it also hits maxPasses/budget should report the meaningful "all tiers
    // converged", not the generic ceiling — the tiers genuinely finished.
    stopReason = perTier && currentTier > 3 ? "all tiers converged (structure -> correctness -> quality)" : null;
    if (!stopReason) stopReason = endlessStopReason({ passNo, spent, dryStreak: perTier ? 0 : dryStreak }, { maxPasses, totalBudget, dryStop });
    if (!stopReason && !perTier && stalledStreak >= dryStop) stopReason = `stalled — actionable findings remain but none are auto-applicable (${stalledStreak} passes)`;
    if (stopReason) break;

    passNo += 1;
    const passBudget = Math.min(perPassBudget, totalBudget - spent);
    onProgress(`pass ${passNo}: review+fix (budget ${passBudget}, ${spent}/${totalBudget}, dry ${dryStreak}/${dryStop})…`);

    let rev;
    try {
      rev = await withLimitRetry(() => review({ budget: passBudget, pass: passNo, changedFiles }));
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err) });
      stopReason = `review error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    // A review that DID NOT actually run (no reachable reviewer, or a rate-limit the
    // retries couldn't outlast) returns ran:false with zero findings. That is NOT a clean
    // "nothing to fix" — counting it toward the dry streak would let a throttled run declare
    // false convergence and exit reporting success while nothing was reviewed. Stop honestly.
    if (rev && rev.ran === false) {
      passes.push({ pass: passNo, error: "review did not run (no reachable reviewer or rate-limited)" });
      stopReason = `review did not run on pass ${passNo} (backends unavailable or rate-limited) — stopped without false convergence`;
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

    // Per-tier convergence restricts a pass to the CURRENT tier's actionable set.
    const actionable = perTier ? gated.actionable.filter((f) => (typeof f.tier === "number" ? f.tier : tierOfLens(f.lens)) === currentTier) : gated.actionable;

    let fx;
    try {
      fx = await withLimitRetry(() => fix(actionable, { budget: Math.max(1, Math.min(perPassBudget, totalBudget - spent)), pass: passNo, branch, stayOnBranch: true }));
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

    // Honest, cell-aware convergence (B5): DRY only when the review found nothing new AND its
    // six-eyes coverage is complete (unreviewed cells → still work → reset; absent coverage info
    // counts complete for the pre-cell-matrix path). STALLED only when fresh AUTO-FIXABLE findings
    // remained unapplied — fresh PROPOSE-ONLY findings (architecture/SSOT/etc.) are expected not to
    // auto-apply and must NOT read as a stall (that would falsely stop with real fixes still open).
    // Prefer the grouped path's passComplete (scheduled cells reviewed — transient-completable) over
    // the strict `complete` (which capped/unsupplied force false PERSISTENTLY → the loop could never
    // converge; council R9 Codex/Claude P1). Per-file path sets neither → undefined → treated complete.
    const coverageComplete = (rev?.coverage?.passComplete ?? rev?.coverage?.complete) !== false;
    // AUTO-FIXABLE = a localized finding the fixer can actually apply. A propose-only / cross-cutting
    // finding (architecture/SSOT/logical) is offered to fix() only to be surfaced as a proposal — it
    // NEVER auto-applies, so counting it as live work would (a) falsely read as a stall and (b) pin a
    // per-tier stage forever: it recurs every pass, keeps `actionable` non-empty, and the tier never
    // advances while a Tier-2 correctness bug behind it is never reached (council Codex C2 P1).
    const autoFixable = (f) => f?.scope !== "cross-cutting" && f?.fixDisposition !== "propose-only";
    const freshActionable = gate(freshFindings, { changedFiles, pass: passNo }).actionable.filter(autoFixable).length;
    dryStreak = freshFindings.length === 0 && coverageComplete ? dryStreak + 1 : 0;
    stalledStreak = freshActionable > 0 && freshFixed.length === 0 ? stalledStreak + 1 : 0;
    // Advance to the next tier once the current one has nothing new AUTO-FIXABLE for K passes AND the
    // review's six-eyes coverage is complete (an incomplete grouped matrix still has cells to review —
    // advancing then would declare "all tiers converged" over unreviewed work; council Codex C2 P1).
    if (perTier) {
      const tierFresh = freshFindings.filter((f) => tierOfLens(f.lens) === currentTier && autoFixable(f)).length;
      const tierAuto = actionable.filter(autoFixable).length;
      if (tierAuto > 0 || tierFresh > 0) tierDryStreak = 0;
      else if (coverageComplete && (tierDryStreak += 1) >= dryStop) {
        currentTier += 1;
        tierDryStreak = 0;
        stalledStreak = 0; // a tier advance IS progress — never carry a stall from a done tier into the next (council B5 grok P1-b)
      }
    }

    passes.push({ pass: passNo, reviewed: findings.length, fresh: freshFindings.length, actionable: gated.actionable.length, fixed: freshFixed.length, failed: (fx?.failed ?? []).length, spent });
    onProgress(`  pass ${passNo}: fixed ${freshFixed.length} (total ${fixedAll.length}); dry ${dryStreak}/${dryStop}, stalled ${stalledStreak}/${dryStop}`);
    checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, windowPasses: deps.windowState?.get?.() ?? 0, stopReason: null, done: false });
  }

  checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, windowPasses: deps.windowState?.get?.() ?? 0, stopReason, done: true });
  return { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak };
}
