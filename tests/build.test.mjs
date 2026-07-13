import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeBuildGit, makeStepPorts, planShapeReason, renderBuildReport, runBuild } from "../plugins/council/scripts/lib/build.mjs";
import { resolveStateDir } from "../plugins/council/scripts/lib/state.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "council-build-"));

const BASE = "base0000ffffffff";

// --- fixtures -----------------------------------------------------------------

function planStep(id, over = {}) {
  return {
    id,
    title: `title of ${id}`,
    intent: "the observable outcome",
    files: [
      { path: `lib/${id}.mjs`, action: "create", role: "source", intent: "impl" },
      { path: `tests/${id}.test.mjs`, action: "create", role: "test", intent: "proof" }
    ],
    test: { files: [`tests/${id}.test.mjs`], intent: "proves the outcome" },
    dependsOn: [],
    ...over
  };
}

function plan(over = {}) {
  return {
    schemaVersion: 1,
    request: "add a widget to the dashboard",
    requestHash: "d34db33fd34db33f",
    baseCommit: BASE,
    steps: [planStep("step-one"), planStep("step-two", { dependsOn: ["step-one"] })],
    risks: [],
    testStrategy: { perStep: "full", final: "full" },
    ...over
  };
}

// Fake git that models the branch/head/dirty state the orchestrator verifies.
function fakeGit({ clean = true, repo = true, branch = "master", head = BASE } = {}) {
  const calls = [];
  let current = head;
  let dirty = !clean;
  return {
    calls,
    setHead(h) {
      current = h;
    },
    setDirty(d) {
      dirty = d;
    },
    isRepo: () => repo,
    isClean: () => !dirty,
    head: () => current,
    currentBranch: () => branch,
    branchExists: () => false,
    createAndCheckout: (b, ref) => calls.push(["createAndCheckout", b, ref]),
    checkout: (ref) => (calls.push(["checkout", ref]), true),
    changedFiles: () => [],
    resetHard(ref) {
      calls.push(["resetHard", ref]);
      current = ref;
      dirty = false;
    }
  };
}

// A step runner that behaves like a fully green build-step: lands one commit per step.
const okStep = (git, order = []) => async (step) => {
  order.push(step.id);
  git.setHead(`c-${step.id}`);
  return { ok: true, commit: `c-${step.id}`, modelCalls: 3 };
};

function baseDeps(git, over = {}) {
  return {
    git,
    testCmd: { cmd: "node", args: ["--version"] },
    runTests: async () => ({ ok: true }),
    seatsReady: () => ({ ready: true, reasons: {} }),
    // The REAL default is plan-spec's validatePlanSpec (pinned by its own test below); the
    // fixtures here use readable placeholder hashes, so unit tests inject a green verdict.
    validatePlan: () => ({ valid: true }),
    acquireLock: () => "lock-token",
    releaseLock: () => {},
    runStep: okStep(git),
    ...over
  };
}

// Counters proving a refused preflight spends NOTHING (no model call, no test run).
function spendCounters() {
  const spend = { steps: 0, tests: 0 };
  return {
    spend,
    runStep: async () => {
      spend.steps += 1;
      return { ok: true, commit: "x" };
    },
    runTests: async () => {
      spend.tests += 1;
      return { ok: true };
    }
  };
}

// --- planShapeReason (pure preflight shape gate) --------------------------------

test("planShapeReason accepts the frozen PlanSpec shape and rejects malformed plans", () => {
  assert.equal(planShapeReason(plan()), null);
  assert.match(planShapeReason(null), /not an object/);
  assert.match(planShapeReason(plan({ schemaVersion: 2 })), /schemaVersion/);
  assert.match(planShapeReason(plan({ request: " " })), /request/);
  assert.match(planShapeReason(plan({ requestHash: "" })), /requestHash/);
  assert.match(planShapeReason(plan({ baseCommit: "" })), /baseCommit/);
  assert.match(planShapeReason(plan({ steps: [] })), /no steps/);
  assert.match(planShapeReason(plan({ steps: [planStep("Bad_Id")] })), /invalid id/);
  assert.match(planShapeReason(plan({ steps: [planStep("a"), planStep("a")] })), /duplicate/);
  assert.match(planShapeReason(plan({ steps: [planStep("a", { files: [] })] })), /no files/);
});

