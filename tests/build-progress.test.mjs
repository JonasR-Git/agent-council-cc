import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBuild } from "../plugins/council/scripts/lib/build.mjs";
import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// Phase 2 / Task 4 — `council build` must FEED the progress reporter (phase + step progress + a gate
// name per committed/failed step). Injected git + step runner + a real reporter — no repo, no model.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "council-build-progress-"));
const BASE = "base0000ffffffff";

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

function fakeGit({ clean = true, repo = true, branch = "master", head = BASE } = {}) {
  const calls = [];
  let current = head;
  let dirty = !clean;
  return {
    calls,
    setHead(h) {
      current = h;
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

const okStep = (git) => async (step) => {
  git.setHead(`c-${step.id}`);
  return { ok: true, commit: `c-${step.id}`, modelCalls: 3 };
};

function baseDeps(git, over = {}) {
  return {
    git,
    testCmd: { cmd: "node", args: ["--version"] },
    runTests: async () => ({ ok: true }),
    seatsReady: () => ({ ready: true, reasons: {} }),
    validatePlan: () => ({ valid: true }),
    acquireLock: () => "lock-token",
    releaseLock: () => {},
    runStep: okStep(git),
    ...over
  };
}

function makeReporter() {
  const writes = [];
  const reporter = makeProgressReporter({
    kind: "build",
    title: "council build",
    stateDir: "C:/state",
    now: () => "2026-07-13T00:00:00.000Z",
    writeFile: (file, data) => writes.push({ file, data })
  });
  return { reporter, writes };
}

test("runBuild drives the build phase + step progress + a pass gate per committed step", async () => {
  const git = fakeGit();
  const { reporter, writes } = makeReporter();
  const out = await runBuild(tmp(), plan(), {}, { reporter }, baseDeps(git));
  assert.equal(out.ok, true);
  assert.equal(out.committed, 2);

  const snap = reporter.snapshot();
  assert.equal(snap.phase, "build");
  assert.equal(snap.phaseDetail, "step 2/2", "the last step's phase detail is carried");
  assert.equal(snap.progress.unitsDone, 2, "both committed steps counted");
  assert.equal(snap.progress.unitsTotal, 2);
  assert.equal(snap.gate.name, "step-two", "the last committed step drives the gate");
  assert.equal(snap.gate.state, "pass");
  assert.ok(writes.length > 0, "progress.json was persisted through the injected writeFile");
});

test("runBuild marks a failed step's gate as veto", async () => {
  const git = fakeGit();
  const { reporter } = makeReporter();
  let n = 0;
  const runStep = async (step) => {
    n += 1;
    if (n === 1) {
      git.setHead(`c-${step.id}`);
      return { ok: true, commit: `c-${step.id}`, modelCalls: 3 };
    }
    return { ok: false, reason: "impl gate failed" };
  };
  const out = await runBuild(tmp(), plan(), {}, { reporter }, baseDeps(git, { runStep }));
  assert.equal(out.ok, false);
  const snap = reporter.snapshot();
  assert.equal(snap.gate.name, "step-two");
  assert.equal(snap.gate.state, "veto", "the failing step vetoes its gate");
});

test("runBuild without a reporter is unchanged (NOOP fallback)", async () => {
  const git = fakeGit();
  const out = await runBuild(tmp(), plan(), {}, {}, baseDeps(git));
  assert.equal(out.ok, true, "omitting options.reporter falls back to NOOP_REPORTER and changes nothing");
});
