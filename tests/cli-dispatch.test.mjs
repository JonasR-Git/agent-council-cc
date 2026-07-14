import test from "node:test";
import assert from "node:assert/strict";

import { route, resolveDispatch, STATUS_ACTIONS, REVIEW_AUDIT_MODES } from "../plugins/council/scripts/lib/cli-dispatch.mjs";
import { assertCodeWriteAllowed } from "../plugins/council/scripts/lib/cli-mutation.mjs";
import { resolveReviewMode, handleAudit, handleBuild } from "../plugins/council/scripts/council-companion.mjs";

// The ONLY code paths that reach a tracked-source writer:
//   runAuditFix  ⇐ handleAudit with args[0] === "fix"  (the `fix` verb / old `audit fix`)
//   runBuild     ⇐ handleBuild                          (the `build` verb, non --dry-run)
// So "review/plan/solve never write" is provable structurally: no read-only route may produce either.
function reachesCodeWriter(r) {
  if (r.handler === "handleAudit" && Array.isArray(r.args) && r.args[0] === "fix") return true;
  if (r.handler === "handleBuild") return true;
  return false;
}

test("route: the 7 canonical verbs reach their existing handlers with the right mutationClass", () => {
  assert.match(route(["review"]).handler, /^handleReview$/);
  assert.equal(route(["review"]).mutationClass, "none");
  assert.equal(route(["plan"]).handler, "handlePlan");
  assert.equal(route(["plan"]).mutationClass, "none");
  assert.equal(route(["solve"]).handler, "handleReview");
  assert.equal(route(["solve"]).reviewSolve, true);
  assert.equal(route(["solve"]).mutationClass, "none");
  assert.equal(route(["fix"]).handler, "handleAudit");
  assert.equal(route(["fix"]).auditSub, "fix");
  assert.equal(route(["fix"]).mutationClass, "working-tree");
  assert.equal(route(["build"]).handler, "handleBuild");
  assert.equal(route(["build"]).mutationClass, "working-tree");
  assert.equal(route(["status"]).handler, "handleStatus");
  assert.equal(route(["status"]).mutationClass, "state-only");
  assert.equal(route(["setup"]).handler, "handleSetup");
  assert.equal(route(["setup"]).mutationClass, "state-only");
});

test("route: review --mode branches to the CORRECT DISTINCT audit engines (deep≠run)", () => {
  // deep → handleAudit "review" (grouped hotspot review engine)
  const deep = route(["audit", "review", "--groups", "lens"]);
  assert.equal(deep.handler, "handleAudit");
  assert.equal(deep.auditSub, "review");
  assert.deepEqual(deep.args, ["review", "--groups", "lens"]);
  assert.equal(deep.verb, "review");
  assert.equal(deep.mutationClass, "none");
  // run → handleAudit "run" (risk-register + gate engine) — a DIFFERENT positional/engine than deep
  const run = route(["audit", "run", "--sarif"]);
  assert.equal(run.handler, "handleAudit");
  assert.equal(run.auditSub, "run");
  assert.deepEqual(run.args, ["run", "--sarif"]);
  // endless → handleAudit "endless" (propose-only loop)
  const endless = route(["audit", "endless", "--supervise"]);
  assert.equal(endless.auditSub, "endless");
  assert.deepEqual(endless.args, ["endless", "--supervise"]);
  // the three engines are distinct positionals — never collapsed into one
  assert.equal(REVIEW_AUDIT_MODES.deep, "review");
  assert.equal(REVIEW_AUDIT_MODES.run, "run");
  assert.equal(REVIEW_AUDIT_MODES.endless, "endless");
  assert.notEqual(deep.args[0], run.args[0]);
});

test("route: the deliberate/adversarial aliases thread the alias param (conflict semantics preserved)", () => {
  const del = route(["deliberate"]);
  assert.equal(del.handler, "handleReview");
  assert.equal(del.reviewDeliberate, true);
  assert.equal(del.reviewAdversarial, false);
  const adv = route(["adversarial"]);
  assert.equal(adv.handler, "handleReview");
  assert.equal(adv.reviewAdversarial, true);
  // a disagreeing --mode after a deliberate alias still routes deliberate as the alias param, so
  // resolveReviewMode (below) raises the SAME "Conflicting review mode" the old `deliberate` verb did
  const conflict = route(["deliberate", "--mode", "adversarial"]);
  assert.equal(conflict.handler, "handleReview");
  assert.equal(conflict.reviewDeliberate, true);
  assert.throws(
    () => resolveReviewMode({ adversarial: conflict.reviewAdversarial, deliberate: conflict.reviewDeliberate, modeOption: "adversarial" }),
    /Conflicting review mode/
  );
});