test("planShapeReason enforces earlier-only dependsOn (acyclic by construction) and the step bound", () => {
  // forward reference = not an earlier step -> rejected (this also excludes any cycle)
  assert.match(planShapeReason(plan({ steps: [planStep("a", { dependsOn: ["b"] }), planStep("b")] })), /EARLIER/);
  assert.match(planShapeReason(plan({ steps: [planStep("a", { dependsOn: ["a"] })] })), /EARLIER/, "self-dependency rejected");
  const big = plan({ steps: Array.from({ length: 9 }, (_, i) => planStep(`s-${i}`)) });
  assert.match(planShapeReason(big), /exceeds the 8-step/);
  // The 8-step blast-radius bound is a CEILING, not a default: maxSteps may only TIGHTEN it. A caller
  // that could RAISE it would be an escape hatch on the riskiest capability in the tool (a bigger
  // request must be split into multiple plans instead).
  assert.match(planShapeReason(big, { maxSteps: 9 }), /exceeds the 8-step/, "the ceiling CANNOT be raised by a caller");
  assert.match(planShapeReason(big, { maxSteps: 99 }), /exceeds the 8-step/, "...not by any value");
  const five = plan({ steps: Array.from({ length: 5 }, (_, i) => planStep(`s-${i}`)) });
  assert.equal(planShapeReason(five), null, "a plan within the ceiling is fine");
  assert.match(planShapeReason(five, { maxSteps: 3 }), /exceeds the 3-step/, "...but a caller MAY tighten the bound");
});

// --- preflight: refuse-to-start, spending NOTHING --------------------------------

test("preflight refuses outside a git repo and spends nothing", async () => {
  const git = fakeGit({ repo: false });
  const c = spendCounters();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, c));
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "preflight");
  assert.match(out.error, /git repository/);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
  assert.equal(git.calls.length, 0, "no branch created, nothing checked out");
});

test("preflight refuses a dirty tree (no --allow-dirty) and spends nothing", async () => {
  const git = fakeGit({ clean: false });
  const c = spendCounters();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, c));
  assert.equal(out.ok, false);
  assert.match(out.error, /not clean/);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
});

test("preflight refuses a detached HEAD (no named base branch to return to)", async () => {
  const git = fakeGit({ branch: "" });
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, spendCounters()));
  assert.equal(out.ok, false);
  assert.match(out.error, /detached HEAD/i);
});

test("preflight refuses when HEAD does not match the plan's baseCommit and spends nothing", async () => {
  const git = fakeGit();
  const c = spendCounters();
  const out = await runBuild(tmp(), plan({ baseCommit: "0therbase00000000" }), {}, {}, baseDeps(git, c));
  assert.equal(out.ok, false);
  assert.match(out.error, /baseCommit/);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
});

test("preflight refuses without a detectable test command (no --allow-untested)", async () => {
  const git = fakeGit();
  // testCmd: null falls through to detectTestCmd(root) on an empty temp dir -> none.
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, { ...spendCounters(), testCmd: null }));
  assert.equal(out.ok, false);
  assert.match(out.error, /test gate|test command/);
});

test("preflight refuses when a required §6 seat is unreachable, BEFORE any test/model spend", async () => {
  const git = fakeGit();
  const c = spendCounters();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, { ...c, seatsReady: () => ({ ready: false, grok: false, reasons: { grok: "grok CLI unreachable" } }) })
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /§6 council incomplete/);
  assert.match(out.error, /grok CLI unreachable/, "names the blocked seat");
  assert.deepEqual(c.spend, { steps: 0, tests: 0 }, "the seat check comes before the baseline suite run");
});

test("preflight refuses a RED baseline (and never creates the branch or runs a step)", async () => {
  const git = fakeGit();
  let stepsRun = 0;
  let released = 0;
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runTests: async () => ({ ok: false, output: "1 failing" }),
      runStep: async () => {
        stepsRun += 1;
        return { ok: true };
      },
      releaseLock: () => {
        released += 1;
      }
    })
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /baseline .*RED/i);
  assert.equal(stepsRun, 0, "spends no model call");
  assert.equal(git.calls.filter((x) => x[0] === "createAndCheckout").length, 0, "no branch created");
  assert.equal(released, 1, "the repo lock is released even on a post-lock refusal");
});

