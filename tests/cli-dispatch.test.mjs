import test from "node:test";
import assert from "node:assert/strict";

import { route, resolveDispatch, STATUS_ACTIONS, REVIEW_AUDIT_MODES } from "../plugins/council/scripts/lib/cli-dispatch.mjs";
import { assertCodeWriteAllowed } from "../plugins/council/scripts/lib/cli-mutation.mjs";
import { resolveReviewMode, handleAudit, handleBuild } from "../plugins/council/scripts/council-companion.mjs";

// The ONLY code paths that reach a tracked-source writer:
//   runAuditFix  ⇐ handleAudit with args[0] === "fix"  (the `fix` verb)
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

test("route: review --mode branches to the CORRECT DISTINCT audit engines (deep≠run≠endless)", () => {
  // deep → handleAudit "review" (grouped hotspot review engine)
  const deep = route(["review", "--mode", "deep", "--groups", "lens"]);
  assert.equal(deep.handler, "handleAudit");
  assert.equal(deep.auditSub, "review");
  assert.deepEqual(deep.args, ["review", "--groups", "lens"]);
  assert.equal(deep.verb, "review");
  assert.equal(deep.mutationClass, "none");
  // run → handleAudit "run" (risk-register + gate engine) — a DIFFERENT positional/engine than deep
  const run = route(["review", "--mode", "run", "--sarif"]);
  assert.equal(run.handler, "handleAudit");
  assert.equal(run.auditSub, "run");
  assert.deepEqual(run.args, ["run", "--sarif"]);
  // endless → handleAudit "endless" (propose-only loop)
  const endless = route(["review", "--mode", "endless", "--supervise"]);
  assert.equal(endless.auditSub, "endless");
  assert.deepEqual(endless.args, ["endless", "--supervise"]);
  // the three engines are distinct positionals — never collapsed into one
  assert.equal(REVIEW_AUDIT_MODES.deep, "review");
  assert.equal(REVIEW_AUDIT_MODES.run, "run");
  assert.equal(REVIEW_AUDIT_MODES.endless, "endless");
  assert.notEqual(deep.args[0], run.args[0]);
});

test("route: review --mode deliberate|adversarial stays on handleReview (mode carried in args, no alias param)", () => {
  const del = route(["review", "--mode", "deliberate"]);
  assert.equal(del.handler, "handleReview");
  assert.equal(del.reviewDeliberate, false, "the bare review verb encodes NO alias param — the mode lives in --mode");
  assert.equal(del.reviewAdversarial, false);
  assert.deepEqual(del.args, ["--mode", "deliberate"]);
  // handleReview then derives the mode from the retained --mode
  assert.equal(resolveReviewMode({ modeOption: "deliberate" }).mode, "deliberate");
  const adv = route(["review", "--mode", "adversarial"]);
  assert.equal(adv.handler, "handleReview");
  assert.equal(resolveReviewMode({ modeOption: "adversarial" }).mode, "adversarial");
});

test("route: every status action flag selects its existing handler; the default is handleStatus", () => {
  assert.equal(route(["status", "--watch"]).handler, "handleWatch");
  assert.equal(route(["status", "--wait"]).handler, "handleWait");
  assert.equal(route(["status", "--result"]).handler, "handleResult");
  assert.equal(route(["status", "--cancel"]).handler, "handleCancel");
  assert.equal(route(["status", "--fixloop"]).handler, "handleFixloopStatus");
  assert.equal(route(["status", "--overview"]).handler, "handleOverview");
  assert.equal(route(["status", "--history"]).handler, "handleHistory");
  assert.equal(route(["status", "--metrics"]).handler, "handleMetrics");
  assert.equal(route(["status", "--usage"]).handler, "handleUsage");
  assert.equal(route(["status", "--ledger"]).handler, "handleLedger");
  assert.equal(route(["status"]).handler, "handleStatus");
  // the action flag is CONSUMED (stripped) before the handler sees it
  assert.deepEqual(route(["status", "--watch", "job1", "--once"]).args, ["job1", "--once"]);
  assert.deepEqual(route(["status", "--wait", "job9", "--timeout", "3"]).args, ["job9", "--timeout", "3"]);
});

test("route: two status actions at once are rejected with a clear error", () => {
  const r = resolveDispatch(["status", "--watch", "--result"]);
  assert.equal(r.handler, "error");
  assert.match(r.error, /one action at a time/);
});

test("route: setup branches — default handleSetup, --check → doctor, --usage → usage", () => {
  assert.equal(route(["setup"]).handler, "handleSetup");
  assert.equal(resolveDispatch(["setup", "--check"]).handler, "handleDoctor");
  assert.equal(resolveDispatch(["setup", "--check"]).verb, "setup");
  assert.equal(resolveDispatch(["setup", "--usage"]).handler, "handleUsage");
  const both = resolveDispatch(["setup", "--check", "--usage"]);
  assert.equal(both.handler, "error");
});

