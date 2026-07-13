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
import os from "node:os";
import path from "node:path";

import { dedupeNew, endlessKey, endlessStopReason } from "./audit-endless.mjs";
import { NOOP_REPORTER } from "./progress.mjs";
import { readUsageSnapshot } from "./usage-guard.mjs";
import { MAX_AUTONOMOUS_WAIT_MS, evaluateBetweenPassGuards } from "./audit-loop-guards.mjs";
import { retryOnRateLimit } from "./audit-retry.mjs";
import { applyTierGating, orderByTier, tierOfLens } from "./audit-tiers.mjs";
import { fingerprintFinding } from "./ledger.mjs";
import { resolveStateDir, writeFileAtomic } from "./state.mjs";

// NOTE: an in-process multi-hour autonomous pause wait is FRAGILE — the machine/terminal must stay up —
// but the checkpoint written FIRST makes a mid-wait death --resume-able. The MAX_AUTONOMOUS_WAIT_MS
// bound + the between-pass guard DECISION now live in audit-loop-guards.mjs (SSOT with audit-endless).

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

/**
 * Resume-safety guard (LOAD-BEARING — a resume must NEVER overwrite the user's work). PURE: given
 * whether the tree is `dirty` and whether the checkpoint's recorded integration `branch` still exists
 * (`branchExists`), decide if `audit fix --loop --resume` may proceed. Returns `{ ok, reason }`.
 * FAIL CLOSED: a dirty tree (the user edited during the pause) or a vanished/renamed integration
 * branch (the checkpoint fingerprint no longer matches) → `{ ok:false, reason }` so the caller aborts
 * WITHOUT stashing/resetting/cleaning anything. This function itself touches nothing — it only judges.
 */
