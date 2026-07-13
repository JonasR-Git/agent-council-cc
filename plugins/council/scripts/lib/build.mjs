import fs from "node:fs";
import path from "node:path";

import { detectTestCmd, parsePorcelainZ, toPosix } from "./audit-fix.mjs";
import { patchReviewerReady } from "./audit-patch-reviewer.mjs";
import { requiredPatchSeats } from "./seats.mjs";
import { runCommand, runCommandAsync } from "./process.mjs";
import { ensureStateDir, resolveStateDir, workspaceRoot } from "./state.mjs";

// `council build` — the run ORCHESTRATOR (gate-ladder steps 0 and 12 of
// docs/plan-build-design.md). It MIRRORS runAuditFix's outer discipline without calling it:
//   - preflight refuses to start on ANY miss, before a single model call is spent;
//   - a repo-scoped lock forbids two concurrent runs sharing one working tree;
//   - all work happens on an ISOLATED branch cut from the clean base; the base branch is
//     never touched, never checked out mid-run, and NOTHING is ever auto-merged or pushed;
//   - steps are DEPENDENT: they run in declared order and the run ABORTS on the first
//     failure (never skips ahead), leaving the already-committed steps on the branch for
//     human review;
//   - a final full-suite pass judges the WHOLE branch, then the operator is returned to
//     the base branch.
//
// The per-step gate ladder (revalidate / test-first / RED-before / impl / drift /
// GREEN-after / full suite / §6 council / reviewed-byte binding / rollback — steps 1–11)
// lives in build-step.mjs. This module codes against that runner's CONTRACT:
//
//   runBuildStep({ step, planSpec, snapshot }, stepDeps)
//     -> { ok: boolean,          // true only when the step COMMITTED with every gate green
//          commit?: string,      // the ONE commit the step landed (when ok)
//          reason?: string,      // why the step failed (when !ok)
//          gates: {...},         // per-gate outcomes (passed through for the report)
//          stranded?: boolean,   // its rollback failed — the tree is unrestorable (fatal)
//          modelCalls?: number } // spend accounting (optional — unreported spend is
//                                // charged conservatively against the run budget)
//
// The orchestrator supplies the ports IT owns (git, runFullSuite, readFile/fileExists, now,
// backends, options); the CLI wiring supplies the model-facing ports (authorTests,
// authorImpl, writeFiles, runStepTest, reviewStep) via deps.stepDeps. runBuildStep is
// itself fail-closed on any missing port, so an incompletely wired run aborts on its first
// step instead of soft-skipping a gate. build-step.mjs is imported LAZILY (and only when
// deps.runStep is not injected), so this orchestrator stays loadable + fully unit-testable
// with a fake git and a fake step runner.
//
// Safety v1 (non-negotiable, docs/plan-build-design.md): NO escape hatches. There is no
// --allow-untested, no --skip-council, no dirty-tree mode, no reduced council, and no
// arbitrary shell test command — a missing gate is a refusal, never a downgrade.

// Design bound (Codex D6 + Grok D6): autonomous builds stay small — ≤6–8 ordered steps.
const DEFAULT_MAX_STEPS = 8;
// Whole-run wall clock. Per-step wall/attempt/diff bounds are build-step's job (ladder 1);
// this is the outer stop so a run can never grind unbounded across steps.
const DEFAULT_MAX_WALL_MS = 2 * 60 * 60 * 1000;
// Attempts per step the budget formula assumes (design: ≤2 attempts/step).
const MAX_ATTEMPTS_PER_STEP = 2;

const STEP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Cheap fail-closed SHAPE check on a PlanSpec before anything else runs — enough to refuse
 * an obviously malformed or oversized plan without a branch, a lock, or a test run. The
 * FULL contract validation (unknown keys, path safety, protected paths, create/edit vs the
 * tree, role:test relaxation) is plan-spec.mjs's `validatePlanSpec`, which runBuild ALSO
 * runs itself in preflight (defense-in-depth — a caller that skips the CLI wiring cannot
 * skip path safety); this guard only ensures the orchestrator's own invariants (ordered
 * unique ids, earlier-only deps => acyclic, bounded step count). Returns the first problem
 * as a string, or null when the shape is acceptable. Pure.
 */