test("preflight refuses an invalid plan and a plan exceeding the step bound", async () => {
  const git = fakeGit();
  const bad = await runBuild(tmp(), plan({ steps: [] }), {}, {}, baseDeps(git, spendCounters()));
  assert.match(bad.error, /invalid PlanSpec/);
  const big = await runBuild(tmp(), plan({ steps: Array.from({ length: 9 }, (_, i) => planStep(`s-${i}`)) }), {}, {}, baseDeps(git, spendCounters()));
  assert.match(big.error, /exceeds the 8-step/);
});

test("preflight refuses when the build lock is already held", async () => {
  const git = fakeGit();
  const c = spendCounters();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      ...c,
      acquireLock: () => {
        throw new Error("EEXIST");
      }
    })
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /already running|lock/);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
});

test("preflight refuses when the build branch already exists — BEFORE the baseline suite is spent", async () => {
  const git = fakeGit();
  git.branchExists = () => true;
  const c = spendCounters();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, c));
  assert.equal(out.ok, false);
  assert.match(out.error, /already exists/);
  assert.equal(git.calls.filter((x) => x[0] === "createAndCheckout").length, 0);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 }, "the cheap branch check comes before the expensive baseline run");
});

test("preflight runs the REAL plan-spec validator by default (defense-in-depth) and spends nothing", async () => {
  // The fixture plan carries a placeholder requestHash/baseCommit — the real validatePlanSpec
  // MUST reject it. Discriminating: without the preflight validation call this run completes.
  const git = fakeGit();
  const c = spendCounters();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, { ...c, validatePlan: undefined }));
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "preflight");
  assert.match(out.error, /PlanSpec validation failed/);
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
  assert.equal(git.calls.length, 0, "no branch created, nothing checked out");
});

test("an injected plan validator is honored FAIL-CLOSED: invalid, malformed, and throwing all refuse", async () => {
  const bad = await runBuild(tmp(), plan(), {}, {}, baseDeps(fakeGit(), { validatePlan: () => ({ valid: false, errors: ["edit target does not exist: lib/x.mjs"] }) }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /PlanSpec validation failed: edit target does not exist/);
  const malformed = await runBuild(tmp(), plan(), {}, {}, baseDeps(fakeGit(), { validatePlan: () => null }));
  assert.match(malformed.error, /PlanSpec validation failed/);
  const throwing = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(fakeGit(), {
      validatePlan: () => {
        throw new Error("validator exploded");
      }
    })
  );
  assert.match(throwing.error, /validator exploded/);
});

test("options.testCmd is NOT honored — an arbitrary shell test command is a forbidden escape hatch", async () => {
  // A caller-supplied noop oracle (`node -e process.exit(0)`) must never replace the DETECTED
  // suite: on a repo with no detectable test command the build refuses instead of going
  // permanently green. Discriminating: with options.testCmd honored this run completes.
  const git = fakeGit();
  const out = await runBuild(tmp(), plan(), {}, { testCmd: { cmd: "node", args: ["-e", "process.exit(0)"] } }, baseDeps(git, { testCmd: null }));
  assert.equal(out.ok, false);
  assert.match(out.error, /no test command/);
});

test("§6 council-reducing options are refused outright (unweakenable by ANY flag)", async () => {
  // seatsReady is injected ready:true, so ONLY the flag refusal can stop these runs.
  const c = spendCounters();
  for (const options of [{ skipOpenRouter: true }, { skipSeats: ["or-fast"] }, { skipSeats: "grok" }]) {
    const out = await runBuild(tmp(), plan(), {}, options, baseDeps(fakeGit(), c));
    assert.equal(out.ok, false, `must refuse ${JSON.stringify(options)}`);
    assert.equal(out.stopReason, "preflight");
    assert.match(out.error, /reduce the §6 council/);
  }
  assert.deepEqual(c.spend, { steps: 0, tests: 0 });
  // ...but an EMPTY skipSeats list reduces nothing and passes.
  const ok = await runBuild(tmp(), plan(), {}, { skipSeats: [] }, baseDeps(fakeGit()));
  assert.equal(ok.ok, true);
});

test("the default lock also refuses while an `audit fix` holds this repo (shared working tree)", async () => {
  const cwd = tmp();
  const prev = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = tmp();
  try {
    const stateDir = resolveStateDir(cwd);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "audit-fix.lock"), "999");
    const c = spendCounters();
    const out = await runBuild(cwd, plan(), {}, {}, baseDeps(fakeGit(), { ...c, acquireLock: undefined }));
    assert.equal(out.ok, false);
    assert.match(out.error, /lock held/);
    assert.deepEqual(c.spend, { steps: 0, tests: 0 });
    assert.equal(fs.existsSync(path.join(stateDir, "build.lock")), false, "no build.lock left behind");
  } finally {
    if (prev === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = prev;
  }
});