test("route: every status action flag selects its existing handler; the default is handleStatus", () => {
  assert.equal(route(["watch"]).handler, "handleWatch");
  assert.equal(route(["wait"]).handler, "handleWait");
  assert.equal(route(["result"]).handler, "handleResult");
  assert.equal(route(["cancel"]).handler, "handleCancel");
  assert.equal(route(["fixloop-status"]).handler, "handleFixloopStatus");
  assert.equal(route(["overview"]).handler, "handleOverview");
  assert.equal(route(["history"]).handler, "handleHistory");
  assert.equal(route(["metrics"]).handler, "handleMetrics");
  assert.equal(route(["usage"]).handler, "handleUsage");
  assert.equal(route(["ledger"]).handler, "handleLedger");
  assert.equal(route(["status"]).handler, "handleStatus");
  // the action flag is CONSUMED (stripped) before the handler sees it
  assert.deepEqual(route(["watch", "job1", "--once"]).args, ["job1", "--once"]);
  assert.deepEqual(route(["wait", "job9", "--timeout", "3"]).args, ["job9", "--timeout", "3"]);
});

test("route: two status actions at once are rejected with a clear error", () => {
  const r = resolveDispatch(["status", "--watch", "--result"]);
  assert.equal(r.handler, "error");
  assert.match(r.error, /one action at a time/);
});

test("route: setup branches — default handleSetup, --check → doctor, --usage → usage", () => {
  assert.equal(route(["setup"]).handler, "handleSetup");
  assert.equal(route(["doctor"]).handler, "handleDoctor"); // doctor → setup --check → handleDoctor
  assert.equal(route(["doctor"]).verb, "setup");
  assert.equal(resolveDispatch(["setup", "--check"]).handler, "handleDoctor");
  assert.equal(resolveDispatch(["setup", "--usage"]).handler, "handleUsage");
  const both = resolveDispatch(["setup", "--check", "--usage"]);
  assert.equal(both.handler, "error");
});

test("route: hidden verbs pass through to their existing handlers", () => {
  assert.equal(route(["worker", "--job-id", "x"]).handler, "handleWorker");
  assert.equal(route(["worktree", "list"]).handler, "handleWorktree");
  assert.equal(route(["benchmark", "--stats"]).handler, "handleBenchmark");
});

// ---- the safety proof: a code writer is NEVER reached from a read-only intent -----------------------

// Every historical READ-ONLY invocation (review family + plan + solve + status + setup), incl. the deep
// audit review/run/endless engines. NONE of these may resolve to runAuditFix or runBuild.
const READ_ONLY_INVOCATIONS = [
  ["review"], ["review", "--mode", "quick", "focus text"],
  ["deliberate"], ["deliberation"], ["adversarial"], ["adversarial-review"],
  ["audit", "review"], ["audit", "review", "--groups", "lens"],
  ["audit", "run"], ["audit", "run", "--sarif"],
  ["audit", "endless"], ["audit", "endless", "--supervise", "--max-passes", "3"],
  ["solve"], ["solve", "--problem-file", "p.md"],
  ["plan"], ["plan", "add a feature"],
  ["status"], ["watch"], ["wait"], ["result"], ["cancel", "j1"], ["fixloop-status"],
  ["overview"], ["history"], ["metrics"], ["usage"], ["ledger"],
  ["setup"], ["doctor"], ["setup", "--usage"]
];

