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
import { nowIso, resolveStateDir, writeFileAtomic } from "./state.mjs";
import { findingsStorePath, makeFindingsAppender, readFindingsStore, requireDurableStore, resetFindingsStore } from "./audit-findings-store.mjs";
import { makeMidPassGuard, makeReviewCursor, reviewCursorPath } from "./audit-midpass-guard.mjs";
import { normalizeFindings } from "./audit-normalize.mjs";
import { correlateFindings } from "./audit-correlate.mjs";

// NOTE: an in-process multi-hour autonomous pause wait is FRAGILE — the machine/terminal must stay up —
// but the checkpoint written FIRST makes a mid-wait death --resume-able. The MAX_AUTONOMOUS_WAIT_MS
// bound + the between-pass guard DECISION now live in audit-loop-guards.mjs (SSOT with audit-endless).

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

/** SSOT for the --usage-ceiling terminal stop message — shared by the between-pass backstop AND the
 *  mid-pass quiesce so the two paths report the ceiling breach identically. PURE. */
function ceilingStopReason(breaches) {
  return `usage-ceiling: ${(breaches ?? []).map((b) => `${b.model} ${b.percent}%≥${b.ceiling}% (${b.window ?? "weekly"})`).join(", ")}`;
}

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

  // C — the DURABLE findings SSOT + the reviewed-cell CURSOR (B). Both are OPT-IN so the pure unit
  // tests (injected review/fix, no fs) stay byte-identical:
  //   - options.durableFindings: append each discovered finding to audit-findings.jsonl (the gate/
  //     dashboard SSOT). deps.findingsAppender overrides (tests inject a fake / a failing appender).
  //   - options.failClosedFindings: autonomous FIXING FAILS CLOSED — probe the store is writable up
  //     front (requireDurableStore) and, if it isn't, stop the loop WITHOUT applying any untracked fix.
  //   - options.midPassGuard: thread the mid-pass checkpoint-and-resume quota guard + the durable cursor
  //     into each grouped pass so a quota breach quiesces mid-pass instead of after ~1500 cells.
  const stateSession = options.runId ?? options.jobId ?? null;
  // P2a: a FRESH (non-resume) run starts with an EMPTY durable findings store — mirror the reviewed-cell
  // cursor reset below. Without this a new run inherits every prior run's findings into readAccumulated
  // (re-actioning already-fixed items, wasting budget) and the jsonl grows unbounded across runs. Reset
  // BEFORE the appender is constructed so it seeds its dedupe/seq from an empty store; a --resume KEEPS
  // it. Only touch the real store when this run actually uses it (no injected appender/accumulator).
  if (!options.resume && !deps.findingsAppender && !deps.accumulatedFindings && (options.durableFindings || options.failClosedFindings)) {
    (deps.resetFindingsStore ?? resetFindingsStore)(findingsStorePath(cwd));
  }
  let findingsAppender = deps.findingsAppender ?? null;
  let failClosedStop = null;
  if (!findingsAppender && (options.durableFindings || options.failClosedFindings)) {
    try {
      const mk = options.failClosedFindings
        ? (deps.requireDurableStore ?? requireDurableStore)
        : (deps.makeFindingsAppender ?? makeFindingsAppender);
      findingsAppender = mk(findingsStorePath(cwd), { session: stateSession, nowIso: () => (options.nowIso ?? nowIso()) });
    } catch (err) {
      // FAIL CLOSED: a fix without durable provenance must never land. Record the stop and skip the loop.
      if (options.failClosedFindings) failClosedStop = `cannot durably record findings (${String(err?.message ?? err)}) — autonomous fixing fails closed; no fix applied`;
    }
  }
  const midPassEnabled = Boolean(options.midPassGuard) && (Boolean(usageCeiling) || pause5h != null);
  const reviewCursor = midPassEnabled ? (deps.reviewCursor ?? makeReviewCursor(reviewCursorPath(resolveStateDir(cwd)))) : null;
  // Accumulated evidence (A): the gate/reduce operate over the WHOLE-RUN findings ledger, not just this
  // small pass — so a cross-file/SSOT issue seen in pass 1 still influences pass 2's gating. Defaults to
  // the durable store; injectable for tests. Off (→ []) when durable findings aren't enabled, so the
  // per-pass behaviour is unchanged for a bare caller.
  const readAccumulated = typeof deps.accumulatedFindings === "function"
    ? deps.accumulatedFindings
    : findingsAppender && (options.durableFindings || options.failClosedFindings)
      ? () => readFindingsStore(findingsStorePath(cwd))
      : () => [];

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
  // P2b: the hard-ceiling stale-TTL clock is a RUN-level property, not per-pass. The mid-pass guard is
  // rebuilt each pass (its startedAtMs resets), so a ~<2min default pass could never accrue enough
  // staleness to quiesce the ceiling and prior-pass staleness was forgotten. Track the last time usage
  // was USABLE across the whole run here (seeded to the run start on the first guarded pass, restored
  // from the checkpoint on --resume), seed each pass's guard from it, and re-checkpoint it after each
  // pass so persistent unreadability quiesces the hard ceiling RUN-wide even under small passes.
  let staleSinceMs = null;
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
  // v2 (council Codex P1): set when a tier advances over an INCOMPLETE pass (passStructuralOk false — a
  // cell failed six-eyes). The eventual "all tiers converged" then DISCLOSES the review debt instead of
  // claiming a clean sweep over cells some seat never actually reviewed (persistent-failure honesty).
  let coverageIncomplete = false;
  // AUTO-FIXABLE = a localized finding the fixer can actually apply. A propose-only / cross-cutting
  // finding (architecture/SSOT/logical) is offered to fix() only to be surfaced as a proposal — it
  // NEVER auto-applies, so counting it as live work would (a) falsely read as a stall and (b) pin a
  // per-tier stage forever: it recurs every pass, keeps `actionable` non-empty, and the tier never
  // advances while a Tier-2 correctness bug behind it is never reached (council Codex C2 P1). Defined
  // here (hoisted above the loop) so the GLOBAL dry/stall counters, the tier-advance gate, AND the
  // lower-tier RE-ENTRY check all reuse the SAME predicate — a propose-only / cross-cutting finding must
  // never cause demotion thrash (tier-fix council: re-entry guarded by exactly this).
  const autoFixable = (f) => f?.scope !== "cross-cutting" && f?.fixDisposition !== "propose-only";

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
      coverageIncomplete = Boolean(prior.coverageIncomplete);
      branch = prior.branch ?? null;
      // Restore the pause anti-thrash guard so a resume that immediately re-pauses on the SAME 5h
      // window with no progress is caught across the exit/resume boundary (not just within one process).
      if (prior.pauseGuard && typeof prior.pauseGuard === "object") pauseGuard = prior.pauseGuard;
      // P2b: restore the run-level stale-TTL clock so the hard-ceiling staleness keeps accruing across the
      // resume boundary — a resume that stays unreadable must still eventually quiesce the hard ceiling.
      if (Number.isFinite(prior.staleSinceMs)) staleSinceMs = prior.staleSinceMs;
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
    // FAIL-CLOSED (C): if the durable store could not be opened, autonomous fixing must not run at all —
    // this is terminal BEFORE the first pass, so no untracked fix is ever applied.
    if (failClosedStop) return failClosedStop;
    if (perTier && currentTier > 3) {
      // Honest terminal claim (council v2 Codex P1): only claim a CLEAN sweep when every advanced tier
      // saw a fully-complete review band. If a tier advanced over an incomplete pass (a persistently
      // failing cell), disclose the review debt instead of a false "converged".
      return coverageIncomplete
        ? "all tiers converged over REVIEWED cells — coverage INCOMPLETE: some cells never completed six-eyes review (a seat kept failing them), so an auto-fixable bug there may remain — re-run to close the gap"
        : "all tiers converged (structure -> correctness -> quality)";
    }
    const bounded = endlessStopReason({ passNo, spent, dryStreak: perTier ? 0 : dryStreak }, { maxPasses, totalBudget, dryStop });
    if (bounded) return bounded;
    if (!perTier && stalledStreak >= dryStop) return `stalled — actionable findings remain but none are auto-applicable (${stalledStreak} passes)`;
    return null;
  };

  // A FRESH (non-resume) run starts with an empty reviewed-cell cursor — a resume keeps the on-disk
  // cursor so its interrupted pass skips the cells it already reviewed.
  if (reviewCursor && !options.resume) reviewCursor.reset();

  // SSOT pause-emission (B): mid-pass quiesce AND the between-pass backstop share ONE decision + ONE
  // emit path. `applyPause` takes a `pause` decision object (from evaluateBetweenPassGuards, the shared
  // pure decision) + the checkpoint state, applies the anti-thrash / autonomous-wait / manual-exit
  // policy IDENTICALLY for both call sites, mutating stopReason/pauseInfo/pauseGuard via closure and
  // performing the autonomous in-process wait. Returns "continue" (autonomous wait resumed) or "break".
  async function applyPause(pause, cpState) {
    const blockersDesc = pause.blockers.map((b) => `${b.model} 5h ${b.percent}%≥${b.threshold}%`).join(", ");
    // ANTI-THRASH: a resume that immediately re-pauses on the SAME 5h window with NO durable-fix progress
    // is a spin (wrong reset, or the window never cleared) — hard-stop for manual attention, don't re-wait.
    if (pause.thrash) {
      stopReason = `quota-pause-manual: ${blockersDesc} — resumed but the same 5h window is still over threshold with no progress; stopping for manual attention`;
      pauseInfo = { schedulable: false, resumeAt: null, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), thrash: true, pauseId: pause.pauseId };
      reporter.line(`⏸ ${stopReason}`);
      onProgress(stopReason);
      checkpoint({ ...cpState, pauseGuard, stopReason, done: false });
      return "break";
    }
    // Remember this pause so the NEXT iteration / resume can detect a no-progress re-pause.
    pauseGuard = { windowSig: pause.windowSig, fixedCount: fixedAll.length, passNo };
    // AUTONOMOUS + schedulable: wait IN-PROCESS to the KNOWN future reset, then continue (the next pass
    // re-reads usage). Checkpoint FIRST so a mid-wait process death stays --resume-able. Only a valid,
    // bounded future wait — never an indefinite/absurd sleep.
    if (pause5h.autonomous && pause.schedulable) {
      const resumeMs = Date.parse(pause.resumeAt);
      const waitMs = Number.isFinite(resumeMs) ? Math.max(0, resumeMs - nowFn()) : NaN;
      if (Number.isFinite(waitMs) && waitMs <= MAX_AUTONOMOUS_WAIT_MS) {
        pauseGuard.autonomous = true;
        checkpoint({ ...cpState, pauseGuard, stopReason: null, done: false });
        reporter.line(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
        onProgress(`⏸ autonomous: waiting until ${pause.resumeAt} for ${blockersDesc} reset`);
        await sleepFn(waitMs);
        return "continue";
      }
      // Not a valid bounded wait → fall through to the manual/exit path (never a blind sleep).
    }
    // NON-autonomous (or autonomous-but-unschedulable): clean stop carrying a resume contract (exit 75).
    stopReason = pause.schedulable
      ? `quota-pause: ${blockersDesc} — resume ${pause.resumeAt}`
      : `quota-pause-manual: ${blockersDesc} — reset time not schedulable, resume manually`;
    pauseInfo = { schedulable: pause.schedulable, resumeAt: pause.resumeAt, blockers: pause.blockers, threshold: pause5h.threshold, autonomous: Boolean(pause5h.autonomous), pauseId: pause.pauseId };
    reporter.line(`⏸ ${stopReason}`);
    onProgress(stopReason);
    checkpoint({ ...cpState, pauseGuard, stopReason, done: false });
    return "break";
  }

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

    // B: the mid-pass checkpoint-and-resume quota guard for THIS pass (opt-in). It reads usage BEFORE
    // each cell (cheap, cached to GUARD_EVERY_MS) and, on a breach, finishes the in-flight cell then
    // QUIESCES. It carries the per-pass anti-thrash context so a mid-pass PAUSE builds the SAME pause
    // object the between-pass backstop would; the durable cursor bridges the pass's quiesce→resume.
    // P2b: seed the guard's stale-TTL clock from the run-level baseline so the hard-ceiling stale quiesce
    // measures staleness RUN-wide, not per-pass. Initialize the baseline to the run start on the first
    // guarded pass of a fresh run (a --resume restored it above).
    if (midPassEnabled && !Number.isFinite(staleSinceMs)) staleSinceMs = nowFn();
    const guard = midPassEnabled
      ? (deps.makeGuard ?? makeMidPassGuard)({
          cursor: reviewCursor,
          readUsage,
          usageCeiling,
          pause5h,
          now: nowFn,
          staleSinceMs,
          prevWindowSig: pauseGuard?.windowSig ?? null,
          madeProgress: () => fixedAll.length > (pauseGuard?.fixedCount ?? 0),
          pauseIdSeed: `${options.runId ?? ""}|${branch ?? ""}|${passNo}`
        })
      : null;

    let rev;
    try {
      rev = await withLimitRetry(() => review({ budget: passBudget, pass: passNo, changedFiles, guard, findingsAppender }));
    } catch (err) {
      passes.push({ pass: passNo, error: String(err?.message ?? err) });
      stopReason = `review error on pass ${passNo}: ${String(err?.message ?? err)}`;
      break;
    }
    // P2b: carry the guard's last-usable-usage timestamp back to the run level so the hard-ceiling
    // stale-TTL clock accrues ACROSS passes (the guard is rebuilt per pass). A pass that saw a usable
    // reading bumps the baseline forward (resetting staleness); a pass that never did leaves it put so
    // staleness keeps growing. Persisted into every checkpoint below.
    if (guard && Number.isFinite(guard.lastUsableAtMs)) staleSinceMs = guard.lastUsableAtMs;
    // B (checkpoint-and-resume): the grouped review QUIESCED mid-pass — a quota breach stopped it from
    // scheduling new cells after finishing the in-flight ones. The partial findings are ALREADY durably
    // recorded (the store) + the reviewed cells are in the durable cursor, so a --resume continues the
    // SAME band from the cursor with no re-charge. This pass's review band is INCOMPLETE, so we do NOT
    // gate/fix it — we checkpoint (WITHOUT advancing the window/scope; the review closure held the offset
    // back on a quiesce) and emit the SAME between-pass hard-stop / pause (SSOT). This runs BEFORE the
    // ran:false check so a first-cell quiesce reports the real quota reason, not a false "did not run".
    const quiesce = rev?.coverage?.quiesced ?? null;
    if (quiesce) {
      charge(rev?.coverage?.budgetSpent, 1); // charge the cells this pass actually dispatched before quiescing
      const freshQ = dedupeNew(rev?.findings ?? [], seenReview);
      reviewedAll.push(...freshQ);
      const cpQuiesce = { passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, quiesced: true, stopReason: null, done: false };
      passes.push({ pass: passNo, reviewed: (rev?.findings ?? []).length, fresh: freshQ.length, quiesced: quiesce.kind });
      if (quiesce.kind === "pause" && quiesce.pause) {
        onProgress(`⏸ mid-pass quiesce (pause) after finishing the in-flight cell — partial findings preserved, cursor checkpointed`);
        const action = await applyPause(quiesce.pause, cpQuiesce);
        if (action === "continue") continue; // autonomous wait resumed → the SAME band re-runs, cursor skips done cells
        break;
      }
      // ceiling / stale-ceiling → terminal hard stop (a --resume continues from the reviewed-cell cursor).
      stopReason = quiesce.kind === "stale-ceiling"
        ? `usage-ceiling: usage unreadable/stale beyond ${Math.round((quiesce.ttlMs ?? 0) / 1000)}s — quiesced mid-pass (hard ceiling cannot fail-soft indefinitely); resume when usage is readable`
        : ceilingStopReason(quiesce.breaches);
      reporter.line(`⛔ ${stopReason} — mid-pass quiesce; resume continues from the reviewed-cell cursor`);
      onProgress(stopReason);
      checkpoint({ ...cpQuiesce, stopReason, done: false });
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

    // A (accumulated-evidence gating): small passes bound WORK, not the EVIDENCE horizon. The gate +
    // SSOT reduce must see the WHOLE-RUN findings ledger, not just this pass's small band — else a
    // cross-file/SSOT issue first seen in pass 1 fragments into a symptom-fix in pass 2. Union this
    // pass's findings with the durable accumulated store (deduped by fingerprint), then gate the union.
    // readAccumulated() is [] for a bare caller → union == findings → byte-identical to before.
    const gateInput = (() => {
      const acc = readAccumulated() ?? [];
      if (!acc.length) return findings;
      const seenFp = new Set(findings.map((f) => fingerprintFinding(f)));
      // Don't re-surface a finding this run already FIXED (the store is an append-only discovery log, not
      // a resolution tracker) — else it re-enters the gate every pass and the fixer no-op-retries it.
      const fixedFps = new Set(fixedAll.map((x) => (x?.finding?.fingerprint ? String(x.finding.fingerprint) : fingerprintFinding({ file: x?.finding?.file ?? x?.file, title: x?.finding?.title, category: x?.finding?.category, line: x?.finding?.line }))));
      const extra = acc.filter((f) => {
        const fp = f.fingerprint ?? fingerprintFinding(f);
        if (seenFp.has(fp) || fixedFps.has(fp)) return false;
        seenFp.add(fp);
        return true;
      });
      if (!extra.length) return findings;
      // P1 (convergence): the accumulated store records are PRE-normalization — the durable append
      // (toRecord) persists severity/lens/category/file/line but NOT scope/fixDisposition, and the append
      // happens in the grouped review, BEFORE the review adapter (audit-fixloop-deps) normalizes. Fed raw
      // into the gate, a propose-only tier-2 finding (config_cicd_security / compliance_governance) reads
      // back with scope/fixDisposition undefined → autoFixable()===true → it keeps `actionable` non-empty
      // every pass → the per-tier stage NEVER advances past it (the loop can't converge). Re-normalize the
      // accumulated records with the SAME normalizer this pass's findings get (normalizeFindings, exactly
      // as the review adapter does), re-attaching file/line onto the canonical shape and PRESERVING the
      // stored fingerprint (dedup already ran above — do NOT weaken the fingerprint filtering) so
      // scope/fixDisposition/lens are correct before gate().
      const normExtra = normalizeFindings(extra, {}).map((nf, i) => ({
        ...nf,
        file: nf.location?.path ?? extra[i]?.file,
        line: nf.location?.startLine ?? extra[i]?.line,
        fingerprint: extra[i]?.fingerprint ?? nf.fingerprint
      }));
      return [...findings, ...normExtra];
    })();

    const gated = gate(gateInput, { changedFiles, pass: passNo });
    for (const p of gated.surfaced ?? []) {
      const k = proposedKey(p);
      if (!seenProposed.has(k)) {
        seenProposed.add(k);
        proposedAll.push(p);
      }
    }

    // Lower-tier RE-ENTRY (demotion) — the consolidation-first safety net once tier-advance is decoupled
    // from the completeness critic (tier-fix council: Grok's "D + re-entry"). If an AUTO-FIXABLE finding of
    // a lower tier surfaces LATE (e.g. a localized correctness bug found only after we advanced to the
    // quality tier), DEMOTE currentTier back to fix it first, so it is consolidated before the higher tier
    // keeps running on copies. This is real for the AUTO-FIXABLE tiers (correctness↔quality); structure/
    // SSOT lenses (tier 0/1) are propose-only, so they surface as PROPOSALS, never auto-fix, and correctly
    // do NOT demote. TWO exclusions prevent thrash: (a) autoFixable() drops propose-only/cross-cutting;
    // (b) a finding ALREADY escalated to a proposal (in seenProposed — correlate escalates multi-file/
    // cross-cutting clusters, and correlate is ON by default) must NOT re-demote — else that cluster would
    // demote → correlate re-escalates it → the tier re-advances → demote forever (council tier-review Grok
    // P1). Scans the accumulated actionable set (this pass ∪ the ledger union in gateInput → gated.actionable).
    // Runs BEFORE the per-tier filter so the demoted tier's findings are actionable THIS pass. §4: currentTier
    // is the SAME variable the checkpoint persists below (~640/712) — a demotion is what gets written.
    if (perTier) {
      const lowestActionableTier = Math.min(
        ...gated.actionable
          .filter((f) => autoFixable(f) && !seenProposed.has(proposedKey(f)))
          .map((f) => (typeof f.tier === "number" ? f.tier : tierOfLens(f.lens)))
      );
      if (Number.isFinite(lowestActionableTier) && lowestActionableTier < currentTier) {
        currentTier = lowestActionableTier;
        tierDryStreak = 0;
        stalledStreak = 0; // re-entering a lower tier IS work — don't carry a stale streak into it
      }
    }

    // Per-tier convergence restricts a pass to the CURRENT tier's actionable set.
    let actionable = perTier ? gated.actionable.filter((f) => (typeof f.tier === "number" ? f.tier : tierOfLens(f.lens)) === currentTier) : gated.actionable;
    // D (deterministic correlation, opt-in): give ONE writer each SAME-FILE anchor cluster (audit-fix
    // already serializes one writer per file + reverts a multi-file touch; enforceTouched) and ESCALATE
    // multi-file / cross-cutting / SSOT clusters to PROPOSAL instead of auto-fixing a symptom. No LLM.
    // The escalated findings move from `actionable` to proposals; same-file clusters stay actionable.
    if (options.correlate) {
      const { escalated } = correlateFindings(actionable, { importers: options.correlateImporters ?? {} });
      if (escalated.length) {
        const escIds = new Set(escalated.flatMap((c) => c.findingIds.map(String)));
        const isEsc = (f, i) => escIds.has(String(f?.id ?? f?.fingerprint ?? `f${i}`));
        for (let i = 0; i < actionable.length; i += 1) {
          const f = actionable[i];
          if (!isEsc(f, i)) continue;
          const p = { ...f, rejectedReason: "correlation: multi-file / cross-cutting cluster — escalated to proposal (not auto-fixed)" };
          const k = proposedKey(p);
          if (!seenProposed.has(k)) {
            seenProposed.add(k);
            proposedAll.push(p);
          }
        }
        actionable = actionable.filter((f, i) => !isEsc(f, i));
      }
    }

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
    // Split the coverage signal (tier-fix council). passStructuralOk = the SCHEDULED review band actually
    // completed (all cells reviewed by all seats) — a failed grouped batch (passComplete/complete === false)
    // does NOT count. It drives ONLY the GLOBAL dryStreak (via coverageComplete below), where a failed cell
    // SHOULD retry rather than converge — the per-TIER advance does NOT use it (see passRan below).
    // coverageComplete ADDITIONALLY requires the --deep completeness critic's verdict and drives ONLY the
    // GLOBAL dryStreak (+ flat-mode parity) — decoupled from tier-advance so an EMPTY tier is never pinned
    // forever by a windowed 40-of-~2000-cell "under-examined" verdict that can never clear on a small pass.
    const passStructuralOk = (rev?.coverage?.passComplete ?? rev?.coverage?.complete) !== false;
    const coverageComplete = passStructuralOk && rev?.coverage?.completenessComplete !== false;
    // TIER-advance signal (tier-fix v2 — the live-re-stall fix). `passComplete`/`passStructuralOk` is FALSE
    // as soon as ONE scheduled cell isn't reviewed by ALL seats, and over ~4 seats × 40 cells at least one
    // cell almost ALWAYS fails (rate-limit / timeout / flaky seat), so gating tier-advance on it pins an
    // EMPTY tier FOREVER in production (observed: currentTier=1, tierDryStreak=0, fixed=0, despite the
    // tier-fix v1). A TRANSIENTLY-failed cell can't DURABLY hide an auto-fixable finding (passComplete is
    // transient → the cell retries next pass), tier-0/1 structure is propose-only (never auto-fixed) so a
    // missed structure finding doesn't affect auto-fix, and a late correctness/quality finding is netted by
    // the lower-tier RE-ENTRY above. So the tier gate needs only that the pass actually RAN a review band
    // (coverage.ran — reviewed cells, not a starved budget-tail no-op); a starved pass still can't
    // fake-advance. RESIDUAL (honest): a cell that PERSISTENTLY fails on every seat, or is never windowed,
    // contributes no finding → an empty tier can advance PAST it — that is the DEFERRED enumerate/window
    // cell-skip coverage gap, NOT new to v2 (v1's passComplete gate never fixed those either — it just
    // stalled at tier 1 instead). undefined (per-file path) → treated as ran.
    const passRan = rev?.coverage?.ran !== false;
    // autoFixable() is hoisted above the loop (reused by the tier-advance gate + the lower-tier re-entry).
    const freshActionable = gate(freshFindings, { changedFiles, pass: passNo }).actionable.filter(autoFixable).length;
    dryStreak = freshFindings.length === 0 && coverageComplete ? dryStreak + 1 : 0;
    stalledStreak = freshActionable > 0 && freshFixed.length === 0 ? stalledStreak + 1 : 0;
    // Advance to the next tier once the current one has nothing new AUTO-FIXABLE for K passes AND the pass
    // actually RAN a review band (passRan — not a starved budget-tail no-op). Gate on passRan, NEVER
    // completenessComplete (critic pins a windowed pass "under-examined" every time) and NOT passComplete/
    // passStructuralOk either (one failed cell over 4×40 reviews makes it false almost every pass → an
    // EMPTY tier pinned forever in production). Consolidation-first is preserved by the lower-tier RE-ENTRY
    // above, not by a full-coverage gate that can never fire on a small responsive pass.
    if (perTier) {
      const tierFresh = freshFindings.filter((f) => tierOfLens(f.lens) === currentTier && autoFixable(f)).length;
      const tierAuto = actionable.filter(autoFixable).length;
      if (tierAuto > 0 || tierFresh > 0) tierDryStreak = 0;
      else if (passRan && (tierDryStreak += 1) >= dryStop) {
        // If we advance a tier while the pass band was NOT fully complete (a cell failed six-eyes), the
        // eventual "all tiers converged" must disclose that review debt (council v2 Codex P1) rather than
        // claim a clean sweep over cells that a seat never reviewed.
        if (!passStructuralOk) coverageIncomplete = true;
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
    const cpState = { passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, stopReason: null, done: false };
    checkpoint(cpState);
    // A pass that COMPLETED (not quiesced) clears the reviewed-cell cursor: the next pass reviews a
    // different scope/window, and even an overlapping file must be re-reviewed after a fix — the cursor
    // only bridges a quiesce→resume of the SAME interrupted pass.
    if (reviewCursor) reviewCursor.reset();

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
          stopReason = ceilingStopReason(ceiling.breaches); // SSOT message — same as the mid-pass quiesce
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
          // SSOT: the SAME pause-emission path the mid-pass quiesce uses (anti-thrash / autonomous-wait /
          // manual-exit), factored into applyPause — no copy-paste between the two call sites.
          const action = await applyPause(pause, cpState);
          if (action === "continue") continue; // autonomous wait resumed in-process; do NOT exit
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

  checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, stopReason, done: true });
  const result = { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak, changedFiles: [...new Set(fixedAll.map((f) => f.file))] };
  // `pause` is present ONLY when a NON-autonomous (or autonomous-but-unschedulable) pause actually
  // STOPPED the run — the companion turns it into the resume contract + exit 75. An autonomous wait
  // that resumed in-process and later converged leaves pauseInfo null (a normal terminal result).
  if (pauseInfo) result.pause = pauseInfo;
  return result;
}