// --- the run: ordered steps, first-failure abort, final gate ---------------------

test("happy path: steps run in declared order on an isolated branch; base is only checked out at the END", async () => {
  const git = fakeGit();
  const order = [];
  let released = 0;
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, { runStep: okStep(git, order), releaseLock: () => (released += 1) }));
  assert.equal(out.ok, true);
  assert.equal(out.stopReason, "completed");
  assert.deepEqual(order, ["step-one", "step-two"], "declared order");
  assert.match(out.branch, /^council\/build-add-a-widget/);
  const created = git.calls.find((x) => x[0] === "createAndCheckout");
  assert.deepEqual(created.slice(1), [out.branch, BASE], "branch cut from the exact plan base");
  // The base branch is NEVER checked out during the run — the ONLY checkout is the final return.
  assert.deepEqual(git.calls.filter((x) => x[0] === "checkout"), [["checkout", "master"]]);
  assert.equal(out.returnedToBase, true);
  assert.equal(out.committed, 2);
  assert.deepEqual(out.steps.map((s) => s.commit), ["c-step-one", "c-step-two"]);
  assert.equal(out.integration.ok, true, "final full suite ran green");
  assert.equal(out.merged, false, "NEVER merged");
  assert.equal(released, 1, "lock released");
});

test("the FIRST step failure aborts the run: later steps never run, prior commits stay on the branch", async () => {
  const git = fakeGit();
  const order = [];
  const p = plan({ steps: [planStep("step-one"), planStep("step-two"), planStep("step-three")] });
  const out = await runBuild(
    tmp(),
    p,
    {},
    {},
    baseDeps(git, {
      runStep: async (step) => {
        order.push(step.id);
        if (step.id === "step-two") return { ok: false, reason: "RED-before never went red (tautological test)" };
        git.setHead(`c-${step.id}`);
        return { ok: true, commit: `c-${step.id}`, modelCalls: 3 };
      }
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "step-failed:step-two");
  assert.deepEqual(order, ["step-one", "step-two"], "step-three is NEVER attempted (dependent steps)");
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].commit, "c-step-one", "the prior commit is kept for human review");
  assert.match(out.steps[1].reason, /tautological/);
  assert.equal(out.committed, 1);
  assert.equal(out.returnedToBase, true);
  assert.equal(git.calls.filter((x) => x[0] === "resetHard").length, 0, "a clean step rollback needs no orchestrator restore");
  assert.ok(out.integration, "the partial branch still gets a final suite verdict for the reviewer");
});

test("a failed FINAL suite is reported (branch kept, ok:false, not merged)", async () => {
  const git = fakeGit();
  let call = 0;
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runTests: async () => ({ ok: (call += 1) === 1 }) // baseline green, integration RED
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "integration-red");
  assert.equal(out.integrationFailed, true);
  assert.equal(out.committed, 2, "the commits stay on the branch for review");
  assert.equal(out.returnedToBase, true);
  assert.equal(out.merged, false);
});

test("a step that reports a failed rollback strands the run: no reset, no return to base", async () => {
  const git = fakeGit();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runStep: async (step) => {
        if (step.id === "step-one") {
          git.setHead("c-step-one");
          return { ok: true, commit: "c-step-one" };
        }
        return { ok: false, stranded: true, reason: "git revert failed (reset 128)" };
      },
      runTests: (() => {
        let n = 0;
        return async () => {
          n += 1;
          assert.equal(n, 1, "only the baseline runs — never the final suite on a stranded tree");
          return { ok: true };
        };
      })()
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stranded, true);
  assert.equal(out.stopReason, "stranded:step-two");
  assert.equal(out.returnedToBase, false);
  assert.ok(!git.calls.some((x) => x[0] === "checkout" && x[1] === "master"), "never checks out base over a stranded tree");
  assert.equal(out.integration, null);
});