test("route: hidden verbs pass through to their existing handlers", () => {
  assert.equal(route(["worker", "--job-id", "x"]).handler, "handleWorker");
  assert.equal(route(["worktree", "list"]).handler, "handleWorktree");
  assert.equal(route(["benchmark", "--stats"]).handler, "handleBenchmark");
});

// ---- the removal: every OLD command name is a CLEAN unknown-command error --------------------------

const REJECTED_OLD_NAMES = [
  "deliberate", "deliberation", "adversarial", "adversarial-review", "audit", "endless",
  "watch", "wait", "result", "cancel", "doctor", "usage", "ledger", "history", "metrics",
  "fixloop-status", "overview"
];

test("route: every old command name resolves to the clean unknown-command error (never a handler, never a writer)", () => {
  for (const name of REJECTED_OLD_NAMES) {
    const r = route([name]);
    assert.equal(r.handler, "error", `"${name}" must be rejected`);
    assert.equal(reachesCodeWriter(r), false, `"${name}" must not reach a writer`);
    assert.match(r.error, /^unknown command '.+'\. Verbs: review fix plan build solve status setup\. Run --help\.$/);
    assert.ok(r.error.includes(`'${name}'`));
  }
  // `audit fix` — the historical WRITE fold — is now unknown too (no working-tree leak)
  const auditFix = route(["audit", "fix", "--from", "r.json"]);
  assert.equal(auditFix.handler, "error");
  assert.notEqual(auditFix.mutationClass, "working-tree");
});

// ---- the safety proof: a code writer is NEVER reached from a read-only intent -----------------------

// Every CANONICAL READ-ONLY invocation (review family + plan + solve + status + setup), incl. the deep
// audit review/run/endless engines. NONE of these may resolve to runAuditFix or runBuild.
const READ_ONLY_INVOCATIONS = [
  ["review"], ["review", "--mode", "quick", "focus text"],
  ["review", "--mode", "deliberate"], ["review", "--mode", "adversarial"],
  ["review", "--mode", "deep"], ["review", "--mode", "deep", "--groups", "lens"],
  ["review", "--mode", "run"], ["review", "--mode", "run", "--sarif"],
  ["review", "--mode", "endless"], ["review", "--mode", "endless", "--supervise", "--max-passes", "3"],
  ["solve"], ["solve", "--problem-file", "p.md"],
  ["plan"], ["plan", "add a feature"],
  ["status"], ["status", "--watch"], ["status", "--wait"], ["status", "--result"],
  ["status", "--cancel", "j1"], ["status", "--fixloop"], ["status", "--overview"],
  ["status", "--history"], ["status", "--metrics"], ["status", "--usage"], ["status", "--ledger"],
  ["setup"], ["setup", "--check"], ["setup", "--usage"]
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

test("SAFETY: ONLY fix/build reach a code writer, and the guard admits them", () => {
  for (const argv of [["fix"], ["fix", "--loop", "--deep"], ["build"], ["build", "--from", "plan.json"]]) {
    const r = route(argv);
    assert.equal(reachesCodeWriter(r), true, `writer ${JSON.stringify(argv)} did NOT reach the writer path`);
    assert.equal(r.mutationClass, "working-tree");
    assert.doesNotThrow(() => assertCodeWriteAllowed(r.verb));
  }
});

// ---- routing pins -----------------------------------------------------------------------------------

test("route: `fix` reaches the audit fix engine positional (handleAudit ['fix', …])", () => {
  const fix = route(["fix"]);
  assert.equal(fix.handler, "handleAudit");
  assert.deepEqual(fix.args, ["fix"]);
  assert.equal(fix.verb, "fix");
  const loopFix = route(["fix", "--loop", "--deep"]);
  assert.deepEqual(loopFix.args, ["fix", "--loop", "--deep"]);
  assert.equal(loopFix.verb, "fix");
});

test("route: `review --mode deep` reaches the deep hotspot review engine positional (handleAudit ['review'])", () => {
  const rev = route(["review", "--mode", "deep"]);
  assert.equal(rev.handler, "handleAudit");
  assert.deepEqual(rev.args, ["review"]);
  // old `deliberate` resolution — the retained `--mode deliberate` resolves the same mode as the verb
  // alias once did (byte-identical RESOLUTION), now reached only via the canonical --mode.
  assert.deepEqual(
    resolveReviewMode({ modeOption: "deliberate" }),
    { mode: "deliberate", adversarial: false, deliberate: true }
  );
});

test("route: every STATUS_ACTIONS target is a distinct existing handler name", () => {
  const handlers = Object.values(STATUS_ACTIONS);
  assert.equal(new Set(handlers).size, handlers.length, "status action → handler map has a duplicate");
});

// ---- C: the `--` option terminator protects positional data from action/mode interpretation ---------

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

// ---- D: repeated --mode routes by the EFFECTIVE (last) mode, matching parseArgs ---------------------

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

// ---- E/F: the mutation guard is FAIL-CLOSED and sits UPSTREAM of the real writers -------------------

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