test("SAFETY: no read-only invocation reaches a code writer (runAuditFix/runBuild) — zero calls", () => {
  for (const argv of READ_ONLY_INVOCATIONS) {
    const r = route(argv);
    assert.equal(reachesCodeWriter(r), false, `read-only ${JSON.stringify(argv)} reached a code writer via ${r.handler} ${JSON.stringify(r.args)}`);
    assert.notEqual(r.mutationClass, "working-tree", `read-only ${JSON.stringify(argv)} carried working-tree mutationClass`);
    // structural guard: the resolved verb is refused entry to any code writer
    assert.throws(() => assertCodeWriteAllowed(r.verb), /mutationClass violation/, `assertCodeWriteAllowed unexpectedly allowed ${JSON.stringify(argv)}`);
  }
});

test("SAFETY: ONLY fix/build (audit fix) reach a code writer, and the guard admits them", () => {
  for (const argv of [["fix"], ["fix", "--loop", "--deep"], ["audit", "fix"], ["audit", "fix", "--loop"], ["build"], ["build", "--from", "plan.json"]]) {
    const r = route(argv);
    assert.equal(reachesCodeWriter(r), true, `writer ${JSON.stringify(argv)} did NOT reach the writer path`);
    assert.equal(r.mutationClass, "working-tree");
    assert.doesNotThrow(() => assertCodeWriteAllowed(r.verb));
  }
});

// ---- byte-identical routing pins (matching the pre-Stage-3 dispatch) --------------------------------

test("BYTE-IDENTICAL: representative old invocations reach the same handler + effective mode as before", () => {
  // old `audit fix` → handleAudit(["fix"])  (positionals[0]==="fix" → the fix engine)
  const fix = route(["audit", "fix"]);
  assert.equal(fix.handler, "handleAudit");
  assert.deepEqual(fix.args, ["fix"]);
  assert.equal(fix.verb, "fix");
  // old `audit review` → handleAudit(["review"])  (the deep hotspot review engine)
  const rev = route(["audit", "review"]);
  assert.equal(rev.handler, "handleAudit");
  assert.deepEqual(rev.args, ["review"]);
  // old `watch` → handleWatch([])
  const watch = route(["watch"]);
  assert.equal(watch.handler, "handleWatch");
  assert.deepEqual(watch.args, []);
  // old `deliberate` → handleReview with the deliberate alias param. Byte-identical RESOLUTION proof:
  // the retained `--mode deliberate` + the alias param resolve to the exact same mode the old
  // param-only dispatch (handleReview(rest, false, true)) produced.
  const del = route(["deliberate"]);
  assert.equal(del.handler, "handleReview");
  assert.deepEqual(
    resolveReviewMode({ adversarial: false, deliberate: true, modeOption: "deliberate" }),
    resolveReviewMode({ adversarial: false, deliberate: true, modeOption: undefined })
  );
});

test("route: every STATUS_ACTIONS target is a distinct existing handler name", () => {
  const handlers = Object.values(STATUS_ACTIONS);
  assert.equal(new Set(handlers).size, handlers.length, "status action → handler map has a duplicate");
});

// ---- A: flag BEFORE the audit subcommand still folds to the right engine (no false write-throw) ------

test("A: `audit <flag…> fix/review/run` folds to the engine (subcommand = first non-option token)", () => {
  const jsonFix = route(["audit", "--json", "fix"]);
  assert.equal(jsonFix.handler, "handleAudit");
  assert.equal(jsonFix.verb, "fix");
  assert.deepEqual(jsonFix.args, ["fix", "--json"]);
  const fromFix = route(["audit", "--from", "r.json", "fix"]);
  assert.equal(fromFix.verb, "fix");
  assert.deepEqual(fromFix.args, ["fix", "--from", "r.json"]);
  const loopFix = route(["audit", "--loop", "fix"]);
  assert.equal(loopFix.verb, "fix");
  assert.deepEqual(loopFix.args, ["fix", "--loop"]);
  // flag-first review/run still route to the distinct engines
  assert.equal(route(["audit", "--json", "review"]).auditSub, "review");
  assert.equal(route(["audit", "--json", "run"]).auditSub, "run");
  // bare `audit` / `audit <unknown>` stay read-only (verb review) — must NOT throw an "unknown verb"
  assert.equal(route(["audit"]).verb, "review");
  assert.equal(route(["audit", "bogus"]).verb, "review");
});

test("A/C: historical `audit -- fix` (subcommand after the terminator) still resolves to the fix engine", () => {
  const r = route(["audit", "--", "fix"]);
  assert.equal(r.handler, "handleAudit");
  assert.equal(r.verb, "fix"); // the guard ADMITS it — byte-identical to the historical fix run
  assert.equal(r.mutationClass, "working-tree");
});