test("a failed step's rollback CLAIM is verified: a dirty tree is restored by the orchestrator", async () => {
  const git = fakeGit();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runStep: async () => {
        git.setDirty(true); // the step claims failure but left the tree dirty
        return { ok: false, reason: "impl author exited 1" };
      }
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "step-failed:step-one");
  assert.equal(out.stranded, false);
  assert.ok(git.calls.some((x) => x[0] === "resetHard" && x[1] === BASE), "restored to the pre-step snapshot");
  assert.match(out.steps[0].note, /restored/);
  assert.equal(out.returnedToBase, true);
});

test("a failed restore after an incomplete step rollback strands the run", async () => {
  const git = fakeGit();
  git.resetHard = () => {
    throw new Error("reset failed");
  };
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runStep: async () => {
        git.setDirty(true);
        return { ok: false, reason: "impl author exited 1" };
      }
    })
  );
  assert.equal(out.stranded, true);
  assert.equal(out.stopReason, "stranded:step-one");
  assert.equal(out.steps[0].stranded, true);
  assert.equal(out.returnedToBase, false, "a dirty, unrestorable tree is left in place for manual cleanup");
});

test("a THROWING step runner is treated as a failed step (fail-closed), not a crash", async () => {
  const git = fakeGit();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runStep: async () => {
        throw new Error("kaboom");
      }
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "step-failed:step-one");
  assert.match(out.steps[0].reason, /kaboom/);
  assert.equal(out.returnedToBase, true);
});

test("an OK step that leaves a dirty tree is scrubbed to its commit and the run aborts fail-closed", async () => {
  const git = fakeGit();
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    {},
    baseDeps(git, {
      runStep: async () => {
        git.setHead("c-step-one");
        git.setDirty(true); // undeclared leftovers on top of the commit
        return { ok: true, commit: "c-step-one" };
      }
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "post-step-dirty:step-one");
  assert.ok(git.calls.some((x) => x[0] === "resetHard" && x[1] === "c-step-one"), "scrubbed down to the gated commit");
  assert.equal(out.steps[0].ok, true, "the commit itself passed every gate and is kept");
  assert.equal(out.committed, 1);
  assert.equal(out.returnedToBase, true);
});

test("a failed final return to base is NOT reported as a completed build (fail-closed)", async () => {
  const git = fakeGit();
  git.checkout = () => false; // e.g. an index/worktree error at the final checkout
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git));
  assert.equal(out.ok, false, "a run that leaves the operator on the build branch is not complete");
  assert.equal(out.stopReason, "return-to-base-failed");
  assert.equal(out.returnedToBase, false);
  assert.equal(out.committed, 2, "the branch and its commits stay intact for review");
});

test("an unexpected mid-run crash attempts a safe return to base (clean tree only), then RETHROWS", async () => {
  const git = fakeGit();
  let calls = 0;
  const deps = baseDeps(git, {
    runTests: async () => {
      calls += 1;
      if (calls === 2) throw new Error("suite runner exploded"); // the final integration call
      return { ok: true };
    }
  });
  await assert.rejects(() => runBuild(tmp(), plan(), {}, {}, deps), /exploded/, "an unexpected error surfaces as an error, never a result");
  assert.deepEqual(
    git.calls.filter((x) => x[0] === "checkout"),
    [["checkout", "master"]],
    "the operator is put back on base before the error surfaces"
  );
});

test("without an injected runStep the REAL build-step runner is wired and fails CLOSED on missing model ports", async () => {
  // No deps.stepDeps: the model-facing ports (authorTests/authorImpl/writeFiles/runStepTest/
  // reviewStep) are unwired, so the lazily imported runBuildStep must abort step 1 loudly —
  // an incompletely wired run may never soft-skip a gate. Discriminating: a fake runStep that
  // ignores its ports would commit both steps here.
  const git = fakeGit();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git, { runStep: undefined }));
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "step-failed:step-one");
  assert.match(out.steps[0].reason, /incomplete deps/);
  assert.match(out.steps[0].reason, /authorTests/);
  assert.equal(out.committed, 0);
});

// --- run budgets (whole-run bounds) ----------------------------------------------

