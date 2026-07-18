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
import { NOOP_REPORTER, observableWait } from "./progress.mjs";
import { readUsageSnapshot } from "./usage-guard.mjs";
import { MAX_AUTONOMOUS_WAIT_MS, evaluateBetweenPassGuards } from "./audit-loop-guards.mjs";
import { retryOnRateLimit } from "./audit-retry.mjs";
import { applyTierGating, orderByTier, tierOfLens } from "./audit-tiers.mjs";
import { isProposeOnly, lensIds } from "./audit-lenses.mjs";
import { fingerprintFinding } from "./ledger.mjs";
import { nowIso, resolveStateDir, writeFileAtomic } from "./state.mjs";
import { findingCountsByFile, findingsStorePath, makeFindingsAppender, readFindingsStore, requireDurableStore, resetFindingsStore } from "./audit-findings-store.mjs";
import { makeMidPassGuard, makeReviewCursor, reviewCursorPath } from "./audit-midpass-guard.mjs";
import { normalizeFindings } from "./audit-normalize.mjs";
import { correlateFindings } from "./audit-correlate.mjs";
import { STRUCTURE_LENSES, isStructureClass } from "./structure-gate.mjs";
import { expectedKeys, manifestDigest, posixKeyPath, reviewerSetHash, scopeGroupsForTier, sortManifest } from "./audit-tier-sweep.mjs";

// NOTE: an in-process multi-hour autonomous pause wait is FRAGILE — the machine/terminal must stay up —
// but the checkpoint written FIRST makes a mid-wait death --resume-able. The MAX_AUTONOMOUS_WAIT_MS
// bound + the between-pass guard DECISION now live in audit-loop-guards.mjs (SSOT with audit-endless).

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

// FIX #1 / F-B — the FIRST fixable tier: the LOWEST audit-tier that owns a lens the fixer can actually
// apply IN THIS RUN'S CONFIGURATION. A lens is runtime-fixable when it is not propose-only, OR it is a
// STRUCTURE lens (architecture_ssot/logical_sense) AND the operator consented to --structure-auto-apply
// (structure-wiring's council-gated multi-file transformer can then apply it). DERIVED from the registry,
// never hardcoded, so a lens→tier remap moves it automatically.
//   - WITHOUT structureAutoApply: tiers 0 (logical_sense) and 1 (architecture_ssot,
//     dependencies_supply_chain) are ENTIRELY propose-only, so staging them produces 0 fixes and only
//     burns passes/quota (~50 min live, 0 fixes) before Correctness (tier 2) is reached → floor = 2. Their
//     findings are STILL surfaced as proposals (the per-tier surfacing in runFixLoop + logicalProposals),
//     so nothing is lost.
//   - WITH structureAutoApply: the structure lenses become runtime-fixable → floor = 0. Tier 0
//     (logical_sense) is never review-sourced so it dry-advances in ≤ dryStop passes to tier 1
//     (architecture_ssot), which IS review-sourced and now gets STAGED → the transformer applies it.
// `.filter(Number.isFinite)` also guards a lens whose tierOfLens is non-finite (nit F-H). Fallback 0
// (stage everything) if the filter somehow yields no fixable lens.
const runtimeFixable = (id, structureAutoApply) => !isProposeOnly(id) || (structureAutoApply && STRUCTURE_LENSES.includes(id));
export function firstFixableTier({ structureAutoApply = false } = {}) {
  const tiers = lensIds().filter((id) => runtimeFixable(id, structureAutoApply)).map(tierOfLens).filter(Number.isFinite);
  return tiers.length ? Math.min(...tiers) : 0;
}
// The exported constant is the DEFAULT (no structure consent) floor === 2 on the current registry — kept
// so downstream references + the tests that pin `=== 2` still hold. The RUN's effective floor is derived
// per-call from options.structureAutoApply inside runFixLoop.
export const FIRST_AUTOFIXABLE_TIER = firstFixableTier();

// F-A — how many DETERMINISTIC test-reds a single-file fix may accrue before the loop stops retrying it
// and SURFACES it as a proposal instead. A `testRed` entry already implies the fix stayed IN-FILE
// (enforceTouched passed before tests ran) yet the suite went red — a strong cross-file-coupling /
// semantic signal. Threshold 2 tolerates ONE flaky red, then surfaces on the second (immediate/N=1 is
// defensible; 2 is safe against a flaky suite). Named so it is trivially tunable.
const RED_ESCALATE_THRESHOLD = 2;

// WAVE 3 — the (file,tier) LIVELOCK CIRCUIT-BREAKER threshold. A test-GREEN fix that CHANGES a file's
// content without RESOLVING the finding re-hashes the file → its cells re-open → the SAME finding recurs →
// it is re-fixed → oscillation, bounded today only by maxPasses/budget. After this many invalidation cycles
// on one (file,tier) with a finding that keeps coming back (no net reduction), OR on the exact recurrence of
// a prior (file,tier,beforeHash,afterHash,fingerprint) content transition, the file is QUARANTINED from
// further auto-fix and its findings are surfaced as proposals so the tier can SETTLE. Small on purpose (a
// non-converging file is caught fast); deterministic (content hashes + fingerprints, never a clock).
export const LIVELOCK_MAX_CYCLES = 3;