// ---- C: the `--` option terminator protects positional data from alias interpretation ----------------

test("C: `status -- --cancel job1` does NOT reach handleCancel (default handleStatus, verbatim suffix)", () => {
  const r = route(["status", "--", "--cancel", "job1"]);
  assert.equal(r.handler, "handleStatus");
  assert.notEqual(r.handler, "handleCancel");
  assert.deepEqual(r.args, ["--", "--cancel", "job1"]);
});

test("C: `review -- --mode deep` keeps the focus text and does NOT switch to the deep engine", () => {
  const r = route(["review", "--", "--mode", "deep"]);
  assert.equal(r.handler, "handleReview"); // not handleAudit
  assert.deepEqual(r.args, ["--", "--mode", "deep"]);
});

// ---- D: repeated --mode routes by the EFFECTIVE (last) mode, matching parseArgs -----------------------

test("D: two EXPLICIT --mode resolve last-wins (no fake conflict, correct engine)", () => {
  // last mode is quick → the plain review engine, NOT the deep audit engine
  const deepThenQuick = route(["review", "--mode", "deep", "--mode", "quick"]);
  assert.equal(deepThenQuick.handler, "handleReview");
  // last mode is deep → the deep audit engine
  const quickThenDeep = route(["review", "--mode", "quick", "--mode", "deep"]);
  assert.equal(quickThenDeep.handler, "handleAudit");
  assert.equal(quickThenDeep.auditSub, "review");
  // two explicit review modes: last-wins, NO alias param (so no conflict is forced)
  const twoExplicit = route(["review", "--mode", "deliberate", "--mode", "adversarial"]);
  assert.equal(twoExplicit.handler, "handleReview");
  assert.equal(twoExplicit.reviewDeliberate, false);
  assert.equal(twoExplicit.reviewAdversarial, false);
  assert.doesNotThrow(() => resolveReviewMode({ adversarial: false, deliberate: false, modeOption: "adversarial" }));
});

test("D: an alias-INJECTED mode still triggers the deliberate-vs-adversarial conflict", () => {
  const injected = route(["deliberate", "--mode", "adversarial"]);
  assert.equal(injected.reviewDeliberate, true); // param comes from the alias, not last-wins
  assert.throws(
    () => resolveReviewMode({ adversarial: injected.reviewAdversarial, deliberate: injected.reviewDeliberate, modeOption: "adversarial" }),
    /Conflicting review mode/
  );
});

// ---- E/F: the mutation guard is FAIL-CLOSED and sits UPSTREAM of the real writers --------------------

test("F: forging a read-only verb into the handleAudit-fix ENTRANCE THROWS before runAuditFix", async () => {
  // The guard is the first statement once positionals[0]==="fix" — upstream of loadPolicy/probeBackends/
  // runAuditFix. A mutationClass rejection proves the writer was never reached (zero calls).
  for (const verb of ["review", "plan", "solve"]) {
    await assert.rejects(handleAudit(["fix"], { verb }), /mutationClass violation/, `${verb} must be refused at the fix entrance`);
  }
  // E: fail-closed — a missing/undefined verb also THROWS (no `?? "fix"` default admits a write)
  await assert.rejects(handleAudit(["fix"]), /mutationClass violation/);
  await assert.rejects(handleAudit(["fix"], {}), /mutationClass violation/);
});

test("F: forging a read-only verb into the handleBuild ENTRANCE THROWS before runBuild", async () => {
  // The guard is the FIRST statement of handleBuild — upstream of the PlanSpec read, the --dry-run
  // preview, and runBuild. So no build path (not even dry-run) is reachable from a non-writing verb.
  for (const verb of ["review", "plan", "solve"]) {
    await assert.rejects(handleBuild(["--from", "plan.json"], { verb }), /mutationClass violation/, `${verb} must be refused at the build entrance`);
  }
  // E: fail-closed on a missing/undefined verb
  await assert.rejects(handleBuild(["--from", "plan.json"]), /mutationClass violation/);
  await assert.rejects(handleBuild(["--from", "plan.json"], {}), /mutationClass violation/);
});