export function planShapeReason(planSpec, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  // The D6 autonomous bound is a CEILING, never a default: a caller-supplied maxSteps can
  // only TIGHTEN it. No flag or API option may raise the blast-radius limit (no escape
  // hatches) — a bigger request must be split into multiple plans.
  const cap = Math.min(DEFAULT_MAX_STEPS, Number.isFinite(maxSteps) ? Math.max(1, Math.floor(maxSteps)) : DEFAULT_MAX_STEPS);
  if (!planSpec || typeof planSpec !== "object" || Array.isArray(planSpec)) return "plan is not an object";
  if (planSpec.schemaVersion !== 1) return `unsupported schemaVersion ${JSON.stringify(planSpec.schemaVersion)} (expected 1)`;
  if (typeof planSpec.request !== "string" || !planSpec.request.trim()) return "missing request";
  if (typeof planSpec.requestHash !== "string" || !planSpec.requestHash.trim()) return "missing requestHash";
  if (typeof planSpec.baseCommit !== "string" || !planSpec.baseCommit.trim()) return "missing baseCommit";
  if (!Array.isArray(planSpec.steps) || planSpec.steps.length === 0) return "plan has no steps";
  if (planSpec.steps.length > cap) {
    return `plan has ${planSpec.steps.length} steps — exceeds the ${cap}-step autonomous bound (split the plan)`;
  }
  const seen = new Set();
  for (const [i, step] of planSpec.steps.entries()) {
    if (!step || typeof step !== "object") return `step ${i + 1} is not an object`;
    if (typeof step.id !== "string" || !STEP_ID_RE.test(step.id)) return `step ${i + 1} has an invalid id (want ${String(STEP_ID_RE)})`;
    if (seen.has(step.id)) return `duplicate step id "${step.id}"`;
    if (!Array.isArray(step.files) || step.files.length === 0) return `step "${step.id}" declares no files`;
    if (step.dependsOn != null && !Array.isArray(step.dependsOn)) return `step "${step.id}" has a non-array dependsOn`;
    for (const dep of step.dependsOn ?? []) {
      // Earlier-only references make the declared order a valid topological order and the
      // graph acyclic by construction — the orchestrator can simply run steps in order.
      if (!seen.has(dep)) return `step "${step.id}" depends on ${JSON.stringify(dep)}, which is not an EARLIER step`;
    }
    seen.add(step.id);
  }
  return null;
}