// The SEMANTIC consensus/dedup pass (audit-consensus-merge) runs on this cadence — every Nth pass, starting
// at pass 1 (the largest raw single-seat backlog is on the first passes). It spends one Grok call to fuse
// same-file findings that different seats meant identically (the lexical merge misses them), so a bug both
// codex and grok found becomes CONSENSUS and clears the fix consensus gate. Cadenced (not every pass) so it
// never dominates the loop's Grok budget. FAIL-SOFT + no-op when the dep is unwired (bare callers/tests).
const CONSENSUS_MERGE_EVERY = 2;

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
  // Long in-process waits (the --pause-at-5h quota wait here; the rate-limit backoff below) must stay
  // OBSERVABLY ALIVE or a watcher/monitor mistakes the silent sleep for a hang and kills a healthy run.
  // Tests inject deps.sleep (kept byte-identical); a real run's default sleep heartbeats via the reporter.
  const sleepFn =
    typeof deps.sleep === "function"
      ? deps.sleep
      : (ms) => observableWait(ms, { reporter, reason: "quota pause — waiting for 5h window reset" });

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
        // Observable backoff so a multi-minute rate-limit wait keeps progress.json fresh (a bare
        // setTimeout froze it, and a monitor then killed the healthy backing-off run). Tests inject
        // deps.sleep; the real-run fallback heartbeats via the reporter.
        sleep: deps.sleep ?? ((ms) => observableWait(ms, { reporter, reason: "rate-limit backoff" })),
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
  // F-A: per-finding count of DETERMINISTIC test-reds across passes (key = proposedKey). When a finding
  // reaches RED_ESCALATE_THRESHOLD reds it is PROMOTED to a proposal and — via the same count — excluded
  // from staging so its tier can dry-advance instead of being pinned by a coupled finding that fails
  // tests forever. F-D: a small (key, reason) guard so a recurring failure is pushed to `failedAll`
  // (the report list) only ONCE, while the escalation COUNT above keeps climbing every pass.
  const seenFailed = new Map();
  const seenFailedReports = new Set();
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
  // WAVE 2 (epoch-sweep, docs/epoch-sweep-design.md): an OPT-IN mode that drives per-pass scheduling AND
  // tier-advance from a DURABLE, run-wide cell-coverage LEDGER instead of the modulo window + passRan
  // heuristic. Sweep mode REQUIRES the grouped path + per-tier (fail-closed at the CLI). With the flag
  // OFF (`sweep === null`) EVERY sweep code path below is skipped and the loop is byte-identical to today.
  const sweepMode = Boolean(options.epochSweep);
  const sweep = sweepMode ? (deps.sweep ?? null) : null;
  if (sweepMode && !sweep) throw new Error("runFixLoop: --epoch-sweep requires deps.sweep (grouped review); none was provided");
  // Sweep mode drives coverage per tier, so it implies per-tier convergence regardless of the caller flag.
  const perTier = Boolean(options.perTierConvergence) || sweepMode;
  // The sealed-manifest denominator (built once at init / reconstructed on resume), the frozen epoch, and
  // the checkpointed TIER PLAN the sweep walks (F-B: with --structure-auto-apply every tier is fix-staged;
  // without it, fix stages [2,3] then REPORT-ONLY final-content sweeps [0,1]).
  let sweepManifest = null;
  const sweepEpoch = sweep?.epochHash ?? null;
  let tierPlan = null;
  let tierPlanIndex = 0;
  // WAVE 3 — the (file,tier) LIVELOCK CIRCUIT-BREAKER state (sweep mode). A test-GREEN fix that CHANGES a
  // file's content without RESOLVING the finding re-hashes it → cells re-open → the same finding recurs →
  // re-fixed → forever (neither F-A's test-red counter — the fix "succeeded" — nor seenFixed — dedupes
  // REPORTING only — catches it). These make the oscillation observable + deterministically bounded:
  //  - sweepFixExcluded:   posix files QUARANTINED from further auto-fix run-wide (findings surface as
  //                        proposals). A FIX-exclusion ONLY — it NEVER subtracts from the coverage
  //                        denominator (correction A); a quarantined file's cells stay COUNTED until they are
  //                        actually reviewed. (A livelocking file is distrusted for auto-fix everywhere; its
  //                        coverage is unaffected, so file-global vs (tier,file) is only an auto-fix policy.)
  //  - livelockState:      JSON([tier,file]) → { cycles, fixedFps, firstOpen } — invalidation cycles, per-
  //                        fingerprint re-fix counts (a fingerprint fixed ≥2× is a finding that came back =
  //                        no progress), and the file's open-finding count at the FIRST cycle (correction C:
  //                        the fp-AGNOSTIC "no net reduction" baseline, for a defect whose fix DRIFTS its fp).
  //  - livelockTransitions: seen JSON([tier,file,beforeHash,afterHash,fingerprint]) transitions — an EXACT
  //                        repeat is a proven content oscillation (A↔B). All three are CHECKPOINTED via
  //                        sweepCheckpoint so a --resume keeps the oscillation memory (never re-fixes a
  //                        quarantined file afresh, never re-counts cycles from zero).
  const sweepFixExcluded = new Set();
  const livelockState = new Map();
  const livelockTransitions = new Set();
  // FIX #1 / F-B — start at the FIRST FIXABLE tier, derived per-run from the operator's structure consent.
  //   - WITHOUT --structure-auto-apply: FIRST_TIER = 2 (Correctness). Tiers 0 (logical_sense) and 1
  //     (architecture_ssot, dependencies_supply_chain) are ENTIRELY propose-only — they can only surface
  //     proposals, never auto-fix — so staging them burned ~dryStop passes/tier (~50 min live) for 0 fixes
  //     before Correctness was reached. Their findings are STILL surfaced (tier-0 via logicalProposals;
  //     tier-1 via the per-tier surfacing below) — nothing is lost.
  //   - WITH --structure-auto-apply: FIRST_TIER = 0. The council-gated multi-file transformer can now apply
  //     the structure lenses, so the floor drops. Tier 0 (logical_sense) is never review-sourced → it
  //     dry-advances in ≤ dryStop passes (a bounded warmup) to tier 1 (architecture_ssot), which IS
  //     review-sourced and gets STAGED to the transformer. NOTE: detector-sourced logical_sense proposals
  //     (options.logicalProposals) still bypass the fixer entirely — a pre-existing gap tracked separately,
  //     NOT addressed here.
  // The resume clamp (below), the re-entry floor, and the sub-FIRST_TIER surfacing loop all read FIRST_TIER,
  // so they inherit the effective floor.
  const FIRST_TIER = firstFixableTier({ structureAutoApply: Boolean(options.structureAutoApply) });
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

  // FIX-SIDE tier of a finding — the tier whose pass STAGES it, derived from the FIX-ELIGIBILITY lens
  // (fixLens), NOT the coverage lens. A correctness bug surfaced under the logical_sense group (relens)
  // carries lens=logical_sense (Tier 0, coverage) but fixLens=correctness (Tier 2): it must be staged when
  // the loop reaches Tier 2, alongside the native correctness findings — never at Tier 0 where nothing
  // auto-applies. CRITICAL (council diff-review P1): applyTierGating stamps a numeric `f.tier` from the
  // COVERAGE lens BEFORE this runs, so a reattributed finding must consult its fixLens tier FIRST — else the
  // coverage-derived tier (0) drags it back to a propose-only tier and the reattributed bug is never staged
  // (the whole feature was inert on the default gate path). Only a NON-reattributed finding honours a
  // caller/plan-set numeric tier. Coverage/reporting keep f.lens untouched; only the staging tier uses fixLens.
  const fixTierOf = (f) => {
    const fl = f?.fixLens;
    if (fl && fl !== f?.lens) return tierOfLens(fl); // reattributed → operative tier is the fixLens tier, always
    return typeof f?.tier === "number" ? f.tier : tierOfLens(f?.lens);
  };

  if (options.resume) {
    const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadFixLoopCheckpoint(cwd);
    if (prior && Array.isArray(prior.fixed)) {
      fixedAll.push(...prior.fixed);
      for (const f of prior.fixed) seenFixed.add(fixKey(f));
      if (Array.isArray(prior.failed)) {
        failedAll.push(...prior.failed);
        // F-D: seed the (key, reason) report-dedupe from the checkpoint so a resumed run does not re-append
        // a failure already recorded in the prior segment's `failed` list.
        for (const e of prior.failed) {
          if (e?.finding) seenFailedReports.add(`${proposedKey(e.finding)} ${e?.reason ?? ""}`);
        }
      }
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

  // ── WAVE 2 sweep init (once, before the loop; sweep mode only) ─────────────────────────────────
  // Freeze the epoch + tier plan, then either (fresh) reset the ledger, append the header, build the
  // sealed manifest from disk, and seal it — or (resume) FAIL CLOSED on any mismatch (epoch / corrupt /
  // missing header / checkpoint-ahead / manifest-digest). The ledger lives in the state dir, NEVER the
  // working tree; the resume validation touches nothing. `failClosedStop` (already the SSOT for a
  // terminal-before-first-pass stop) carries a blocked resume so computeTerminalStop ends the run cleanly.
  // TIER ORDER: correctness (2) leads in BOTH plans. The structure-first order [0,1,2,3] starved the
  // high-value, high-yield correctness tier behind full coverage of the mostly-propose-only structure
  // tiers (measured: a run reached only tier-0/1 for many passes; and the M9 structure transform, gated by
  // the SAME full-suite-green + §6-unanimous + public-API-unchanged ladder, rarely lands — currently ~never
  // while the planner seat returns null). "Consolidate before correctness" is not load-bearing: that ladder
  // (not the tier order) is what keeps a later consolidation from dropping a correctness fix. So correctness
  // fixes lead; with structure consent, structure (0) + architecture (1) still auto-apply, AFTER correctness.
  const deriveTierPlan = () => {
    // Without structure consent, tiers 0/1 are propose-only and sink to the end (report-only).
    if (!options.structureAutoApply) return [{ tier: 2, fix: true }, { tier: 3, fix: true }, { tier: 0, fix: false }, { tier: 1, fix: false }];
    // STRUCTURE-FIRST (opt-in --structure-first): run structure/SSOT (0) + architecture/deps (1) BEFORE
    // correctness — for operators whose PRIMARY goal is refactoring / SSOT consolidation / code reduction,
    // so a multi-file consolidation lands before correctness runs on the consolidated code (the original
    // ordering, made explicit + opt-in). Default stays correctness-first (0-starvation fix 5f48237): the
    // high-yield, always-landing correctness tier leads, structure follows.
    return options.structureFirst
      ? [{ tier: 0, fix: true }, { tier: 1, fix: true }, { tier: 2, fix: true }, { tier: 3, fix: true }]
      : [{ tier: 2, fix: true }, { tier: 0, fix: true }, { tier: 1, fix: true }, { tier: 3, fix: true }];
  };
  if (sweepMode) {
    tierPlan = deriveTierPlan();
    const cursor = sweep.cursor;
    if (options.resume) {
      const prior = deps.loadCheckpoint ? deps.loadCheckpoint() : loadFixLoopCheckpoint(cwd);
      const priorSweep = prior && typeof prior.sweep === "object" ? prior.sweep : null;
      const loaded = cursor.load();
      const blocked = (why) => { failClosedStop = `epoch-sweep resume blocked (fail-closed): ${why} — the working tree was left untouched; re-run without --resume to start a fresh sweep`; };
      // FAIL-CLOSED resume validation (Wave 2 B). A torn TAIL line (droppedTail) is fine — that cell just
      // re-reviews; only interior corruption, a missing/unsealed manifest, an epoch/reviewer/run/tier-plan
      // mismatch, a checkpoint AHEAD of the ledger, or a validated digest mismatch aborts (tree untouched).
      if (loaded.corrupt) blocked("the durable coverage ledger has an invalid interior record (corruption)");
      else if (!loaded.header) blocked("the durable coverage ledger has no header record");
      else if (!loaded.seal) blocked("the durable coverage ledger is UNSEALED (a torn or missing manifest-seal) — the denominator cannot be trusted");
      else if (loaded.header.epochHash !== sweepEpoch) blocked("the run configuration changed since the ledger was written (epoch fingerprint mismatch)");
      else if (reviewerSetHash(loaded.header.reviewers) !== reviewerSetHash(sweep.reviewerSet)) blocked("the frozen reviewer set changed since the ledger was written (reviewer identity mismatch)");
      else if (!priorSweep) blocked("the checkpoint carries no sweep block (it was written by a legacy, non-sweep run)");
      else if (priorSweep.runId != null && loaded.header.runId !== priorSweep.runId) blocked("the ledger header runId does not match the checkpoint (a different run wrote this ledger)");
      else if (JSON.stringify(loaded.header.tierPlan ?? null) !== JSON.stringify(priorSweep.tierPlan ?? null)) blocked("the ledger header tier plan does not match the checkpoint tier plan");
      else if (Number.isFinite(priorSweep.ledgerSeq) && loaded.seq < priorSweep.ledgerSeq) blocked("the checkpoint is AHEAD of the ledger (a lost durable append) — cannot safely continue");
      if (!failClosedStop) {
        // Reconstruct the manifest (files + DEBT) from the ledger via ordered last-wins replay (a post-fix
        // re-hash supersedes the original; a verified deletion drops out; a debt row is carried) — canonical
        // order makes the reconstructed digest INDEPENDENT of append order (B). Then REQUIRE the seal's
        // digest+fileCount to match the reconstruction AND the reconstruction to match the checkpoint digest.
        sweepManifest = sortManifest({ files: loaded.manifest.files, debt: loaded.manifest.debt });
        sweepManifest.digest = manifestDigest(sweepManifest);
        if (loaded.seal.digest != null && loaded.seal.digest !== sweepManifest.digest) blocked("the manifest-seal digest does not match the reconstructed manifest (a torn or tampered manifest)");
        else if (Number.isFinite(loaded.seal.fileCount) && loaded.seal.fileCount !== sweepManifest.files.length) blocked("the manifest-seal file count does not match the reconstructed manifest");
        else if (priorSweep.manifestDigest && sweepManifest.digest !== priorSweep.manifestDigest) blocked("the reconstructed manifest does not match the checkpoint digest (unexplained ledger drift)");
        else {
          tierPlan = Array.isArray(priorSweep.tierPlan) && priorSweep.tierPlan.length ? priorSweep.tierPlan : tierPlan;
          tierPlanIndex = clamp(priorSweep.tierPlanIndex ?? 0, 0, tierPlan.length);
          // WAVE 3: restore the livelock breaker state so a --resume KEEPS the oscillation memory — a file
          // quarantined before the interrupt stays quarantined (never re-fixed afresh), and cycle/transition
          // counts continue instead of resetting to zero (which would let a proven livelock burn budget again).
          const lc = priorSweep.livelock;
          if (lc && typeof lc === "object") {
            for (const f of Array.isArray(lc.excluded) ? lc.excluded : []) sweepFixExcluded.add(String(f));
            for (const row of Array.isArray(lc.state) ? lc.state : []) {
              if (Array.isArray(row) && row.length >= 2) livelockState.set(String(row[0]), { cycles: clamp(row[1], 0, 1e9), fixedFps: new Map(Array.isArray(row[2]) ? row[2] : []), firstOpen: row.length >= 4 && Number.isFinite(row[3]) ? row[3] : null });
            }
            for (const t of Array.isArray(lc.transitions) ? lc.transitions : []) livelockTransitions.add(String(t));
          }
        }
      }
    } else {
      // RUN-FENCING (B, cheap): if a ledger already exists under a DIFFERENT header.runId (e.g. a concurrent
      // --epoch-sweep run in the same state dir) and this is NOT a resume, FAIL CLOSED rather than reset() —
      // never truncate another run's ledger. Only fences when both runIds are set (a runId-less run resets
      // as before — byte-identical to the prior behaviour).
      const existing = cursor.load();
      if (existing.header && existing.header.runId != null && options.runId != null && existing.header.runId !== options.runId) {
        failClosedStop = `epoch-sweep blocked (fail-closed): the durable coverage ledger belongs to a different run (runId ${existing.header.runId} ≠ ${options.runId}) — refusing to truncate it; use --resume or a clean state dir`;
      } else {
        cursor.reset();
        cursor.appendHeader({ runId: options.runId ?? null, baseBranch: options.ledgerBaseBranch ?? null, baseHead: options.baseHead ?? null, epochHash: sweepEpoch, reviewers: sweep.reviewerSet, tierPlan });
        sweepManifest = sweep.buildManifest();
        for (const row of sweepManifest.files) cursor.appendManifest(row);
        // PERSIST DEBT (B): the sealed digest INCLUDES debt, so any initial unreadable/oversize file must be
        // written too — else a resume reconstructs debt:[] and can never re-match the digest.
        for (const d of sweepManifest.debt ?? []) cursor.appendDebt(d);
        cursor.sealManifest({ digest: sweepManifest.digest, fileCount: sweepManifest.files.length });
        tierPlanIndex = 0;
      }
    }
    if (!failClosedStop) currentTier = tierPlan[Math.min(tierPlanIndex, tierPlan.length - 1)].tier;
  }

  // WAVE 3: serialize the livelock breaker state into the checkpoint's sweep block (Maps/Sets → arrays) so
  // a --resume keeps the oscillation memory. Empty structures on a run that never tripped ⇒ trivially small.
  const livelockCheckpoint = () => ({
    excluded: [...sweepFixExcluded],
    state: [...livelockState].map(([k, v]) => [k, v.cycles, [...v.fixedFps], v.firstOpen ?? null]),
    transitions: [...livelockTransitions]
  });
  // WAVE 2: the checkpoint's sweep block — pins the mode + epoch + ledger position so a --resume cannot
  // flip mode or lose the denominator. undefined (dropped by JSON) in legacy mode. WAVE 3 folds the livelock
  // breaker state in here (one place) so every checkpoint call site carries it automatically.
  const sweepCheckpoint = () =>
    sweepMode ? { v: 1, runId: options.runId ?? null, epochHash: sweepEpoch, ledgerSeq: sweep.cursor.seq, manifestDigest: sweepManifest?.digest ?? null, tierPlan, tierPlanIndex, livelock: livelockCheckpoint() } : undefined;
  // WAVE 3 (correction A — coverage-guarantee): coverage / tier-advance / re-entry / terminal / summary ALL
  // read the RAW ledger denominator. The livelock quarantine is a FIX-EXCLUSION ONLY, NEVER a coverage-
  // exclusion — a quarantined file's cells stay COUNTED until they are actually reviewed. SUBTRACTING them
  // (the earlier `genuinePending`) let a tier advance over NEVER-reviewed cells and falsely claim 100%
  // coverage — the exact silent coverage-guarantee violation this feature exists to prevent. The tier still
  // SETTLES after a quarantine WITHOUT any subtraction, because the fixer STOPS mutating the file (the
  // actionable filter surfaces its findings as proposals): the pending-driven scheduler reviews its re-opened
  // cells, marks them done, and — with no fix to re-hash them — they STAY done → raw tierPending reaches 0
  // NATURALLY → the tier advances with GENUINE 100% coverage. This helper only spares repeating the scoped /
  // reviewerSet args. Reads the LIVE `sweepManifest` (reassigned across the run) via the default arg.
  const tierPendingRaw = (tier, manifest = sweepManifest) => {
    const scoped = scopeGroupsForTier(sweep.baseGroups, tier);
    return sweep.cursor.tierPending(tier, manifest, scoped, sweep.reviewerSet, sweepEpoch);
  };
  // A per-tier pending-debt summary for the terminal coverage-incomplete disclosure (cheap, in-memory).
  // Uses the RAW ledger denominator (correction A) — a quarantined file's un-reviewed cells are still real
  // pending debt until they are reviewed, never hidden from the disclosure.
  const sweepPendingSummary = () => {
    if (!sweepMode || !sweepManifest) return "";
    const parts = [];
    for (const entry of tierPlan) {
      const p = tierPendingRaw(entry.tier);
      if (p.count > 0) parts.push(`tier ${entry.tier}: ${p.count} cell(s)`);
    }
    const debt = sweepManifest.debt?.length ?? 0;
    if (debt) parts.push(`${debt} unreadable/oversize file(s)`);
    return parts.length ? parts.join(", ") : "no pending cells";
  };
  // WAVE 3 (findings-store staleness): the durable store is APPEND-ONLY, so a finding whose source cell's
  // CONTENT has since moved (a fix re-chunked the file) — or whose epoch changed — would be re-offered from
  // the store union to the gate FOREVER (a stale-actionable set). In sweep mode, DROP any STAMPED store
  // record whose sweepCellKey is no longer an expected key under the current sealed manifest + epoch (its
  // cell vanished). A record whose cell is still expected stays; a legacy / unstamped record (non-sweep, or
  // pre-Wave-3) is ALWAYS-CURRENT and untouched — so a bare / non-sweep caller is byte-identical. The
  // expected-key set (union over the tier plan) is built ONCE per call, and only when a stamped record is
  // actually present (the common no-store / no-stamp pass pays nothing).
  const excludeStaleSweepFindings = (records) => {
    if (!sweepMode || !sweepManifest || !Array.isArray(records) || !records.some((r) => r && typeof r.sweepCellKey === "string")) return records;
    const expected = new Set();
    for (const entry of tierPlan) {
      const scoped = scopeGroupsForTier(sweep.baseGroups, entry.tier);
      for (const k of expectedKeys(sweepManifest, entry.tier, scoped, sweep.reviewerSet, sweepEpoch)) expected.add(k);
    }
    return records.filter((r) => !(r && typeof r.sweepCellKey === "string") || expected.has(r.sweepCellKey));
  };

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
    // this is terminal BEFORE the first pass, so no untracked fix is ever applied. In sweep mode a blocked
    // resume (epoch/manifest/corrupt) is surfaced here too, so the loop never touches the tree.
    if (failClosedStop) return failClosedStop;
    // WAVE 2: sweep convergence = the tier PLAN was fully walked. Coverage is PROVEN per tier by the sealed
    // manifest denominator, not by passRan — so this claim is exact. If any pending debt remained at a
    // budget/pass ceiling, `coverageIncomplete` is set (below) and the disclosure names the per-tier debt.
    if (sweepMode) {
      if (tierPlanIndex >= tierPlan.length) {
        // The whole plan was walked ⇒ EVERY tier reached tierPending==0 (that is the only way a sweep tier
        // advances), so incompleteness is now DERIVED purely from run-level DEBT — never a stale restored
        // coverageIncomplete flag (a resume that RE-COVERS an interrupt's pending must report clean). F: a
        // permanently unreadable/oversize DEBT file (excluded from the per-tier gate) still means the run
        // did NOT cover every byte, so it is disclosed as INCOMPLETE (the ledger persists it) here.
        const debtRemains = (sweepManifest?.debt?.length ?? 0) > 0;
        return debtRemains
          ? `epoch-sweep converged over REVIEWED cells — coverage INCOMPLETE: ${sweepPendingSummary()}; the ledger persists it, so a re-run with the same epoch continues the denominator`
          : "epoch-sweep converged — every tier reached 100% cell coverage under the sealed manifest";
      }
    } else if (perTier && currentTier > 3) {
      // Honest terminal claim (council v2 Codex P1): only claim a CLEAN sweep when every advanced tier
      // saw a fully-complete review band. If a tier advanced over an incomplete pass (a persistently
      // failing cell), disclose the review debt instead of a false "converged".
      return coverageIncomplete
        ? "all tiers converged over REVIEWED cells — coverage INCOMPLETE: some cells never completed six-eyes review (a seat kept failing them), so an auto-fixable bug there may remain — re-run to close the gap"
        // F-E: staging begins at FIRST_TIER (2 by default; 0 under --structure-auto-apply), so the message
        // discloses the floor rather than implying every tier was STAGED. The lower tiers are still
        // surfaced as proposals — see the sub-FIRST_TIER surfacing loop.
        : `all tiers converged (structure -> correctness -> quality, staged from tier ${FIRST_TIER})`;
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
    // WAVE 2: in sweep mode the review tier is the ledger-driven current sweep tier (not the static
    // options.reviewTier), and the review closure gets the sweep context (cursor + epoch + frozen
    // reviewer set + the CURRENT manifest + this tier's scoped groups) so it can (a) select the files
    // with pending cells and (b) mark each reviewed cell done through the SHARED cellSweepKey builder.
    const scopedGroups = sweepMode ? scopeGroupsForTier(sweep.baseGroups, currentTier) : null;
    const reviewTier = sweepMode ? currentTier : (options.reviewTier ?? null);
    const reviewSweep = sweepMode ? { cursor: sweep.cursor, epochHash: sweepEpoch, reviewerSet: sweep.reviewerSet, manifest: sweepManifest, scopedGroups } : undefined;
    // Brocken B (six-eyes-preserving front-loading): the DYNAMIC finding-density signal for the pending-cell
    // scheduler — how many findings each posix file has produced so far THIS RUN (the durable store union
    // readAccumulated already reads). SWEEP MODE ONLY (P1 fix): it is threaded into review → orderPendingFiles
    // so a file that already surfaced findings is scheduled AHEAD of an equal-hotspot clean file — the ledger
    // guarantees every cell still drains regardless of order (coverage untouched). In the NON-sweep loop the
    // review walks a progressive-OFFSET window over the STATIC hotspot order; feeding it a per-pass-changing
    // sort would shift band boundaries and could SKIP a file — a real coverage regression — so we pass
    // `undefined` there and the legacy static bands are preserved. Empty for a bare/non-durable sweep caller
    // (readAccumulated → []) ⇒ pure hotspot order (byte-identical; coverage/tier-advance unchanged).
    const findingCounts = sweepMode ? findingCountsByFile(readAccumulated()) : undefined;
    try {
      // Wave 1 Stage 2 (BB1): thread an OPTIONAL review tier into the grouped-review adapter so
      // enumeration is scoped to that tier's lenses. `options.reviewTier ?? null` — a NEW optional
      // option; default null = TODAY's behavior (no scoping, byte-identical). Wave 2 replaces this
      // static value with the ledger-driven current sweep tier.
      rev = await withLimitRetry(() => review({ budget: passBudget, pass: passNo, changedFiles, guard, findingsAppender, tier: reviewTier, sweep: reviewSweep, findingCounts }));
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
      const cpQuiesce = { passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, sweep: sweepCheckpoint(), quiesced: true, stopReason: null, done: false };
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
    // WAVE 2: a durable coverage-ledger write failed mid-pass (fsync). The sweep denominator can no
    // longer be trusted (a "done" that isn't durable), so hard-stop sweep mode — never keep advancing
    // over cells whose done-record may be lost. The findings themselves were flushed first (durable).
    if (sweepMode && rev?.coverage?.sweepError) {
      passes.push({ pass: passNo, error: `sweep ledger write failed: ${rev.coverage.sweepError}` });
      stopReason = `epoch-sweep hard stop on pass ${passNo}: durable coverage ledger write failed (${rev.coverage.sweepError}) — resolve the state dir and --resume`;
      checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, sweep: sweepCheckpoint(), stopReason, done: false });
      break;
    }
    // A review that DID NOT actually run (no reachable reviewer, or a rate-limit the
    // retries couldn't outlast) returns ran:false with zero findings. That is NOT a clean
    // "nothing to fix" — counting it toward the dry streak would let a throttled run declare
    // false convergence and exit reporting success while nothing was reviewed. Stop honestly.
    // WAVE 2 EXCEPTION: a sweep pass STARVED by the per-pass budget tail (pending cells exist but not
    // even one whole triple was affordable) is NOT a false-convergence and NOT backends-down — the OWED
    // cells stay pending. Do not hard-stop; skip to the next pass (the budget/maxPasses ceiling bounds
    // it, and the ledger persists the debt for a resume). It also must not advance the tier.
    if (rev && rev.ran === false) {
      if (sweepMode && rev?.coverage?.starved) {
        passes.push({ pass: passNo, starved: true });
        onProgress(`  pass ${passNo}: starved (per-pass budget below one triple) — pending cells stay OWED`);
        checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, sweep: sweepCheckpoint(), stopReason: null, done: false });
        if (reviewCursor) reviewCursor.reset();
        continue;
      }
      passes.push({ pass: passNo, error: "review did not run (no reachable reviewer or rate-limited)" });
      stopReason = `review did not run on pass ${passNo} (backends unavailable or rate-limited) — stopped without false convergence`;
      break;
    }
    const findings = rev?.findings ?? [];
    charge(rev?.coverage?.budgetSpent, Math.max(1, passBudget)); // a review always costs >= 1
    // Surface the REVIEW spend now, not only at pass end: a pass with a long fix phase (e.g. flaky-suite
    // attribution runs the suite 4× per fix) otherwise shows a frozen pre-charge "spent 0" for many
    // minutes, reading as "no budget used / nothing happening" while the review already cost real calls.
    reporter.budget(spent, totalBudget);
    const freshFindings = dedupeNew(findings, seenReview);
    reviewedAll.push(...freshFindings);

    // A (accumulated-evidence gating): small passes bound WORK, not the EVIDENCE horizon. The gate +
    // SSOT reduce must see the WHOLE-RUN findings ledger, not just this pass's small band — else a
    // cross-file/SSOT issue first seen in pass 1 fragments into a symptom-fix in pass 2. Union this
    // pass's findings with the durable accumulated store (deduped by fingerprint), then gate the union.
    // readAccumulated() is [] for a bare caller → union == findings → byte-identical to before.
    const gateInput = (() => {
      // WAVE 3: in sweep mode drop stale store records (their source cell's content moved / epoch changed)
      // BEFORE the union, so a content-moved finding is not re-offered to the gate forever. No-op otherwise.
      const acc = excludeStaleSweepFindings(readAccumulated() ?? []);
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

    // SEMANTIC consensus/dedup (regelmäßig, CONSENSUS_MERGE_EVERY cadence): before gating, ask Grok whether
    // same-file single-seat findings from DIFFERENT seats are the SAME underlying issue. Matches → union their
    // seats (so the finding reads as CONSENSUS, which unblocks the fix consensus gate for reattributed logical
    // bugs) and drops the duplicate so the fixer isn't offered it twice. FAIL-SOFT: deps.consensusMerge returns
    // the input unchanged on any Grok error, and the whole step no-ops when the dep is unwired (bare/test callers).
    let mergedGateInput = gateInput;
    if (typeof deps.consensusMerge === "function" && passNo % CONSENSUS_MERGE_EVERY === 1) {
      try {
        const r = await deps.consensusMerge(gateInput, { pass: passNo });
        if (r && Array.isArray(r.findings)) mergedGateInput = r.findings;
      } catch {
        /* fail-soft: gating proceeds on the un-merged findings */
      }
    }

    const gated = gate(mergedGateInput, { changedFiles, pass: passNo });
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
    // WAVE 2: sweep mode does NOT use this finding-driven demotion (it would desync currentTier from the
    // checkpointed tierPlanIndex). Its consolidation-first safety net is the manifest re-hash re-entry
    // after a fix (below), which walks the plan and keeps tierPlanIndex in lockstep.
    if (perTier && !sweepMode) {
      const lowestActionableTier = Math.min(
        ...gated.actionable
          .filter((f) => autoFixable(f) && !seenProposed.has(proposedKey(f)))
          .map(fixTierOf)
          // FIX #1: never demote below the first auto-fixable tier. Tiers < FIRST_TIER are entirely
          // propose-only (surfaced, never staged), so a stray sub-FIRST_TIER candidate must not pull
          // currentTier below the floor the resume clamp + convergence also honor.
          .filter((t) => t >= FIRST_TIER)
      );
      if (Number.isFinite(lowestActionableTier) && lowestActionableTier < currentTier) {
        currentTier = lowestActionableTier;
        tierDryStreak = 0;
        stalledStreak = 0; // re-entering a lower tier IS work — don't carry a stale streak into it
      }
    }

    // Per-tier convergence restricts a pass to the CURRENT tier's actionable set.
    let actionable = perTier ? gated.actionable.filter((f) => fixTierOf(f) === currentTier) : gated.actionable;
    // FIX #1 (surfacing is NOT tier-gated): the tiers BELOW FIRST_TIER are entirely propose-only, so the
    // loop never stages them and they never reach fix() to be rejected+surfaced. Surface those findings as
    // proposals directly, so skipping the un-fixable structural tiers loses NO visibility — a review-sourced
    // architecture_ssot / dependencies_supply_chain (tier 1) finding is still reported (tier-0 logical
    // proposals arrive separately via options.logicalProposals). Deduped by proposedKey; these tiers can
    // never become currentTier (currentTier >= FIRST_TIER, re-entry floored), so this never double-surfaces.
    if (perTier) {
      for (const f of gated.actionable) {
        const t = fixTierOf(f);
        if (t >= FIRST_TIER) continue;
        const p = { ...f, rejectedReason: `structure/logical tier ${t} — propose-only, surfaced (no auto-fixable lens below tier ${FIRST_TIER})` };
        const k = proposedKey(p);
        if (!seenProposed.has(k)) {
          seenProposed.add(k);
          proposedAll.push(p);
        }
      }
    }
    // D (deterministic correlation, opt-in): give ONE writer each SAME-FILE anchor cluster (audit-fix
    // already serializes one writer per file + reverts a multi-file touch; enforceTouched) and ESCALATE
    // cross-cutting / SSOT / propose-only clusters to PROPOSAL instead of auto-fixing a symptom. No LLM.
    // The escalated findings move from `actionable` to proposals; same-file clusters stay actionable.
    // NOTE (FIX #0 / F-G): correlate NO LONGER escalates on an import edge between two files. That broad
    // import-edge × lens-family rule starved the fixer to 0 fixes on interconnected repos. The RESIDUAL
    // risk — a genuinely-coupled cross-file pair whose independent single-file fixes each keep tests green
    // under thin coverage — is now MITIGATED (not eliminated) by the test-red promote-after-N escalation
    // below (F-A), and is fully caught only when the suite (or the coverage gate) exercises the coupling.
    // A documented, bounded trade-off — not equivalence to the removed pre-emptive escalation.
    if (options.correlate) {
      const { escalated } = correlateFindings(actionable, { importers: options.correlateImporters ?? {} });
      if (escalated.length) {
        const escIds = new Set(escalated.flatMap((c) => c.findingIds.map(String)));
        const isEsc = (f, i) => escIds.has(String(f?.id ?? f?.fingerprint ?? `f${i}`));
        // M9 STARVATION FIX: correlate escalates every cross-cutting / SSOT / propose-only finding OUT of
        // `actionable`. That is RIGHT while the only writer is the single-file fixer — it cannot apply a
        // multi-file consolidation, so auto-fixing one member of the cluster patches a symptom. But the M9
        // structure pass IS the multi-file writer, and it draws its inputs ONLY from runAuditFix's
        // `rejected` (audit-fix.mjs:934) — which is only ever populated by findings that REACHED fix().
        // Dropping them here therefore starved M9 to ZERO attempts: --structure-auto-apply was consented,
        // wired and reachable, yet every structural finding died at this filter and the transform never ran
        // once (measured on CubeServHub: 1550/1557 proposals carried this escalation reason, 0 transforms).
        // Two individually-correct features cancelling out — the same class as the FIX #0 import-edge
        // starvation noted above. So: with the operator's structure consent, a structure-class finding STAYS
        // actionable. Nothing is auto-patched by the single-file writer regardless — classifyFixable still
        // rejects it as cross-cutting; it lands in `rejected`, and M9 attempts it under its FULL ladder
        // (plan-declared file boundary, suite green, public API provably unchanged, UNANIMOUS §6 over the
        // exact staged diff), reverting to a proposal on any gate failure. Without the consent, or for a
        // non-structure finding, the escalation is unchanged.
        const m9Handles = (f) => options.structureAutoApply === true && isStructureClass(f);
        for (let i = 0; i < actionable.length; i += 1) {
          const f = actionable[i];
          if (!isEsc(f, i) || m9Handles(f)) continue;
          // F-E: the removed multi-file-dependency escalation is GONE — this reason must not claim it.
          const p = { ...f, rejectedReason: "correlation: cross-cutting / SSOT / propose-only cluster — escalated to proposal (not auto-fixed)" };
          const k = proposedKey(p);
          if (!seenProposed.has(k)) {
            seenProposed.add(k);
            proposedAll.push(p);
          }
        }
        actionable = actionable.filter((f, i) => !isEsc(f, i) || m9Handles(f));
      }
    }
    // F-A: exclude a TEST-RED-PROMOTED finding from staging so its tier can dry-advance instead of being
    // pinned by a coupled finding that keeps failing tests. A finding is excluded ONLY once its
    // deterministic test-red count reaches RED_ESCALATE_THRESHOLD (it was surfaced as a proposal below);
    // a finding with fewer reds (flaky tolerance) STAYS actionable and is retried next pass. Keyed on the
    // red COUNT (not seenProposed) so it excludes exactly the test-red-promoted findings — NOT the
    // propose-only / correlate-escalated / surfaced findings that legitimately reach seenProposed via other
    // channels and must keep being re-offered (e.g. a structure transform refusal is a per-pass verdict).
    actionable = actionable.filter((f) => (seenFailed.get(proposedKey(f)) ?? 0) < RED_ESCALATE_THRESHOLD);
    // WAVE 3 (livelock quarantine): a file the breaker QUARANTINED (repeated fixes that changed content but
    // never resolved the finding) is EXCLUDED from further auto-fix — its still-open findings surface as
    // PROPOSALS (human review of the oscillation) and the fixer never mutates it again (which is what let its
    // cells re-open every pass). This is what lets the tier SETTLE instead of spinning to maxPasses.
    if (sweepMode && sweepFixExcluded.size) {
      const kept = [];
      for (const f of actionable) {
        if (sweepFixExcluded.has(posixKeyPath(f.file ?? f.location?.path))) {
          const p = { ...f, rejectedReason: `livelock: ${posixKeyPath(f.file ?? f.location?.path)} quarantined — repeated fixes did not resolve its findings; surfaced for human review` };
          const k = proposedKey(p);
          if (!seenProposed.has(k)) { seenProposed.add(k); proposedAll.push(p); }
        } else kept.push(f);
      }
      actionable = kept;
    }
    // WAVE 2 (F-B): a REPORT-ONLY tier plan entry (the final-content sweeps [0,1] without
    // --structure-auto-apply) advances on the SAME 100% coverage rule but NEVER calls fix() — its findings
    // surface as proposals. Clear `actionable` so the fixer stays untouched while the tier's cells are
    // still reviewed (covered) for six-eyes completeness.
    if (sweepMode && tierPlan[tierPlanIndex] && tierPlan[tierPlanIndex].fix === false) {
      for (const f of actionable) {
        const p = { ...f, rejectedReason: `report-only sweep (tier ${currentTier}) — surfaced, not auto-fixed` };
        const k = proposedKey(p);
        if (!seenProposed.has(k)) { seenProposed.add(k); proposedAll.push(p); }
      }
      actionable = [];
    }

    // WAVE 2 (C): the isolation-branch HEAD BEFORE this fix batch — diffed against the HEAD after it to get
    // the VERIFIED changed set for manifest invalidation. Captured only when a fix could actually run
    // (actionable non-empty) so a fix-free pass never spawns git; null when git is unavailable (non-git test).
    const sweepBeforeHead = sweepMode && actionable.length ? (sweep.gitHead?.() ?? null) : null;
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
    // F-A + F-D: process the fixer's failures. A `testRed` entry (tagged by audit-fix ONLY for a
    // deterministic test-red, never a timeout) means the single-file fix stayed IN-FILE yet the suite went
    // red — a cross-file-coupling signal. Count reds per finding; on the RED_ESCALATE_THRESHOLD-th red,
    // PROMOTE the finding to a proposal (surfaced, not retried to budget exhaustion). The count keeps
    // climbing every pass even after promotion (idempotent — seenProposed dedups the proposal). F-D: push
    // each (finding-key, reason) to `failedAll` only the FIRST time this run so a recurring red does not
    // flood the report list; failures without a finding (e.g. a generic gate-red) are not deduped.
    for (const entry of fx?.failed ?? []) {
      const fk = entry?.finding ? proposedKey(entry.finding) : null;
      const reportKey = fk ? `${fk} ${entry?.reason ?? ""}` : null;
      if (!reportKey || !seenFailedReports.has(reportKey)) {
        if (reportKey) seenFailedReports.add(reportKey);
        failedAll.push(entry);
      }
      if (entry?.testRed === true && fk) {
        const count = (seenFailed.get(fk) ?? 0) + 1;
        seenFailed.set(fk, count);
        if (count >= RED_ESCALATE_THRESHOLD && !seenProposed.has(fk)) {
          seenProposed.add(fk);
          proposedAll.push({ ...entry.finding, rejectedReason: `test-red after single-file fix on ${count} passes — possible cross-file coupling (surfaced, not auto-retried)` });
        }
      }
    }
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

    // WAVE 2 — FIX-INVALIDATION over a VERIFIED changed set (C+D). After a fix batch, derive the changed
    // paths from a git diff of the isolation-branch HEAD before/after the batch (added/modified/deleted/
    // renamed) — fx.changedFiles records only one file per finding, so a MULTI-FILE structure transform's
    // co-edited files would otherwise keep STALE rows. NORMALIZE every path to posix ONCE and feed the SAME
    // list to BOTH the changedSet AND refreshFiles (the Windows-backslash fix — a raw `lib\a.mjs` missed the
    // posix-keyed chunkCache entry AND wrote backslash rows that never matched a cell). Falls back to
    // fx.changedFiles when git is unavailable. Re-hashing gives free invalidation: the OLD done-rows carry
    // the OLD chunk hashes, so they no longer match the new expectedKeys ⇒ those cells are PENDING again.
    const sweepAfterHead = sweepMode && sweepBeforeHead ? (sweep.gitHead?.() ?? null) : null;
    const verifiedDiff = sweepMode && sweepBeforeHead && sweepAfterHead ? (sweep.gitChangedSince?.(sweepBeforeHead, sweepAfterHead) ?? null) : null;
    let presentChanged = [];
    let deletedChanged = [];
    if (sweepMode) {
      if (verifiedDiff) {
        presentChanged = [...new Set(verifiedDiff.changed.map((f) => posixKeyPath(f)))];
        deletedChanged = [...new Set(verifiedDiff.deleted.map((f) => posixKeyPath(f)))];
      } else {
        // Fallback (no git): fx.changedFiles/freshFixed; classify a deletion by on-disk absence.
        const all = [...new Set(changed.map((f) => posixKeyPath(f)))];
        deletedChanged = all.filter((f) => sweep.fileExists && !sweep.fileExists(f));
        presentChanged = all.filter((f) => !deletedChanged.includes(f));
      }
      // Restrict to the coverage UNIVERSE (the manifest's non-test file set). A co-edited SOURCE file
      // belongs in the denominator (exactly what C fixes), but a touched TEST file or a newly-CREATED file
      // is NOT schedulable by the model-bound window (created-file coverage is a deferred design caveat) —
      // adding it would wedge the tier on a phantom, never-schedulable pending. Deletions likewise matter
      // only for files the manifest actually tracked. (workspaceRoot === the git toplevel, so the diff's
      // repo-relative paths key the same as the model's file ids.)
      const universe = new Set(sweep.allFiles ?? []);
      presentChanged = presentChanged.filter((f) => universe.has(f));
      deletedChanged = deletedChanged.filter((f) => universe.has(f));
    }
    const changedSet = new Set([...presentChanged, ...deletedChanged]);
    if (sweepMode && changedSet.size) {
      // WAVE 3 (livelock): the DETERMINISTIC content fingerprint of each present-changed file BEFORE this
      // batch's re-hash (the OLD manifest's chunk-hash list, captured before sweepManifest is replaced
      // below). Joined with the AFTER fingerprint it forms the (before→after) transition the breaker keys on.
      const fileHashOf = (mf, f) => { const r = (mf?.files ?? []).find((x) => x.file === f); return r ? r.chunks.map((c) => c.h).join("|") : ""; };
      const livelockBefore = new Map(presentChanged.map((f) => [f, fileHashOf(sweepManifest, f)]));
      // Re-hash only the PRESENT (non-deleted) files; a deleted file must not be re-read (it would look
      // unreadable → false debt). D: MERGE the refreshed debt — a still-present file that grew >2 MB or
      // became unreadable is DEBT that BLOCKS completion + persists; a VERIFIED deletion drops out with
      // neither a row nor debt (never a phantom pending, never a silent vanish of live content).
      const refreshed = sweep.refreshFiles(presentChanged); // { files:[fresh eligible], debt:[unreadable/oversize] }
      sweepManifest = sortManifest({
        files: [...sweepManifest.files.filter((r) => !changedSet.has(r.file)), ...refreshed.files],
        debt: [...(sweepManifest.debt ?? []).filter((d) => !changedSet.has(d.file)), ...(refreshed.debt ?? [])]
      });
      sweepManifest.digest = manifestDigest(sweepManifest);
      // Persist for --resume (B): append the fresh eligible rows, the new DEBT rows, and DROP records for
      // verified deletions, then RE-SEAL the new digest so the reconstructed manifest matches on resume.
      // Best-effort audit trail: the done-rows are the coverage SSOT (a torn tail is dropped on resume);
      // only markDone (durability of a DONE claim) hard-stops. The re-seal keeps the LAST seal authoritative.
      for (const row of refreshed.files) { try { sweep.cursor.appendManifest(row); } catch { /* best-effort */ } }
      for (const d of refreshed.debt ?? []) { try { sweep.cursor.appendDebt(d); } catch { /* best-effort */ } }
      for (const f of deletedChanged) { try { sweep.cursor.dropFile(f); } catch { /* best-effort */ } }
      try { sweep.cursor.sealManifest({ digest: sweepManifest.digest, fileCount: sweepManifest.files.length }); } catch { /* best-effort */ }
      // WAVE 3 — (file,tier) LIVELOCK CIRCUIT-BREAKER. A test-GREEN fix that CHANGES a file's content
      // without RESOLVING the finding re-hashes it (above) → its cells re-open → the SAME finding recurs
      // next pass → it is re-fixed → oscillation. Neither F-A's test-red counter (the fix "succeeded") nor
      // seenFixed (dedupes REPORTING only) catches it — only maxPasses/budget bound it, burning the whole
      // budget on one file. Record every fix on a re-hashed file as a transition keyed by (tier, file,
      // beforeHash, afterHash, findingFingerprint) plus a per-(file,tier) cycle + per-fingerprint re-fix
      // count + the file's OPEN-finding count at the first cycle. TRIP when ANY of: (a) an EXACT transition
      // RECURS (a proven A↔B content oscillation); (b) LIVELOCK_MAX_CYCLES cycles while a fixed FINGERPRINT
      // keeps coming back (no net reduction); or (c) [correction C — fp-AGNOSTIC] LIVELOCK_MAX_CYCLES cycles
      // with the file's open-finding count NOT net-decreased — this catches a defect whose fix SHIFTS lines so
      // the SAME defect re-reports under a DRIFTED fingerprint, which (a)/(b) both miss (they need a STABLE
      // fp) and which would otherwise burn to maxPasses. On trip: QUARANTINE the file — the actionable filter
      // surfaces its findings as proposals instead of re-fixing; with the fixer no longer mutating it
      // (correction A) its re-opened cells get REVIEWED to done and are NOT re-hashed, so raw tierPending
      // settles to 0 NATURALLY and the TIER ADVANCES with genuine coverage rather than spinning. Deterministic:
      // content hashes + fingerprints + a counted finding total, no clock. Keyed off fx.fixed (ALL fixes this
      // pass), not freshFixed — a RECURRING fingerprint is deduped out of freshFixed (seenFixed) yet is
      // exactly the oscillation signal.
      const livelockFixedByFile = new Map();
      for (const item of fx?.fixed ?? []) {
        const f = posixKeyPath(item?.file ?? item?.finding?.file ?? "");
        if (!f || !presentChanged.includes(f) || sweepFixExcluded.has(f)) continue;
        if (!livelockFixedByFile.has(f)) livelockFixedByFile.set(f, []);
        livelockFixedByFile.get(f).push(item);
      }
      // The file's OPEN-finding count THIS pass (correction C). The review surfaced these BEFORE this pass's
      // fix, so comparing a later cycle's count to the first cycle's baseline detects "no net reduction" even
      // when the recurring defect DRIFTS its fingerprint (a line-shift → new line/title → new fp).
      const openCountFor = (file) => (findings ?? []).filter((x) => posixKeyPath(x?.file ?? x?.location?.path ?? "") === file).length;
      for (const [f, allItems] of livelockFixedByFile) {
        // D (correction): DEDUPE the batch by fixKey. Two fx.fixed items with the SAME fixKey in ONE pass are
        // a duplicate WITHIN this pass, not a cross-pass recurrence — without this the second would see the
        // first's just-added transition (or double-count fixedFps) and FALSE-TRIP on the first legitimate fix.
        const items = [];
        const batchFixKeys = new Set();
        for (const item of allItems) { const fk = fixKey(item); if (batchFixKeys.has(fk)) continue; batchFixKeys.add(fk); items.push(item); }
        const lkey = JSON.stringify([currentTier, f]);
        const st = livelockState.get(lkey) ?? { cycles: 0, fixedFps: new Map(), firstOpen: null };
        st.cycles += 1;
        const openNow = openCountFor(f);
        if (st.firstOpen == null) st.firstOpen = openNow; // baseline captured at the FIRST cycle
        const before = livelockBefore.get(f) ?? "";
        const after = fileHashOf(sweepManifest, f);
        let trip = false;
        let recurring = false;
        for (const item of items) {
          const fp = fixKey(item);
          const tk = JSON.stringify([currentTier, f, before, after, fp]);
          if (livelockTransitions.has(tk)) trip = true; // (a) the EXACT (before→after,fp) transition RECURRED
          livelockTransitions.add(tk);
          const c = (st.fixedFps.get(fp) ?? 0) + 1;
          st.fixedFps.set(fp, c);
          if (c >= 2) recurring = true; // this SAME finding was "fixed" before and came back → no reduction
        }
        livelockState.set(lkey, st);
        // (b) K cycles with a RECURRING fp, OR (c) fp-AGNOSTIC: K cycles with NO net reduction in the file's
        // open-finding count (openNow ≥ the first-cycle baseline) — catches a drifting-fp oscillation.
        if (!trip && st.cycles >= LIVELOCK_MAX_CYCLES && (recurring || openNow >= st.firstOpen)) trip = true;
        if (trip) {
          sweepFixExcluded.add(f);
          for (const item of items) {
            const finding = item?.finding ?? item;
            const p = { ...finding, file: finding.file ?? f, rejectedReason: `livelock: repeated fix on ${f} did not resolve "${finding.title ?? "finding"}" — surfaced for human review` };
            const k = proposedKey(p);
            if (!seenProposed.has(k)) { seenProposed.add(k); proposedAll.push(p); }
          }
        }
      }
      // F-A / consolidation-first RE-ENTRY: if a fix re-opened cells in an EARLIER FIXABLE tier of the plan,
      // demote to the earliest such tier so it is re-consolidated before the higher tier keeps running.
      // Triggers on RAW tier pending (correction A — a quarantined file's re-opened cells are still REAL
      // pending that must be reviewed, just never re-FIXED) after the fix; fixes can invalidate without
      // producing new findings, in lockstep with tierPlanIndex.
      for (let i = 0; i < tierPlanIndex; i += 1) {
        const entry = tierPlan[i];
        if (!entry.fix) continue;
        const p = tierPendingRaw(entry.tier);
        if (p.count > 0) {
          tierPlanIndex = i;
          currentTier = entry.tier;
          tierDryStreak = 0;
          stalledStreak = 0;
          break;
        }
      }
    }

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
    if (sweepMode) {
      // WAVE 2 — LEDGER-GATED tier-advance. Replaces the passRan heuristic with a PROVABLE gate:
      // tierPending(currentTier) === 0 (under the sealed manifest + current epoch) AND fix-free settle
      // (this pass applied ZERO fixes — any fix invalidates the claim) AND the auto-fixable dry streak ≥
      // dryStop. On advance we WALK THE PLAN (not currentTier+1).
      // F (P2): the per-tier gate does NOT include the MANIFEST-WIDE debt — a single permanently >2 MB /
      // unreadable file would otherwise block EVERY tier forever (no tier could advance → the loop spins
      // empty passes to the ceiling and always ends COVERAGE INCOMPLETE). An unreadable file has NO cells
      // to pend, so it is not a phantom pending; run-level debt is disclosed at TERMINAL instead (it sets
      // coverageIncomplete + names the debt files), so a permanently-incurable-debt repo still CONVERGES
      // over the coverable cells and reports the debt honestly rather than burning the pass ceiling.
      const pend = tierPendingRaw(currentTier);
      const tierPendingCount = pend.count;
      // A livelock-QUARANTINED file's findings are surfaced as PROPOSALS, never auto-fixed, so they are not
      // "new auto-fixable work" and must NOT reset the tier dry streak (correction A/C): otherwise a defect
      // whose fix drifts its fingerprint would keep reading as FRESH every pass, pinning the tier hot forever
      // and preventing the post-quarantine settle. tierAuto already excludes them (the actionable filter);
      // tierFresh must too. Off the quarantine path this is byte-identical (the predicate is never true).
      const tierFresh = freshFindings.filter((f) => fixTierOf(f) === currentTier && autoFixable(f) && !(sweepMode && sweepFixExcluded.has(posixKeyPath(f.file ?? f.location?.path)))).length;
      const tierAuto = actionable.filter(autoFixable).length;
      if (tierAuto > 0 || tierFresh > 0) tierDryStreak = 0;
      else if (passRan) tierDryStreak += 1;
      const fixFreeSettle = freshFixed.length === 0;
      const dryReady = tierDryStreak >= dryStop;
      // ADVANCE only when the tier is PROVABLY complete: pending==0 (every expected cell has a durable
      // done-row) AND fix-free settle AND the auto-fixable dry streak is met. A dry streak reached while
      // cells are still PENDING (maxUnits simply hasn't scheduled them yet) does NOT advance and does NOT
      // flag incompleteness — those cells are OWED and get reviewed in a later pass. coverageIncomplete is
      // DERIVED at TERMINAL only (a budget/pass ceiling with pending remaining, OR any run-level debt).
      if (tierPendingCount === 0 && fixFreeSettle && dryReady) {
        try { sweep.cursor.markTierClean({ tier: currentTier, manifestDigest: sweepManifest.digest }); } catch { /* audit-trail record; best-effort */ }
        tierPlanIndex += 1;
        tierDryStreak = 0;
        stalledStreak = 0; // a tier advance IS progress — never carry a stall into the next plan entry
        if (tierPlanIndex < tierPlan.length) currentTier = tierPlan[tierPlanIndex].tier;
      }
    } else if (perTier) {
      const tierFresh = freshFindings.filter((f) => fixTierOf(f) === currentTier && autoFixable(f)).length;
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
    const cpState = { passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, sweep: sweepCheckpoint(), stopReason: null, done: false };
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

  // WAVE 2 — TERMINAL COVERAGE-INCOMPLETE. If a budget/pass ceiling stopped the sweep BEFORE the tier
  // plan was fully walked, disclose the per-tier pending DEBT (the ledger persists it, so a later run
  // with the same epoch continues the denominator — it does NOT restart at zero). A `failClosedStop`
  // (blocked resume) or the clean "epoch-sweep converged" reason is left as-is.
  // WAVE 2 — coverageIncomplete is DERIVED at terminal (never a sticky restored flag):
  //   - plan NOT fully walked (a budget/pass ceiling): pending cells remain ⇒ INCOMPLETE (disclosed).
  //   - plan FULLY walked: every tier hit pending==0, so incomplete IFF run-level DEBT remains (F) — this
  //     CLEARS a coverageIncomplete restored from an interrupt whose pending the resume has now re-covered.
  if (sweepMode && !failClosedStop) {
    const debtRemains = (sweepManifest?.debt?.length ?? 0) > 0;
    if (tierPlanIndex >= tierPlan.length) {
      coverageIncomplete = debtRemains;
    } else if (stopReason && !/epoch-sweep converged/.test(stopReason)) {
      coverageIncomplete = true;
      stopReason = `${stopReason} — epoch-sweep COVERAGE INCOMPLETE: ${sweepPendingSummary()} (the ledger persists the open debt; --resume with the same epoch continues the denominator)`;
    }
  }
  checkpoint({ passNo, branch, changedFiles, fixed: fixedAll, failed: failedAll, proposed: proposedAll, reviewed: reviewedAll, passes, spent, dryStreak, currentTier, tierDryStreak, stalledStreak, coverageIncomplete, windowPasses: deps.windowState?.get?.() ?? 0, pauseGuard, staleSinceMs, sweep: sweepCheckpoint(), stopReason, done: true });
  const result = { branch, fixed: fixedAll, failed: failedAll, proposed: proposedAll, passes, spent, budget: totalBudget, passesRun: passNo, stopReason, dryStreak, changedFiles: [...new Set(fixedAll.map((f) => f.file))], ...(sweepMode ? { coverageIncomplete } : {}) };
  // `pause` is present ONLY when a NON-autonomous (or autonomous-but-unschedulable) pause actually
  // STOPPED the run — the companion turns it into the resume contract + exit 75. An autonomous wait
  // that resumed in-process and later converged leaves pauseInfo null (a normal terminal result).
  if (pauseInfo) result.pause = pauseInfo;
  return result;
}