test("wall-clock budget stops the run BETWEEN steps and keeps prior commits", async () => {
  const git = fakeGit();
  let t = 0;
  const out = await runBuild(
    tmp(),
    plan(),
    {},
    { maxWallClockMs: 5000 },
    baseDeps(git, {
      now: () => t,
      runStep: async (step) => {
        t += 10_000; // each step consumes 10s of wall clock
        git.setHead(`c-${step.id}`);
        return { ok: true, commit: `c-${step.id}`, modelCalls: 1 };
      }
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, "budget:wall-clock");
  assert.equal(out.steps.length, 1, "step-two is not started");
  assert.equal(out.committed, 1, "step-one's commit stays on the branch");
  assert.equal(out.returnedToBase, true);
});

test("model-call budget stops the run; unreported spend is charged CONSERVATIVELY (fail-closed)", async () => {
  const git = fakeGit();
  const reported = await runBuild(
    tmp(),
    plan(),
    {},
    { maxModelCalls: 4 },
    baseDeps(git, {
      runStep: async (step) => {
        git.setHead(`c-${step.id}`);
        return { ok: true, commit: `c-${step.id}`, modelCalls: 5 };
      }
    })
  );
  assert.equal(reported.stopReason, "budget:model-calls");
  assert.equal(reported.steps.length, 1);

  // A step result WITHOUT modelCalls is charged 2 authors + one vote per required seat
  // (3 built-ins with empty backends => 5), so silence can only SHRINK the budget.
  const git2 = fakeGit();
  const silent = await runBuild(
    tmp(),
    plan(),
    {},
    { maxModelCalls: 5 },
    baseDeps(git2, {
      runStep: async (step) => {
        git2.setHead(`c2-${step.id}`);
        return { ok: true, commit: `c2-${step.id}` };
      }
    })
  );
  assert.equal(silent.stopReason, "budget:model-calls");
  assert.equal(silent.budget.modelCallsSpent, 5, "conservative default charge");
  assert.equal(silent.steps.length, 1);
});

// --- makeBuildGit against a REAL repo ---------------------------------------------

test("makeBuildGit: stageSet/diffCachedSet/commitIndex bind a FILE SET; resetHard restores + cleans", () => {
  const dir = tmp();
  const raw = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  raw(["init", "-q"]);
  raw(["config", "user.email", "council@test.invalid"]);
  raw(["config", "user.name", "council-test"]);
  // Pin line endings: a global core.autocrlf=true would rewrite LF -> CRLF on the
  // reset --hard checkout and break the byte-exact restore assertion below.
  raw(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  raw(["add", "-A"]);
  raw(["commit", "-q", "-m", "init", "--no-verify"]);

  const git = makeBuildGit(dir);
  assert.equal(git.isRepo(), true);
  assert.equal(git.isClean(), true);
  const base = git.head();

  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  assert.deepEqual(git.changedFiles().sort(), ["a.txt", "b.txt"]);

  git.stageSet(["a.txt", "b.txt"]);
  const diff = git.diffCachedSet(["a.txt", "b.txt"], base);
  assert.match(diff, /\+two/, "staged diff carries the edit");
  assert.match(diff, /\+new/, "staged diff carries the new file");

  const sha = git.commitIndex("build-step: both declared files");
  assert.notEqual(sha, base);
  assert.equal(git.isClean(), true, "one commit per step, nothing left over");

  // resetHard restores tracked state AND removes untracked leftovers (no -x: ignored files survive).
  fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "junk\n");
  git.resetHard(base);
  assert.equal(git.head(), base);
  assert.equal(git.isClean(), true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
  assert.equal(fs.existsSync(path.join(dir, "b.txt")), false, "the committed-then-reset file is gone");
  assert.equal(fs.existsSync(path.join(dir, "c.txt")), false, "untracked junk is cleaned");

  assert.throws(() => git.stageSet([]), /empty path set/, "an empty set can never stage anything (fail-closed)");
});

test("makeBuildGit: commitIndex lands ONLY the reviewed index tree — unreviewed drift is refused", () => {
  const dir = tmp();
  const raw = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  raw(["init", "-q"]);
  raw(["config", "user.email", "council@test.invalid"]);
  raw(["config", "user.name", "council-test"]);
  raw(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  raw(["add", "-A"]);
  raw(["commit", "-q", "-m", "init", "--no-verify"]);

  const git = makeBuildGit(dir);
  const base = git.head();

  // 1) commitIndex WITHOUT a preceding diffCachedSet review refuses outright.
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  git.stageSet(["a.txt"]);
  assert.throws(() => git.commitIndex("unreviewed"), /nothing was reviewed/i);
  assert.equal(git.head(), base, "no commit landed");

  // 2) an UNDECLARED file staged by an outside writer AFTER the review is refused, even though
  //    the declared-path diff stayed byte-identical (the classic unscoped-index sweep).
  git.diffCachedSet(["a.txt"], base);
  fs.writeFileSync(path.join(dir, "evil.txt"), "evil\n");
  raw(["add", "evil.txt"]);
  assert.throws(() => git.commitIndex("swept"), /unreviewed bytes/i);
  assert.equal(git.head(), base, "no commit landed");

  // 3) even re-staged DIFFERENT bytes on the DECLARED path are caught (identical name set!).
  raw(["reset", "-q", "HEAD", "--", "evil.txt"]);
  fs.unlinkSync(path.join(dir, "evil.txt"));
  git.diffCachedSet(["a.txt"], base);
  fs.writeFileSync(path.join(dir, "a.txt"), "TAMPERED\n");
  raw(["add", "a.txt"]);
  assert.throws(() => git.commitIndex("tampered"), /unreviewed bytes/i);
  assert.equal(git.head(), base, "no commit landed");

  // 4) a fresh review of the CURRENT index then commits cleanly.
  git.diffCachedSet(["a.txt"], base);
  const sha = git.commitIndex("now reviewed");
  assert.notEqual(sha, base);
  assert.equal(git.isClean(), true);
});

// --- makeStepPorts: repo-contained fail-closed FS ports ------------------------------

test("makeStepPorts: reads fail CLOSED (no empty-string lie) and never resolve outside the repo", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "a.mjs"), "export const a = 1;\n");
  const ports = makeStepPorts(dir);

  assert.equal(ports.fileExists("lib/a.mjs"), true);
  assert.equal(ports.fileExists("lib/missing.mjs"), false);
  assert.equal(ports.readFile("lib/a.mjs"), "export const a = 1;\n");
  assert.throws(() => ports.readFile("lib/missing.mjs"), /ENOENT|no such file/i, "a read miss THROWS — never an empty-string that reads as an empty file");
  assert.throws(() => ports.readFile("../outside.mjs"), /escapes the repository/);
  assert.throws(() => ports.fileExists("../outside.mjs"), /escapes the repository/);
  assert.throws(() => ports.readFile(path.join(os.tmpdir(), "abs.mjs")), /escapes the repository/, "absolute paths are refused");

  // An ancestor junction/symlink pointing OUTSIDE the repo must not smuggle reads/edit targets
  // out (git would see no change there and rollback could not restore the external file).
  // Junctions need no privilege on Windows; on POSIX the type arg is ignored (plain symlink).
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.mjs"), "SECRET\n");
  try {
    fs.symlinkSync(outside, path.join(dir, "vendor"), "junction");
  } catch {
    return; // cannot create links in this environment — the lexical + lstat guards above are pinned
  }
  assert.throws(() => ports.readFile("vendor/secret.mjs"), /outside the repository/, "ancestor link escape is refused");
  assert.throws(() => ports.fileExists("vendor/secret.mjs"), /outside the repository/);
  assert.throws(() => ports.fileExists("vendor"), /symlink/, "the link itself is refused as an edit/create target");
});

// --- report ------------------------------------------------------------------------

test("renderBuildReport covers refusal, per-step outcomes, and the never-merge guarantee", async () => {
  const git = fakeGit();
  const happy = await runBuild(tmp(), plan(), {}, {}, baseDeps(git));
  const report = renderBuildReport(happy);
  assert.match(report, /NEVER auto-merged/);
  assert.match(report, /step-one — committed c-step-o/);
  assert.match(report, /steps: 2\/2 committed/);
  assert.match(report, /returned to master/);

  const refused = await runBuild(tmp(), plan(), {}, {}, baseDeps(fakeGit({ clean: false })));
  assert.match(renderBuildReport(refused), /REFUSED at preflight/);
  assert.match(renderBuildReport(refused), /not clean/);

  const git3 = fakeGit();
  const aborted = await runBuild(
    tmp(),
    plan({ steps: [planStep("s-a"), planStep("s-b"), planStep("s-c")] }),
    {},
    {},
    baseDeps(git3, {
      runStep: async (step) => {
        if (step.id === "s-b") return { ok: false, reason: "council veto" };
        git3.setHead(`c-${step.id}`);
        return { ok: true, commit: `c-${step.id}` };
      }
    })
  );
  const abortedReport = renderBuildReport(aborted);
  assert.match(abortedReport, /FAILED: council veto/);
  assert.match(abortedReport, /\+1 step\(s\) not reached/);
});