/** Kebab slug of the request for the branch name (bounded; never empty). */
function requestSlug(request) {
  const slug = String(request ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return slug || "plan";
}

// --- git adapter (injectable) ------------------------------------------------

/**
 * The build's git adapter — audit-fix's realGit generalized from ONE target file to a FILE
 * SET, because a build step legitimately touches several declared files (impl + test) and
 * the commit must be bound to exactly that set. Staging is always `git add -- <paths...>`
 * (never add -A) so a commit can only ever contain declared paths, and commitIndex commits
 * the ALREADY-STAGED index so the committed bytes are exactly the ones diffCachedSet
 * showed the §6 council (the reviewed-byte binding, ladder step 10).
 */
export function makeBuildGit(root) {
  const g = (args, opts = {}) => runCommand("git", args, { cwd: root, ...opts });
  const posixSet = (paths) => {
    const list = (Array.isArray(paths) ? paths : []).map(toPosix).filter(Boolean);
    // Fail-closed: an empty set would silently stage/diff NOTHING and let a later
    // commitIndex sweep in whatever happens to be staged.
    if (!list.length) throw new Error("empty path set — a build step must declare at least one file");
    return list;
  };
  return {
    isRepo: () => g(["rev-parse", "--is-inside-work-tree"]).status === 0,
    isClean: () => g(["status", "--porcelain"]).stdout.trim() === "",
    head: () => g(["rev-parse", "HEAD"]).stdout.trim(),
    currentBranch: () => g(["branch", "--show-current"]).stdout.trim(),
    branchExists: (b) => g(["rev-parse", "--verify", "--quiet", b]).status === 0,
    createAndCheckout: (branch, baseRef) => {
      const res = g(["checkout", "-b", branch, baseRef]);
      if (res.status !== 0) throw new Error(`git checkout -b failed: ${res.stderr.trim()}`);
    },
    checkout: (ref) => g(["checkout", ref]).status === 0,
    changedFiles: () => parsePorcelainZ(g(["status", "--porcelain", "-z"]).stdout),
    resetHard: (ref) => {
      const r = g(["reset", "--hard", String(ref)]);
      // clean -fd removes UNTRACKED output (files a step created) but NOT ignored files:
      // `-x` would delete the user's gitignored .env/node_modules on the first rollback
      // (the audit-fix council's P1 data-loss lesson) — reverting tracked state + removing
      // untracked output is the correct safe revert.
      const c = g(["clean", "-fd"]);
      // A failed restore is an emergency: rejected bytes left in the tree could be staged
      // by a LATER step and committed unreviewed. Fail loud so the caller strands the run.
      if (r.status !== 0 || c.status !== 0) {
        throw new Error(`git revert failed (reset ${r.status}, clean ${c.status}) — tree may be dirty; aborting to avoid committing unreviewed changes`);
      }
    },
    // Stage EXACTLY the declared set (never add -A) — the capability boundary of a step.
    stageSet: (paths) => {
      const res = g(["add", "--", ...posixSet(paths)]);
      if (res.status !== 0) throw new Error(`git add failed: ${res.stderr.trim()}`);
    },
    // The STAGED (index) diff of the set vs `ref` — the exact bytes a §6 review judges and
    // the exact bytes commitIndex will land (closes the TOCTOU between review and commit).
    diffCachedSet: (paths, ref) => g(["diff", "--cached", String(ref), "--", ...posixSet(paths)]).stdout,
    // Commit the ALREADY-STAGED index (no re-add): one commit per step, byte-bound.
    commitIndex: (message) => {
      const res = g(["commit", "-m", message, "--no-verify"]);
      if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr.trim()}`);
      return g(["rev-parse", "HEAD"]).stdout.trim();
    }
  };
}

// --- real adapters (injectable) ----------------------------------------------

async function realRunTests(root, testCmd, options) {
  const res = await runCommandAsync(testCmd.cmd, testCmd.args, {
    cwd: root,
    timeoutMs: options.testTimeoutMs ?? 600_000
  });
  return { ok: res.status === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`, timedOut: Boolean(res.timedOut) };
}

// Lazy so build.mjs stays loadable (and this orchestrator fully unit-testable via an
// injected deps.runStep) even in a tree where build-step.mjs has not landed yet.
async function defaultRunStep(step, planSpec, snapshot, stepDeps) {
  const { runBuildStep } = await import("./build-step.mjs");
  return runBuildStep({ step, planSpec, snapshot }, stepDeps);
}

/** resetHard that reports failure instead of throwing (the caller decides: restored vs stranded). */
function tryResetHard(git, ref) {
  try {
    git.resetHard(ref);
    return true;
  } catch {
    return false;
  }
}

// --- the orchestrator ---------------------------------------------------------

/**
 * Run a validated PlanSpec: preflight (ladder step 0) -> ordered steps via runBuildStep
 * (ladder 1–11, injected or lazily imported) -> final integration + return-to-base
 * (ladder step 12). Returns a structured report; the ONLY durable side effects of a
 * successful run are commits on the isolated branch. `deps` lets tests inject
 * { git, testCmd, runTests, seatsReady, runStep, stepDeps, acquireLock, releaseLock, now }
 * so the whole machine runs without a repo, a network, or a model.
 */
export async function runBuild(cwd, planSpec, backends = {}, options = {}, deps = {}) {
  const root = workspaceRoot(cwd);
  const git = deps.git ?? makeBuildGit(root);
  const log = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const now = deps.now ?? (() => Date.now());
  const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(1, Math.floor(options.maxSteps)) : DEFAULT_MAX_STEPS;

  // A preflight refusal spends NOTHING and changes NOTHING: no lock, no branch, no model
  // call. returnedToBase is true in the "never left the base" sense.
  const refuse = (error) => ({
    ok: false,
    error,
    stopReason: "preflight",
    branch: null,
    baseBranch: null,
    baseRef: null,
    plannedSteps: Array.isArray(planSpec?.steps) ? planSpec.steps.length : 0,
    steps: [],
    committed: 0,
    stranded: false,
    returnedToBase: true,
    integration: null,
    integrationFailed: false,
    merged: false
  });

  // --- preflight (ladder step 0): ANY miss refuses the WHOLE run — no partial build ---
  const shape = planShapeReason(planSpec, { maxSteps });
  if (shape) return refuse(`invalid PlanSpec: ${shape} — re-run \`council plan\` (build never repairs a plan)`);
  if (!git.isRepo()) return refuse("not a git repository — build needs git for branch isolation + rollback");
  const baseBranch = git.currentBranch();
  if (!baseBranch || typeof baseBranch !== "string") {
    return refuse("detached HEAD — check out a NAMED base branch first (build must know where to return)");
  }
  if (!git.isClean()) {
    return refuse("working tree not clean — commit or stash your changes first (build has no --allow-dirty; its rollback ops would destroy uncommitted work)");
  }
  const baseRef = git.head();
  // --from binds the plan to the EXACT base it was made against: a drifted HEAD means the
  // plan's create/edit assumptions no longer hold — re-plan, never "adapt".
  if (baseRef !== planSpec.baseCommit) {
    return refuse(`HEAD ${String(baseRef).slice(0, 8)} does not match the plan's baseCommit ${String(planSpec.baseCommit).slice(0, 8)} — the plan was made against a different tree; re-run \`council plan\``);
  }
  const testCmd = deps.testCmd ?? options.testCmd ?? detectTestCmd(root);
  if (!testCmd) return refuse("no test command detected — build REQUIRES a test gate (there is no --allow-untested)");
  // Every required §6 seat (built-ins + configured OpenRouter — the dynamic registry, never
  // a hardcoded triple) must be reachable BEFORE any model spend: a down seat can never
  // reach unanimity, so starting would burn the whole budget only to veto every step.
  const seatsReady = deps.seatsReady ?? (() => patchReviewerReady(backends, options));
  const ready = seatsReady();
  if (!ready || ready.ready !== true) {
    const blocked = Object.entries(ready?.reasons ?? {})
      .map(([seat, why]) => `${seat}: ${why}`)
      .join("; ");
    return refuse(`§6 council incomplete — every required seat must be reachable before any model spend${blocked ? ` (${blocked})` : ""}`);
  }

  // Repo-scoped lock: forbid a second concurrent build (or a build racing an audit fix's
  // rollback ops) sharing this working tree.
  const acquireLock =
    deps.acquireLock ??
    (() => {
      ensureStateDir(cwd);
      const lockPath = path.join(resolveStateDir(cwd), "build.lock");
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return lockPath;
    });
  const releaseLock =
    deps.releaseLock ??
    ((token) => {
      try {
        fs.unlinkSync(token);
      } catch {
        /* ignore */
      }
    });
  let lockToken = null;
  try {
    lockToken = acquireLock() ?? "held";
  } catch {
    return refuse("another `council build` is already running in this repo (lock held) — wait for it to finish or remove a stale build.lock");
  }

  try {
    const runTests = deps.runTests ?? (() => realRunTests(root, testCmd, options));

    // GREEN baseline on the base commit: with a red base, RED-before/GREEN-after and the
    // full-suite gates are unreadable (every step would be judged against noise).
    log("preflight: baseline full suite on the base commit");
    const baseline = await runTests();
    if (!baseline.ok) {
      return refuse(
        baseline.timedOut
          ? "baseline test suite TIMED OUT on the base commit — fix or speed up the suite first (an unreadable baseline disables every gate)"
          : "baseline test suite is RED on the base commit — fix the base first (a red baseline makes RED-before/GREEN-after unreadable)"
      );
    }

    // Isolated branch off the CLEAN base. Always fresh: an existing branch of the same
    // name means a previous run left artifacts a human has not reviewed yet.
    const branch = options.branch ?? `council/build-${requestSlug(planSpec.request)}-${String(baseRef).slice(0, 8)}`;
    if (typeof git.branchExists === "function" && git.branchExists(branch)) {
      return refuse(`branch ${branch} already exists — a build always starts fresh; review/delete it (or pass a different branch name)`);
    }
    try {
      git.createAndCheckout(branch, baseRef);
    } catch (err) {
      return refuse(`could not create the isolated build branch: ${String(err?.message ?? err)}`);
    }

    // --- run budget (whole-run bounds; per-step bounds live in build-step, ladder 1) ---
    // Fail-closed spend accounting: a step result that does not report modelCalls is
    // charged the CONSERVATIVE per-attempt estimate (test author + impl author + one §6
    // vote per required seat), so unreported spend can only ever SHRINK the budget.
    const chargePerAttempt = 2 + requiredPatchSeats(backends, options).length;
    const maxWallClockMs = Number.isFinite(options.maxWallClockMs) ? Math.max(1, options.maxWallClockMs) : DEFAULT_MAX_WALL_MS;
    const maxModelCalls = Number.isFinite(options.maxModelCalls)
      ? Math.max(1, Math.floor(options.maxModelCalls))
      : planSpec.steps.length * MAX_ATTEMPTS_PER_STEP * chargePerAttempt;
    const startMs = now();
    let modelCallsSpent = 0;

    // The ports the orchestrator owns; the CLI layer merges in the model-facing ports
    // (authorTests / authorImpl / writeFiles / runStepTest / reviewStep) via deps.stepDeps.
    const stepDeps = {
      git,
      runFullSuite: runTests,
      readFile: (rel) => {
        try {
          return fs.readFileSync(path.join(root, rel), "utf8");
        } catch {
          return "";
        }
      },
      fileExists: (rel) => fs.existsSync(path.join(root, rel)),
      now,
      backends,
      options,
      ...(deps.stepDeps ?? {})
    };
    const runStep = deps.runStep ?? ((step, i, snapshot) => defaultRunStep(step, planSpec, snapshot, stepDeps));

    const steps = [];
    let stranded = false;
    let stopReason = "completed";

    // Steps are DEPENDENT: declared order, abort on the FIRST failure, never skip ahead.
    for (let i = 0; i < planSpec.steps.length; i += 1) {
      const step = planSpec.steps[i];
      // Budgets are checked BETWEEN steps (a step is never torn mid-flight — its own
      // bounds cap it internally); commits made so far stay on the branch for review.
      if (now() - startMs > maxWallClockMs) {
        stopReason = "budget:wall-clock";
        log(`budget: wall clock exhausted after ${i} step(s) — stopping (commits so far stay on ${branch})`);
        break;
      }
      if (modelCallsSpent >= maxModelCalls) {
        stopReason = "budget:model-calls";
        log(`budget: model-call budget exhausted after ${i} step(s) — stopping (commits so far stay on ${branch})`);
        break;
      }

      // The last-good commit on the branch: the step's own snapshot/rollback lives inside
      // runBuildStep, but the orchestrator VERIFIES the rollback claim against this.
      const snapshot = git.head();
      log(`step ${i + 1}/${planSpec.steps.length}: ${step.id} — ${step.title ?? ""}`);
      let res;
      try {
        res = await runStep(step, i, snapshot);
      } catch (err) {
        // A THROWING runner left the tree in an unknown state — treated exactly like a
        // failed step below (rollback-claim verification restores or strands).
        res = { ok: false, reason: `step runner error: ${String(err?.message ?? err)}` };
      }
      if (!res || typeof res !== "object") res = { ok: false, reason: "step runner returned no result (fail-closed)" };
      modelCallsSpent += Number.isFinite(res.modelCalls) ? Math.max(0, res.modelCalls) : chargePerAttempt;

      const record = {
        id: step.id,
        title: step.title ?? "",
        ok: res.ok === true,
        commit: res.ok === true ? (res.commit ?? null) : null,
        reason: res.ok === true ? null : String(res.reason ?? "step failed (no reason reported)"),
        stranded: res.stranded === true
      };

      // The step says its rollback FAILED: the tree is unrestorable. Do not touch anything
      // else (a further reset could destroy the evidence) — stop and report stranded.
      if (res.stranded === true) {
        steps.push(record);
        stranded = true;
        stopReason = `stranded:${step.id}`;
        log(`  STRANDED — ${record.reason ?? "rollback failed"}; manual cleanup required`);
        break;
      }

      if (res.ok === true) {
        // Trust but VERIFY the step contract: after a committed step the tree must be
        // clean. Leftovers are UNDECLARED artifacts the gates never saw — scrub them down
        // to the step's own (fully gated) commit, then abort fail-closed.
        if (typeof git.isClean === "function" && !git.isClean()) {
          const scrubbed = tryResetHard(git, git.head()) && git.isClean();
          steps.push(record);
          if (!scrubbed) {
            record.note = "step left a dirty tree after its commit — scrub FAILED";
            record.stranded = true;
            stranded = true;
            stopReason = `stranded:${step.id}`;
            log("  step left a dirty tree after its commit and the scrub failed — STRANDED");
          } else {
            record.note = "step left a dirty tree after its commit — scrubbed to the commit";
            stopReason = `post-step-dirty:${step.id}`;
            log("  step left undeclared leftovers after its commit — scrubbed, aborting (fail-closed)");
          }
          break;
        }
        steps.push(record);
        log(`  committed ${String(record.commit ?? "").slice(0, 8)}`);
        continue;
      }

      // FAILED step: verify its rollback claim — the tree must be back at the last-good
      // commit and clean. If not, restore it here; if THAT fails, the run is stranded.
      const claimHolds = git.head() === snapshot && (typeof git.isClean !== "function" || git.isClean());
      if (!claimHolds) {
        const restored = tryResetHard(git, snapshot) && (typeof git.isClean !== "function" || git.isClean()) && git.head() === snapshot;
        if (!restored) {
          record.stranded = true;
          steps.push(record);
          stranded = true;
          stopReason = `stranded:${step.id}`;
          log(`  STRANDED — step failed AND its rollback left the tree unrestorable`);
          break;
        }
        record.note = "step rollback was incomplete — orchestrator restored the snapshot";
      }
      steps.push(record);
      stopReason = `step-failed:${step.id}`;
      log(`  step failed (${record.reason}) — aborting the run (steps are dependent); prior commits stay on ${branch}`);
      break;
    }

    // --- final integration (ladder step 12): full suite on the WHOLE branch ---
    // Runs whenever commits exist (also on an aborted run — the human reviewing the
    // partial branch deserves to know whether it is green). Per-step gates already ran
    // the suite per commit; this pass guards the composed result end-to-end.
    const committed = steps.filter((s) => s.ok && s.commit).length;
    let integration = null;
    if (!stranded && committed > 0) {
      log("final integration: full suite on the whole branch");
      integration = await runTests();
      if (!integration.ok && stopReason === "completed") stopReason = "integration-red";
    }

    // Return the operator to the base branch. The base was never touched: every commit
    // lives on the isolated branch, which is KEPT for human review — never merged, never
    // pushed. A stranded/dirty tree is left in place (a checkout could destroy evidence).
    let returnedToBase = false;
    if (!stranded && (typeof git.isClean !== "function" || git.isClean())) {
      returnedToBase = Boolean(git.checkout(baseBranch));
    }

    return {
      ok: stopReason === "completed",
      branch,
      baseBranch,
      baseRef,
      plannedSteps: planSpec.steps.length,
      steps,
      committed,
      stranded,
      returnedToBase,
      stopReason,
      integration: integration ? { ok: integration.ok === true, timedOut: Boolean(integration.timedOut) } : null,
      integrationFailed: integration ? integration.ok !== true : false,
      budget: { modelCallsSpent, maxModelCalls, wallClockMs: now() - startMs, maxWallClockMs },
      merged: false
    };
  } finally {
    if (lockToken != null) releaseLock(lockToken);
  }
}

// --- report -------------------------------------------------------------------

/** Human-readable summary of a runBuild result (plain text; safe for logs and terminals). */
export function renderBuildReport(out) {
  if (!out || typeof out !== "object") return "council build: no result";
  const lines = ["## council build"];
  if (out.stopReason === "preflight") {
    lines.push(`REFUSED at preflight (nothing spent, nothing changed): ${out.error}`);
    return lines.join("\n");
  }
  lines.push(`branch ${out.branch} (off ${out.baseBranch} @ ${String(out.baseRef).slice(0, 8)}) — kept for human review, NEVER auto-merged`);
  lines.push(`steps: ${out.committed}/${out.plannedSteps} committed`);
  for (const [i, s] of (out.steps ?? []).entries()) {
    const status = s.ok ? `committed ${String(s.commit ?? "").slice(0, 8)}` : `FAILED: ${s.reason}`;
    lines.push(`  ${i + 1}. ${s.id} — ${status}${s.stranded ? " [STRANDED]" : ""}${s.note ? ` (${s.note})` : ""}`);
  }
  const unreached = (out.plannedSteps ?? 0) - (out.steps?.length ?? 0);
  if (unreached > 0) lines.push(`  (+${unreached} step(s) not reached — steps are dependent; the run aborts on the first failure)`);
  if (out.integration) lines.push(`final suite: ${out.integration.ok ? "green" : "RED — do not merge; inspect the branch"}`);
  else lines.push("final suite: not run (no commits, or the tree is stranded)");
  lines.push(`stop: ${out.stopReason}${out.ok ? "" : " (build NOT complete)"}`);
  if (out.stranded) lines.push(`STRANDED: the working tree could not be restored — manual cleanup required on ${out.branch}`);
  lines.push(out.returnedToBase ? `returned to ${out.baseBranch}` : `NOT returned to ${out.baseBranch ?? "base"} — check your current branch and tree`);
  return lines.join("\n");
}