export function evaluateResumeGuard({ checkpoint, dirty, branchExists } = {}) {
  if (dirty) {
    return { ok: false, reason: "working tree is dirty — resume aborted so your uncommitted changes are never overwritten (commit or stash them, then resume)" };
  }
  if (checkpoint && checkpoint.branch && branchExists === false) {
    return { ok: false, reason: `checkpoint integration branch "${checkpoint.branch}" no longer exists — cannot resume without risking overwrite; re-run without --resume to start a fresh loop` };
  }
  return { ok: true, reason: null };
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
  const reporter = options.reporter ?? NOOP_REPORTER; // best-effort live telemetry (additive)
  // --usage-ceiling: STOP the loop between passes on a CONFIRMED per-model provider-quota breach
  // (real Claude 5h/7d, Codex weekly, Grok weekly %). null = no ceiling. readUsage is injectable
  // (default binds the real snapshot reader to this machine's home + the run-start sinceMs); tests
  // trip it on a chosen pass. FAIL-SOFT is load-bearing: a usage read must NEVER crash the loop or
  // stop it on unknown usage — only an available model at/over its ceiling stops it.
  const usageCeiling = options.usageCeiling ?? null;
  const readUsage = typeof deps.readUsage === "function"
    ? deps.readUsage
    : () => readUsageSnapshot({ homeDir: os.homedir(), sinceMs: options.usageSince });
  // --pause-at-5h: a SEPARATE, SOFTER policy than --usage-ceiling (which is a weekly HARD stop). The 5h
  // window resets in hours, so a breach PAUSES between passes with a resume contract instead of stopping
  // terminally. `options.pause5h = { enabled, threshold, autonomous }` (the companion applies the
  // default-on 85%). Non-autonomous: checkpoint + break clean (exit 75 + a durable-resume contract the
  // orchestrator schedules). Autonomous: wait IN-PROCESS to the known reset, then continue. FAIL-SOFT:
  // a usage-read failure never pauses. `now`/`sleep` are injectable for tests (sleep is shared with the
  // retry backoff — both default to real setTimeout).
  const pause5h = options.pause5h && typeof options.pause5h === "object" && options.pause5h.enabled ? options.pause5h : null;
  const nowFn = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleepFn = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
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
  const reviewedAll = []; // persisted so a resume can rebuild seenReview (mirrors audit-endless)
  let spent = 0;
  let dryStreak = 0;
  let stalledStreak = 0;
  let passNo = 0;
  let stopReason = null;
  let changedFiles = null; // null = full scope on the first pass
  let branch = null;
  // --pause-at-5h machine-readable result (companion emits the resume contract + exit 75 from it) and
  // the anti-thrash guard. `pauseGuard` remembers the last pause's window signature + durable-fix count
  // so a resume that IMMEDIATELY re-pauses on the SAME 5h window with NO progress is caught (persisted
  // in the checkpoint so it survives the non-autonomous exit/resume boundary).
  let pauseInfo = null;
  let pauseGuard = null;
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
      // Rebuild the review dedupe set from the persisted raw findings (mirrors audit-endless's
      // `for (const f of all) seen.add(endlessKey(f))`) — without this a recurring propose-only
      // finding re-counts as "fresh" on every resume, resetting the dry streak (council loop-report).
      if (Array.isArray(prior.reviewed)) {
        reviewedAll.push(...prior.reviewed);
        for (const f of prior.reviewed) seenReview.add(endlessKey(f));
      }
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
      // Restore the pause anti-thrash guard so a resume that immediately re-pauses on the SAME 5h
      // window with no progress is caught across the exit/resume boundary (not just within one process).
      if (prior.pauseGuard && typeof prior.pauseGuard === "object") pauseGuard = prior.pauseGuard;
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

  // The loop's terminal-stop decision, in ONE place (SSOT): per-tier convergence, the bounded stops
  // (max passes / budget / dry — dry only in flat mode), and the flat-mode stall. Evaluated BOTH at the
  // next loop head AND right after a pass completes (C / codex-4), so the between-pass ceiling/pause
  // guards are skipped on an already-terminal final pass. Reads the live counters via closure.
  const computeTerminalStop = () => {
    if (perTier && currentTier > 3) return "all tiers converged (structure -> correctness -> quality)";
    const bounded = endlessStopReason({ passNo, spent, dryStreak: perTier ? 0 : dryStreak }, { maxPasses, totalBudget, dryStop });
    if (bounded) return bounded;
    if (!perTier && stalledStreak >= dryStop) return `stalled — actionable findings remain but none are auto-applicable (${stalledStreak} passes)`;
    return null;
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
    // converged", not the generic ceiling — the tiers genuinely finished. (SSOT via computeTerminalStop.)
    stopReason = computeTerminalStop();
    if (stopReason) break;

    passNo += 1;
    reporter.phase("fix", `pass ${passNo}`);
    reporter.progress({ passesDone: passNo, passesTotal: maxPasses });
    reporter.budget(spent, totalBudget);
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
    reviewedAll.push(...freshFindings);

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
    // M8: when the completeness critic ran (--completeness-critic), a pass it judges under-examined
    // (completenessComplete === false: a structural gap OR a critic-found gap) does NOT count toward the
    // dry streak — the run keeps hunting. undefined (critic off or infra-degraded) is non-blocking, so
    // the default path is byte-identical to before.
    const coverageComplete =
      (rev?.coverage?.passComplete ?? rev?.coverage?.complete) !== false && rev?.coverage?.completenessComplete !== false;
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
    // Re-emit the budget AFTER this pass's review+fix charges — the pass-start emit (above) is pre-charge,
    // so without this the dashboard/progress.json would under-report spend by a whole pass. Best-effort.
    reporter.budget(spent, totalBudget);
    onProgress(`  pass ${passNo}: fixed ${freshFixed.length} (total ${fixedAll.length}); dry ${dryStreak}/${dryStop}, stalled ${stalledStreak}/${dryStop}`);
    const cpState = { passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, stopReason: null, done: false };
    checkpoint(cpState);

    // C (codex-4): if THIS pass already tripped a terminal stop, break now WITHOUT running the
    // between-pass ceiling/pause guards — the run is ending regardless, so an exit-75 pause or a
    // multi-hour autonomous sleep on an already-terminal final pass is pointless. The guards below run
    // only when ANOTHER pass would actually execute. (Same reason the next loop head would compute.)
    const terminalNow = computeTerminalStop();
    if (terminalNow) {
      stopReason = terminalNow;
      break;
    }

    // Between passes: honor --usage-ceiling on a CONFIRMED provider-quota breach. FAIL-SOFT —
    // a usage-read failure is treated as "not breached" (the loop continues); only an available
    // model at/over its ceiling stops the loop, never unknown/unavailable usage. Stash the snapshot
    // into progress.json (reporter.usage) so the live dashboard shows real quota without its own I/O.
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
    // FAIL-SOFT: a usage-read failure never pauses. Only an AVAILABLE model with a finite 5h% ≥ the
    // threshold pauses; unknown/unavailable/null-5h never does (evaluatePause5h enforces this).
    if (pause5h) {
      try {
        const snap = await readUsage();
        reporter.usage?.(snap); // bare: refresh the live 5h numbers without clobbering any active ceiling
        const nowMs = nowFn();
        // Shared DECISION (SSOT with audit-endless): schedulability + the anti-thrash window signature +
        // the pauseId. Durable progress here = MORE committed fixes than the last pause carried.
        const { pause } = evaluateBetweenPassGuards({
          pause5h,
          snapshot: snap,
          nowMs,
          prevWindowSig: pauseGuard?.windowSig ?? null,
          madeProgress: fixedAll.length > (pauseGuard?.fixedCount ?? 0),
          pauseIdSeed: `${options.runId ?? ""}|${branch ?? ""}|${passNo}`
        });
        if (pause) {
          const blockersDesc = pause.blockers.map((b) => `${b.model} 5h ${b.percent}%≥${b.threshold}%`).join(", ");
          // ANTI-THRASH: a resume that immediately re-pauses on the SAME 5h window with NO durable-fix
          // progress since that pause is a spin (a wrong reset time, or the window never actually
          // cleared). Hard-stop for manual attention instead of waiting/exiting into the same loop.
          if (pause.thrash) {
            stopReason = `quota-pause-manual: ${blockersDesc} — resumed but the same 5h window is still over threshold with no progress; stopping for manual attention`;
            pauseInfo = { schedulable: false, resumeAt: null, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), thrash: true, pauseId: pause.pauseId };
            reporter.line(`⏸ ${stopReason}`);
            onProgress(stopReason);
            checkpoint({ ...cpState, pauseGuard, stopReason, done: false });
            break;
          }
          // Remember this pause so the NEXT iteration / resume can detect a no-progress re-pause.
          pauseGuard = { windowSig: pause.windowSig, fixedCount: fixedAll.length, passNo };

          // AUTONOMOUS + schedulable: wait IN-PROCESS to the KNOWN future reset, then continue the loop
          // (the next pass re-reads usage). Checkpoint FIRST so a mid-wait process death stays
          // --resume-able. Only a valid, bounded future wait — never an indefinite/absurd sleep.
          if (pause5h.autonomous && pause.schedulable) {
            const resumeMs = Date.parse(pause.resumeAt);
            const waitMs = Number.isFinite(resumeMs) ? Math.max(0, resumeMs - nowMs) : NaN;
            if (Number.isFinite(waitMs) && waitMs <= MAX_AUTONOMOUS_WAIT_MS) {
              pauseGuard.autonomous = true;
              checkpoint({ ...cpState, pauseGuard, stopReason: null, done: false });
              reporter.line(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
              onProgress(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
              await sleepFn(waitMs);
              continue; // resume the loop in-process; do NOT exit
            }
            // Not a valid bounded wait → fall through to the manual/exit path (never a blind sleep).
          }

          // NON-autonomous (or autonomous-but-unschedulable): clean stop between passes carrying a
          // resume contract. The companion emits the contract + exit 75 from pauseInfo; the loop is
          // already back-on-base + --resume-able.
          stopReason = pause.schedulable
            ? `quota-pause: ${blockersDesc} — resume ${pause.resumeAt}`
            : `quota-pause-manual: ${blockersDesc} — reset time not schedulable, resume manually`;
          pauseInfo = { schedulable: pause.schedulable, resumeAt: pause.resumeAt, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), pauseId: pause.pauseId };
          reporter.line(`⏸ ${stopReason}`);
          onProgress(stopReason);
          checkpoint({ ...cpState, pauseGuard, stopReason, done: false });
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

  checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, stopReason, done: true });
  const result = { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak, changedFiles: [...new Set(fixedAll.map((f) => f.file))] };
  // `pause` is present ONLY when a NON-autonomous (or autonomous-but-unschedulable) pause actually
  // STOPPED the run — the companion turns it into the resume contract + exit 75. An autonomous wait
  // that resumed in-process and later converged leaves pauseInfo null (a normal terminal result).
  if (pauseInfo) result.pause = pauseInfo;
  return result;
}
