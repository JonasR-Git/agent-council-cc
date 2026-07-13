import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeProgressReporter } from "../plugins/council/scripts/lib/progress.mjs";

// council-companion.mjs is a CLI entry point, so most findings can only be pinned by spawning it as
// a subprocess - matching the pattern used by tests/release-fixes.test.mjs, tests/phase-d.test.mjs
// and tests/setup-init.test.mjs (which this file does not modify). It additionally exports a few
// PURE helpers (e.g. classifyAuthoredTestRun) and guards its main() behind an entry-script check,
// so those helpers are unit-tested by direct import (the import runs no CLI).

const COMPANION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "council",
  "scripts",
  "council-companion.mjs"
);

function isSandboxBlocked(result) {
  return Boolean(result.error) && (result.error.code === "EPERM" || result.error.code === "ENOENT");
}

function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-cli-work-"));
  // A trivial source file so buildCodebaseModel has something to enumerate; not a git repo (workspaceRoot
  // falls back to cwd, and enumerateFiles/churnMap fall back gracefully - no git dependency needed here).
  fs.writeFileSync(path.join(dir, "index.mjs"), "export const value = 1;\n", "utf8");
  return dir;
}

// Forces ALL THREE built-in seats inactive, deterministically, regardless of what Codex/Grok/Claude
// CLIs happen to be installed on the machine running the test:
//  - reviewers: [claude] policy-skips codex+grok (seatActive short-circuits on options.skipCodex/skipGrok
//    before ever consulting backend availability), so no real codex/grok CLI is ever invoked.
//  - CLAUDE_BIN points at a dummy script that exits non-zero, so the remaining claude reviewer's
//    `claude --version` probe reports unavailable too (findClaudeBinary honors CLAUDE_BIN before any
//    home-dir/PATH lookup, so this wins even when a real `claude` is installed and on PATH).
function makeAllSeatsUnreachable(workDir) {
  fs.writeFileSync(path.join(workDir, ".council.yml"), "version: 1\nreviewers: [claude]\n", "utf8");
  const fakeClaudeBin = path.join(workDir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaudeBin, "@echo off\r\nexit /b 1\r\n", "utf8");
  return fakeClaudeBin;
}

function withCli(fn) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-cli-state-"));
  const workDir = makeWorkDir();
  try {
    return fn(workDir, { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot });
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test("audit fix --chartest (single-shot) fails loud when no generator seat is reachable", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    const env = { ...baseEnv, CLAUDE_BIN: fakeClaudeBin };
    const res = spawnSync(process.execPath, [COMPANION, "audit", "fix", "--chartest"], {
      cwd: workDir,
      env,
      encoding: "utf8",
      timeout: 60_000
    });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    // Before the fix: the single-shot path called the raw makeCharTestGate helper directly, which
    // returns null (silently) instead of throwing - the run would exit 0 having auto-applied any
    // refactor-class fix UNGATED. After the fix: resolveCharTestGate throws, matching the --loop path.
    assert.notEqual(
      res.status,
      0,
      "single-shot `audit fix --chartest` must fail loud (non-zero exit), not silently continue ungated, when no generator seat is reachable"
    );
    assert.match(res.stderr, /--chartest requires a reachable generator seat/);
  });
});

test("audit fix --groups (single-shot, no --from) actually dispatches the grouped six-eyes review", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    const env = { ...baseEnv, CLAUDE_BIN: fakeClaudeBin };
    const res = spawnSync(
      process.execPath,
      [COMPANION, "audit", "fix", "--groups", "fine", "--budget", "20"],
      { cwd: workDir, env, encoding: "utf8", timeout: 60_000 }
    );
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    // This note is only ever emitted by the GROUPED review branch (mirrors `audit review --groups`'s
    // own wiring); before the fix, single-shot `audit fix`'s fresh review never read --groups at all, so
    // this note never appeared and a plain per-file review silently ran instead.
    assert.match(
      res.stderr,
      /--budget does not bound --groups/,
      "single-shot `audit fix --groups` must run the grouped review engine for its fresh review, not the plain per-file one"
    );
  });
});

test("plain `review` (non-adversarial) forwards focus text to the codex companion", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeCompanion = path.join(workDir, "fake-codex-companion.mjs");
    fs.writeFileSync(fakeCompanion, "console.log('{}');\n", "utf8");
    const env = { ...baseEnv, CODEX_COMPANION_PATH: fakeCompanion };
    const res = spawnSync(
      process.execPath,
      [COMPANION, "review", "--skip-grok", "--json", "focus on the auth token refresh path"],
      { cwd: workDir, env, encoding: "utf8", timeout: 60_000 }
    );
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    const finished = JSON.parse(res.stdout);
    const codex = finished.results?.find((r) => r.agent === "codex");
    assert.ok(codex && !codex.skipped, "codex should have run via the fake companion");
    // Before the fix: buildCodexReviewArgs only appended focusText when `adversarial` was true, so plain
    // `review`/`--quick` silently dropped it for the companion path. The recorded `command` (built from
    // the exact args passed to the companion) is the observable proof either way.
    assert.match(
      codex.command ?? "",
      /focus on the auth token refresh path/,
      "plain review must forward the focus text to the codex companion, not only in adversarial mode"
    );
  });
});

// --- `council plan` / `council build` CLI contracts ------------------------------------------
// The build command is the riskiest capability in the tool (autonomous greenfield code generation).
// These pin the SAFETY surface at the CLI boundary, where a regression would be invisible to the
// module unit tests: the path confinement, the absence of every escape hatch, and fail-loud inputs.

const cli = (args, cwd = process.cwd()) =>
  spawnSync(process.execPath, [COMPANION, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

test("council plan/build are dispatched (they exist and fail LOUDLY without their required input)", () => {
  const plan = cli(["plan"]);
  assert.notEqual(plan.status, 0, "a plan with no feature request must fail, not silently no-op");
  assert.match(`${plan.stdout}${plan.stderr}`, /needs a feature request/i);

  const build = cli(["build"]);
  assert.notEqual(build.status, 0);
  assert.match(`${build.stdout}${build.stderr}`, /needs a PlanSpec/i, "build must refuse to run without a plan");
});

test("council build --from is CONFINED to the project root (no ../ escape)", () => {
  const res = cli(["build", "--from", "../../etc/passwd"]);
  assert.notEqual(res.status, 0);
  assert.match(`${res.stdout}${res.stderr}`, /must stay within the project root/i, "an escaping --from is refused, never read");
});

test("council build has NO escape hatches (they must not even parse)", () => {
  // The gate ladder + §6 unanimity are the whole safety argument. A flag that could weaken them must
  // not exist — assert the parser REJECTS each as unknown rather than silently accepting it.
  for (const hatch of ["--allow-untested", "--skip-council", "--allow-dirty", "--force", "--no-verify"]) {
    const res = cli(["build", "--from", "plan.json", hatch]);
    assert.notEqual(res.status, 0, `${hatch} must not be accepted`);
    assert.match(`${res.stdout}${res.stderr}`, /Unknown flag/i, `${hatch} must be an UNKNOWN flag, not a silently honored one`);
  }
});

test("council build refuses an INVALID PlanSpec (fail-closed — nothing is built)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-"));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, steps: [] }), "utf8");
  try {
    const res = spawnSync(process.execPath, [COMPANION, "build", "--from", path.relative(dir, bad)], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(res.status, 0);
    assert.match(`${res.stdout}${res.stderr}`, /INVALID|not valid|must stay|not a git/i, "an invalid plan never reaches the build engine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the REAL build wiring (adapters) ---------------------------------------------------------

/** A minimal PlanSpec that passes validatePlanSpec against an empty work dir (both files absent). */
function validPlanSpec(baseCommit, request = "add a tiny helper module") {
  const requestHash = createHash("sha256").update(request.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
  return {
    schemaVersion: 1,
    request,
    requestHash,
    baseCommit,
    steps: [
      {
        id: "step-one",
        title: "Add the helper",
        intent: "Create a helper module exposing one pure function.",
        files: [
          { path: "src/helper.mjs", action: "create", role: "source", intent: "the helper implementation" },
          { path: "tests/helper.test.mjs", action: "create", role: "test", intent: "pins the helper behaviour" }
        ],
        test: { files: ["tests/helper.test.mjs"], intent: "the helper returns the expected value" }
      }
    ],
    risks: [],
    testStrategy: { perStep: "full", final: "full" }
  };
}

test("council build --dry-run spends nothing and reports the §6 seat readiness", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    const env = { ...baseEnv, CLAUDE_BIN: fakeClaudeBin };
    fs.writeFileSync(path.join(workDir, "plan.json"), JSON.stringify(validPlanSpec("a".repeat(40))), "utf8");
    const res = spawnSync(process.execPath, [COMPANION, "build", "--from", "plan.json", "--dry-run"], {
      cwd: workDir,
      env,
      encoding: "utf8",
      timeout: 60_000
    });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    // The unshrinkable build council is listed by seat (never the internal `reasons` key), and with
    // every seat forced unreachable the dry run must say the real build would refuse to start.
    assert.match(res.stdout, /§6 required seats: codex, grok, claude — NOT all reachable \(build would refuse to start\)/);
    assert.match(res.stdout, /nothing was built and no model was called/);
  });
});

test("council build refuses when HEAD does not match the plan's baseCommit (before any model spend)", (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-build-repo-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-build-state-"));
  try {
    const git = (...args) => spawnSync("git", args, { cwd: workDir, encoding: "utf8", timeout: 30_000 });
    const init = git("init");
    if (init.error || init.status !== 0) {
      t.skip("git is unavailable in this environment");
      return;
    }
    // Everything (plan, policy, fake claude bin) is written BEFORE the commit so the tree is clean
    // and the refusal under test is specifically the baseCommit binding, not the dirty-tree gate.
    fs.writeFileSync(path.join(workDir, "index.mjs"), "export const value = 1;\n", "utf8");
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    fs.writeFileSync(path.join(workDir, "plan.json"), JSON.stringify(validPlanSpec("a".repeat(40))), "utf8");
    git("add", "-A");
    const commit = git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init", "--no-verify");
    if (commit.error || commit.status !== 0) {
      t.skip(`git commit is unavailable in this environment (${commit.stderr})`);
      return;
    }
    const res = spawnSync(process.execPath, [COMPANION, "build", "--from", "plan.json"], {
      cwd: workDir,
      env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: fakeClaudeBin },
      encoding: "utf8",
      timeout: 60_000
    });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, "a baseCommit-drifted plan must not exit 0");
    assert.match(
      `${res.stdout}${res.stderr}`,
      /REFUSED at preflight[\s\S]*does not match the plan's baseCommit/,
      "the plan was made against a different tree — build must refuse at preflight, spending nothing"
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the authored-test runner rejects a NON-assertion failure as an invalid RED", async () => {
  // main() is entry-guarded, so a direct import runs no CLI — the classification is a pure export.
  const { classifyAuthoredTestRun } = await import(pathToFileURL(COMPANION).href);

  // A passing run is GREEN, never an assertion failure.
  const green = classifyAuthoredTestRun({ status: 0, timedOut: false, stdout: "ok 1 - x", stderr: "" });
  assert.equal(green.ok, true);
  assert.equal(green.assertionFailure, false);

  // A genuine assertion-level failure IS a valid RED.
  const red = classifyAuthoredTestRun({
    status: 1,
    timedOut: false,
    stdout: "not ok 1 - helper\n  ---\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  ...",
    stderr: ""
  });
  assert.equal(red.ok, false);
  assert.equal(red.assertionFailure, true, "an ERR_ASSERTION failure is the one valid RED");

  // Syntax / loader / crash / timeout failures prove nothing — they must NOT count as RED.
  for (const invalid of [
    { status: 1, timedOut: false, stdout: "", stderr: "SyntaxError: Unexpected token ')'" },
    { status: 1, timedOut: false, stdout: "", stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './missing.mjs'" },
    { status: 1, timedOut: false, stdout: "", stderr: "ReferenceError: foo is not defined" },
    { status: 124, timedOut: true, stdout: "", stderr: "[timed out after 1000ms]" },
    // Ambiguity fails closed: an assertion marker alongside a crash marker is still not a valid RED.
    { status: 1, timedOut: false, stdout: "AssertionError: nope", stderr: "SyntaxError: also broken" }
  ]) {
    const r = classifyAuthoredTestRun(invalid);
    assert.equal(r.ok, false);
    assert.equal(r.assertionFailure, false, `must reject as invalid RED: ${JSON.stringify(invalid).slice(0, 80)}`);
  }
});

test("finding 7: endlessRunOk maps a clean convergence to ok and an error/did-not-run/failed stop to NOT ok", async () => {
  const { endlessRunOk } = await import(pathToFileURL(COMPANION).href);
  // Clean convergences → ok (the endless dashboard is green).
  for (const clean of [
    "reached max passes (10)",
    "budget exhausted (60/60 agent calls)",
    "diminishing returns — 2 consecutive passes found nothing new",
    null,
    undefined
  ]) {
    assert.equal(endlessRunOk(clean), true, `clean stop should be ok: ${clean}`);
  }
  // A dead run (review error / did-not-run / failed) → NOT ok, so watch never shows it green.
  for (const bad of [
    "review error on pass 3: seat exploded",
    "review did not run on pass 1 (backends unavailable or rate-limited)",
    "the review FAILED to produce output",
    "unexpected Error mid-pass"
  ]) {
    assert.equal(endlessRunOk(bad), false, `dead-run stop should be NOT ok: ${bad}`);
  }
});

// --- M9 `audit fix --structure-auto-apply` CLI contracts --------------------------------------
// The structure transform commits MULTI-FILE consolidations autonomously, so its CLI door is
// pinned here at the subprocess boundary: the flag must parse + warn loudly; WITHOUT it the
// default path must stay transform-free; WITH it the transform runner must actually be reached
// (and fail CLOSED when no seat can plan); and the flag must never imply the §6 sensitive consent.

/** A git-repo workDir with one committed source file, a DETECTABLE test command (so `audit fix`'s
 *  mandatory test gate is satisfied — the CLI has no --allow-untested escape hatch), EVERY seat forced
 *  unreachable, and a --from findings file — the cheapest real substrate runAuditFix's M9 structure
 *  pass runs on. The test script is never actually executed (no reachable seat → no patch → no gate
 *  run). Returns null (→ caller skips) when git is unavailable in this environment. */
function makeStructureFixRepo(findings) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-cli-"));
  const git = (...args) => spawnSync("git", args, { cwd: workDir, encoding: "utf8", timeout: 30_000 });
  const init = git("init");
  if (init.error || init.status !== 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(workDir, "index.mjs"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(workDir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }), "utf8");
  const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
  fs.writeFileSync(path.join(workDir, "findings.json"), JSON.stringify(findings), "utf8");
  git("add", "-A");
  const commit = git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init", "--no-verify");
  if (commit.error || commit.status !== 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  return { workDir, fakeClaudeBin };
}

/** A structural (architecture_ssot, cross-cutting) finding — the class the M9 pass consumes. */
function structuralFinding(overrides = {}) {
  return {
    severity: "P1",
    scope: "cross-cutting",
    lens: "architecture_ssot",
    category: "maintainability",
    file: "index.mjs",
    title: "duplicate constant should live in one module",
    detail: "the same constant is defined in two places",
    ...overrides
  };
}

/** Spawn single-shot `audit fix --from findings.json --json [...extraArgs]` (the repo carries a
 *  detectable test command, so no --allow-untested escape hatch is needed to reach the fix engine). */
function runStructureFixCli(repo, extraArgs) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-state-"));
  try {
    return spawnSync(
      process.execPath,
      [COMPANION, "audit", "fix", "--from", "findings.json", "--json", ...extraArgs],
      {
        cwd: repo.workDir,
        env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaudeBin },
        encoding: "utf8",
        timeout: 120_000
      }
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("audit fix --structure-auto-apply is a KNOWN flag and warns LOUDLY (M9 CLI door)", (t) => {
  const repo = makeStructureFixRepo([]);
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  try {
    const res = runStructureFixCli(repo, ["--structure-auto-apply"]);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(`${res.stdout}${res.stderr}`, /Unknown flag/i, "--structure-auto-apply must parse on `audit fix`");
    assert.match(res.stderr, /structure auto-apply ENABLED/i, "the autonomy warning must be printed loudly at startup");
    assert.match(res.stderr, /does NOT imply --sensitive-auto-apply/, "the warning must state the double-consent boundary");
  } finally {
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

test("WITHOUT --structure-auto-apply no structure transform is attempted (default path unchanged)", (t) => {
  const repo = makeStructureFixRepo([structuralFinding()]);
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  try {
    const res = runStructureFixCli(repo, []);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /structure auto-apply ENABLED/i, "no consent → no autonomy warning");
    const out = JSON.parse(res.stdout);
    const entry = (out.rejected ?? []).find((r) => r.finding?.lens === "architecture_ssot");
    assert.ok(entry, "the structural finding stays a visible proposal");
    assert.doesNotMatch(String(entry.reason ?? ""), /structure transform/, "without the flag the transform must never even be attempted");
    assert.equal((out.fixed ?? []).length, 0, "nothing may be applied on the default path");
  } finally {
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

test("WITH --structure-auto-apply the M9 transform is REACHED end-to-end from the CLI (and fails CLOSED without seats)", (t) => {
  const repo = makeStructureFixRepo([structuralFinding()]);
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  try {
    const res = runStructureFixCli(repo, ["--structure-auto-apply"]);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    const entry = (out.rejected ?? []).find((r) => r.finding?.lens === "architecture_ssot");
    assert.ok(entry, "the finding is surfaced, not dropped");
    // The appended reason is emitted ONLY by runAuditFix's M9 structure pass after the injected
    // runStructureTransform returned — i.e. the CLI wiring reached structure-wiring's gate ladder,
    // which then failed CLOSED at the plan gate (every seat is unreachable → null plan).
    assert.match(String(entry.reason ?? ""), /structure transform not applied/, "the transform path must actually run under the flag");
    assert.equal((out.fixed ?? []).length, 0, "no reachable seat → no plan → nothing may be applied");
    assert.notEqual(out.stranded, true, "the failed transform must leave a restored tree");
  } finally {
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

test("--structure-auto-apply does NOT imply --sensitive-auto-apply (double consent enforced end-to-end)", (t) => {
  const repo = makeStructureFixRepo([structuralFinding({ category: "auth", title: "duplicated auth check should live in one module" })]);
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  try {
    const res = runStructureFixCli(repo, ["--structure-auto-apply"]);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    const entry = (out.rejected ?? []).find((r) => r.finding?.lens === "architecture_ssot");
    assert.ok(entry, "the structural+sensitive finding stays a visible proposal");
    assert.match(
      String(entry.reason ?? ""),
      /sensitiveAutoApply/,
      "a structural finding that is ALSO §6-sensitive must demand the SECOND consent, not ride on --structure-auto-apply alone"
    );
    assert.equal((out.fixed ?? []).length, 0, "nothing may be applied under single consent");
  } finally {
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

// --- --pause-at-5h: the exit-75 pause CONTRACT + the resume-safety guard at the CLI boundary --------

test("buildPausePayload emits the versioned council.pause.v1 contract (schedulable → pause_requested)", async () => {
  // main() is entry-guarded, so a direct import runs no CLI — the payload builder is a pure export.
  const { buildPausePayload } = await import(pathToFileURL(COMPANION).href);
  const out = {
    branch: "council/audit-fix-42",
    passesRun: 3,
    pause: {
      schedulable: true,
      resumeAt: "2026-07-13T02:02:00Z",
      threshold: 85,
      autonomous: false,
      pauseId: "abc123",
      blockers: [{ model: "claude", percent: 92, threshold: 85, resetsAt: "2026-07-13T02:00:00Z" }]
    }
  };
  const p = buildPausePayload(out, { baseBranch: "master", cwd: "/repo", argv: ["fix", "--loop", "--pause-at-5h", "85"], observedAt: "2026-07-13T00:00:00Z" });
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.event, "council.pause.v1");
  assert.equal(p.state, "pause_requested", "a schedulable pause is a pause_requested");
  assert.equal(p.reason, "quota_5h");
  assert.equal(p.runId, "council/audit-fix-42");
  assert.equal(p.pauseId, "abc123");
  assert.equal(p.pass, 3);
  assert.deepEqual(p.checkpoint, { branch: "council/audit-fix-42", base: "master" });
  assert.deepEqual(p.blockers, [{ model: "claude", usedPercent: 92, threshold: 85, resetsAt: "2026-07-13T02:00:00Z" }], "percent is surfaced as usedPercent");
  assert.equal(p.resumeAt, "2026-07-13T02:02:00Z");
  assert.equal(p.observedAt, "2026-07-13T00:00:00Z");
  assert.equal(p.resume.cwd, "/repo");
  assert.deepEqual(p.resume.argv, ["audit", "fix", "--loop", "--pause-at-5h", "85", "--resume"], "the resume argv re-invokes with --resume appended");
});

test("buildPausePayload marks an UNSCHEDULABLE pause as manual_stop and never duplicates an existing --resume", async () => {
  const { buildPausePayload } = await import(pathToFileURL(COMPANION).href);
  const out = { branch: "council/audit-fix-7", passesRun: 1, pause: { schedulable: false, resumeAt: null, threshold: 85, autonomous: true, pauseId: "z", blockers: [{ model: "codex", percent: 99, threshold: 85, resetsAt: null }] } };
  const p = buildPausePayload(out, { baseBranch: "main", cwd: "/w", argv: ["fix", "--loop", "--resume"] });
  assert.equal(p.state, "manual_stop", "an unschedulable pause is a manual stop (still exit 75; state distinguishes it)");
  assert.equal(p.resumeAt, null);
  assert.equal(p.blockers[0].usedPercent, 99);
  assert.deepEqual(p.resume.argv, ["audit", "fix", "--loop", "--resume"], "an already-present --resume is not doubled (idempotent)");
});

// --- B (codex-5): a paused run is NOT finalized as done+ok on the dashboard --------------------------

test("B: finalizeLoopReporter records a paused run as a distinct 'paused' phase, NEVER done+ok", async () => {
  const { finalizeLoopReporter } = await import(pathToFileURL(COMPANION).href);
  const reporter = makeProgressReporter({ kind: "audit-fix-loop", stateDir: null });
  const out = {
    stopReason: "quota-pause: claude 5h 92%≥85% — resume 2026-07-13T02:02:00Z",
    pause: { schedulable: true, resumeAt: "2026-07-13T02:02:00Z", blockers: [], pauseId: "x" }
  };
  // The caller passes ok:true (the fix path's !stranded && !crashed) — the helper must OVERRIDE it for a pause.
  finalizeLoopReporter(reporter, out, { ok: true, stopReason: out.stopReason });
  const s = reporter.snapshot();
  assert.notDeepEqual({ done: s.done, ok: s.ok }, { done: true, ok: true }, "a paused run must never be recorded done+ok");
  assert.notEqual(s.ok, true, "not finished-green");
  assert.equal(s.phase, "paused", "the dashboard shows the run as SUSPENDED, not completed");
  assert.equal(s.stopReason, out.stopReason);
});

test("B: finalizeLoopReporter finalizes a NON-paused run done with the caller's ok (unchanged behaviour)", async () => {
  const { finalizeLoopReporter } = await import(pathToFileURL(COMPANION).href);
  const reporter = makeProgressReporter({ kind: "audit-endless", stateDir: null });
  finalizeLoopReporter(reporter, { stopReason: "reached max passes (3)" }, { ok: true, stopReason: "reached max passes (3)" });
  const s = reporter.snapshot();
  assert.equal(s.done, true);
  assert.equal(s.ok, true);
  assert.equal(s.phase, "done");
  assert.equal(s.stopReason, "reached max passes (3)");
});

// --- E (grok-thrash): the pause payload/emitter distinguishes a thrash stop from an unschedulable one --

test("E: buildPausePayload carries a `thrash` flag (thrash vs unschedulable-timestamp are both manual_stop)", async () => {
  const { buildPausePayload } = await import(pathToFileURL(COMPANION).href);
  const thrash = buildPausePayload(
    { branch: "b", passesRun: 2, pause: { schedulable: false, thrash: true, resumeAt: null, blockers: [], pauseId: "t" } },
    { baseBranch: "m", cwd: "/w", argv: ["fix", "--loop"] }
  );
  assert.equal(thrash.state, "manual_stop");
  assert.equal(thrash.thrash, true, "a thrash stop is flagged in the machine payload");
  const unsched = buildPausePayload(
    { branch: "b", passesRun: 1, pause: { schedulable: false, resumeAt: null, blockers: [], pauseId: "u" } },
    { baseBranch: "m", cwd: "/w", argv: ["fix", "--loop"] }
  );
  assert.equal(unsched.state, "manual_stop");
  assert.equal(unsched.thrash, false, "a plain unschedulable-timestamp stop is NOT a thrash");
  const sched = buildPausePayload(
    { branch: "b", passesRun: 1, pause: { schedulable: true, resumeAt: "2026-07-13T02:02:00Z", blockers: [], pauseId: "s" } },
    { baseBranch: "m", cwd: "/w", argv: [] }
  );
  assert.equal(sched.thrash, false, "a schedulable pause is not a thrash either");
});

// --- F (grok-hint): the human resume hint reuses the run's ORIGINAL flags (== JSON resume.argv) -------

test("F: buildResumeArgv reuses the original audit argv + --resume, and is the SSOT for both hint + JSON", async () => {
  const { buildResumeArgv, buildPausePayload } = await import(pathToFileURL(COMPANION).href);
  const argv = ["fix", "--loop", "--usage-ceiling", "40/50/40", "--max-passes", "9"];
  assert.deepEqual(
    buildResumeArgv(argv),
    ["audit", "fix", "--loop", "--usage-ceiling", "40/50/40", "--max-passes", "9", "--resume"],
    "the run's original flags are preserved and --resume appended (not the flag-less hint of before)"
  );
  // The human hint (emitPauseContract builds `node <self> <buildResumeArgv...>`) and the JSON resume.argv
  // now derive from ONE function — so a copied stderr line matches the machine contract exactly.
  const p = buildPausePayload(
    { branch: "b", passesRun: 1, pause: { schedulable: true, resumeAt: "t", blockers: [], pauseId: "x" } },
    { baseBranch: "m", cwd: "/w", argv }
  );
  assert.deepEqual(p.resume.argv, buildResumeArgv(argv), "machine resume.argv and the human hint share one source (SSOT)");
  assert.deepEqual(
    buildResumeArgv(["endless", "--pause-at-5h", "auto:90"]),
    ["audit", "endless", "--pause-at-5h", "auto:90", "--resume"],
    "the endless subcommand's flags are preserved too"
  );
  assert.deepEqual(buildResumeArgv(["fix", "--loop", "--resume"]), ["audit", "fix", "--loop", "--resume"], "an existing --resume is idempotent");
});

// --- `audit endless` accepts + normalizes the two quota-guard flags at the CLI boundary -------------
// The endless block's reviewer preflight throws BEFORE any spend when no seat is reachable, so a spawn
// with all seats forced unreachable proves the flags PARSE and the endless path is reached — a bare
// `--usage-ceiling`/`--pause-at-5h` normalized to `=` (not a "Missing value" parse error), a valued
// `50/50/50` / `auto:90` accepted (not an unknown/invalid-value error). The parse→thread→honour path
// itself is proven end-to-end at the library level in tests/audit-endless-usage.test.mjs.
test("audit endless: valued --usage-ceiling 50/50/50 + --pause-at-5h auto:90 parse (reach the reviewer preflight)", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    const env = { ...baseEnv, CLAUDE_BIN: fakeClaudeBin };
    const res = spawnSync(process.execPath, [COMPANION, "audit", "endless", "--usage-ceiling", "50/50/50", "--pause-at-5h", "auto:90"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) { t.skip("spawn blocked in this sandbox"); return; }
    const err = String(res.stderr ?? "");
    assert.match(err, /no callable reviewers/, "the flags parsed; endless reached its reviewer preflight");
    assert.doesNotMatch(err, /Missing value|Unknown option|must be between|must be one of/, "no parse/validation error on the guard flags");
    assert.notEqual(res.status, 0);
  });
});

test("audit endless: BARE --usage-ceiling + --pause-at-5h are normalized (no 'Missing value' parse error)", (t) => {
  withCli((workDir, baseEnv) => {
    const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
    const env = { ...baseEnv, CLAUDE_BIN: fakeClaudeBin };
    const res = spawnSync(process.execPath, [COMPANION, "audit", "endless", "--usage-ceiling", "--pause-at-5h"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) { t.skip("spawn blocked in this sandbox"); return; }
    const err = String(res.stderr ?? "");
    assert.doesNotMatch(err, /Missing value for --usage-ceiling|Missing value for --pause-at-5h/, "the bare-flag → `=` normalization applies to the endless path too");
    assert.match(err, /no callable reviewers/);
  });
});

test("audit fix --loop --resume FAILS CLOSED on a dirty tree (resume_blocked, tree left untouched)", (t) => {
  // The LOAD-BEARING resume-safety guard: a user who edited during a pause must never have their work
  // stashed/reset/overwritten. A dirty tree on --resume prints resume_blocked and exits non-zero, and
  // the uncommitted file is left EXACTLY as-is.
  const repo = makeStructureFixRepo([]); // committed index.mjs + every seat unreachable
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  const indexPath = path.join(repo.workDir, "index.mjs");
  const dirty = "export const value = 999; // uncommitted work the user is mid-edit on\n";
  fs.writeFileSync(indexPath, dirty, "utf8"); // dirty the tree AFTER the commit
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-resume-state-"));
  try {
    const res = spawnSync(
      process.execPath,
      [COMPANION, "audit", "fix", "--loop", "--resume", "--json"],
      { cwd: repo.workDir, env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaudeBin }, encoding: "utf8", timeout: 120_000 }
    );
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, "a dirty resume must exit non-zero (fail closed), never silently proceed");
    assert.match(`${res.stdout}${res.stderr}`, /resume_blocked/, "it prints the explicit resume_blocked contract");
    assert.equal(fs.readFileSync(indexPath, "utf8"), dirty, "the user's uncommitted work is left EXACTLY as-is — no stash/reset/checkout");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

test("council build binds the plan to the operator's request when one is given (council final Codex P2)", () => {
  // With a positional request, validatePlanSpec's expectedRequest binding must reject a plan whose
  // request differs — otherwise the operator builds a plan for a DIFFERENT request than they typed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-plan-"));
  const spec = {
    schemaVersion: 1,
    request: "add a widget",
    requestHash: "0".repeat(64), // wrong on purpose — the binding must catch the mismatch
    baseCommit: "a".repeat(40),
    steps: [{ id: "s", title: "t", intent: "i", files: [{ path: "lib/w.mjs", action: "create", role: "source", intent: "x" }, { path: "tests/w.test.mjs", action: "create", role: "test", intent: "y" }], test: { files: ["tests/w.test.mjs"], intent: "z" }, dependsOn: [] }],
    risks: [], testStrategy: { perStep: "full", final: "full" }
  };
  const p = path.join(dir, "plan.json");
  fs.writeFileSync(p, JSON.stringify(spec), "utf8");
  try {
    // operator asks for something ELSE than the plan's request → refused before anything is built
    const res = spawnSync(process.execPath, [COMPANION, "build", "--from", path.relative(dir, p), "build me a rocket"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(res.status, 0);
    assert.match(`${res.stdout}${res.stderr}`, /INVALID|request|not a git/i, "a request mismatch (or the invalid hash) is caught before the build engine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// `review --mode` consolidation (surface-only). The internal protocol machinery
// is untouched — these pin the mode RESOLUTION, the conflict rejection, and that
// the persisted job.kind on disk is byte-identical to the pre-consolidation verbs.
// ---------------------------------------------------------------------------

// Read every persisted council job under a state root (files live in <stateRoot>/<slug-hash>/jobs/*.json).
// Restricting to files whose parent dir is "jobs" avoids picking up progress.json / other state files.
function readCouncilJobs(stateRoot) {
  const jobs = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (path.basename(dir) === "jobs" && e.name.endsWith(".json")) {
        try {
          jobs.push(JSON.parse(fs.readFileSync(p, "utf8")));
        } catch {
          /* a file caught mid atomic-rename — skip; kind is stable across the rename anyway */
        }
      }
    }
  };
  walk(stateRoot);
  return jobs;
}

test("resolveReviewMode: verb aliases and --mode resolve to the right protocol booleans", async () => {
  const { resolveReviewMode } = await import(pathToFileURL(COMPANION).href);
  // Bare review verb (both params false, no --mode) => quick — the byte-identical CLI default.
  assert.deepEqual(resolveReviewMode({}), { mode: "quick", adversarial: false, deliberate: false });
  // The alias verbs keep resolving to their own mode (dispatch unchanged).
  assert.equal(resolveReviewMode({ deliberate: true }).mode, "deliberate");
  assert.equal(resolveReviewMode({ adversarial: true }).mode, "adversarial");
  // --mode on the neutral review verb selects freely and derives the booleans the rest of handleReview uses.
  assert.deepEqual(resolveReviewMode({ modeOption: "deliberate" }), { mode: "deliberate", adversarial: false, deliberate: true });
  assert.deepEqual(resolveReviewMode({ modeOption: "adversarial" }), { mode: "adversarial", adversarial: true, deliberate: false });
  assert.equal(resolveReviewMode({ modeOption: "quick" }).mode, "quick");
  // An equivalent/duplicate selector is fine (no throw), and case/whitespace tolerant.
  assert.equal(resolveReviewMode({ deliberate: true, modeOption: "deliberate" }).mode, "deliberate");
  assert.equal(resolveReviewMode({ modeOption: " Deliberate " }).mode, "deliberate");
});

test("resolveReviewMode: a --mode disagreeing with the verb alias throws, naming the conflict", async () => {
  const { resolveReviewMode } = await import(pathToFileURL(COMPANION).href);
  assert.throws(() => resolveReviewMode({ deliberate: true, modeOption: "adversarial" }), /Conflicting review mode.*deliberate.*adversarial/s);
  assert.throws(() => resolveReviewMode({ adversarial: true, modeOption: "quick" }), /Conflicting review mode.*adversarial.*quick/s);
  assert.throws(() => resolveReviewMode({ adversarial: true, modeOption: "deliberate" }), /Conflicting review mode/);
});

test("resolveReviewMode: an unknown --mode throws with the allowed list", async () => {
  const { resolveReviewMode } = await import(pathToFileURL(COMPANION).href);
  assert.throws(() => resolveReviewMode({ modeOption: "wat" }), /Invalid --mode "wat".*quick, deliberate, adversarial/s);
});

test("resolveReviewMode is pure — sequential calls with different modes do not leak state", async () => {
  const { resolveReviewMode } = await import(pathToFileURL(COMPANION).href);
  const a = resolveReviewMode({ modeOption: "deliberate" });
  const b = resolveReviewMode({ modeOption: "adversarial" });
  const c = resolveReviewMode({});
  assert.equal(a.mode, "deliberate");
  assert.equal(b.mode, "adversarial");
  assert.equal(c.mode, "quick");
});

test("incompatibleReviewFlags: deliberate-only flags are flagged only outside deliberate mode", async () => {
  const { incompatibleReviewFlags } = await import(pathToFileURL(COMPANION).href);
  assert.deepEqual(incompatibleReviewFlags("deliberate", { "debate-rounds": "2", resume: true }), []);
  assert.deepEqual(incompatibleReviewFlags("quick", { "debate-rounds": "2", resume: true }), ["debate-rounds", "resume"]);
  assert.deepEqual(incompatibleReviewFlags("adversarial", { "budget-guard": "80" }), ["budget-guard"]);
  assert.deepEqual(incompatibleReviewFlags("quick", {}), []);
});

test("CLI: a --mode conflicting with the verb alias is rejected before any job is created", (t) => {
  withCli((workDir, baseEnv) => {
    const res = spawnSync(process.execPath, [COMPANION, "deliberate", "--mode", "adversarial", "--background", "--json"], {
      cwd: workDir,
      env: baseEnv,
      encoding: "utf8",
      timeout: 30_000
    });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, "a mode conflict must fail loud (non-zero exit)");
    assert.match(res.stderr, /Conflicting review mode/);
    assert.equal(readCouncilJobs(baseEnv.AGENT_COUNCIL_STATE_DIR).length, 0, "no job file may be persisted on a rejected mode");
  });
});

test("CLI: an invalid --mode is rejected with the allowed list, no job created", (t) => {
  withCli((workDir, baseEnv) => {
    const res = spawnSync(process.execPath, [COMPANION, "review", "--mode", "wat", "--background", "--json"], {
      cwd: workDir,
      env: baseEnv,
      encoding: "utf8",
      timeout: 30_000
    });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Invalid --mode "wat".*quick, deliberate, adversarial/s);
    assert.equal(readCouncilJobs(baseEnv.AGENT_COUNCIL_STATE_DIR).length, 0);
  });
});

// The --background path spawns a DETACHED worker whose cwd is the temp workDir; on Windows that briefly
// locks the dir, so an immediate recursive rmdir hits EBUSY. Cleanup is best-effort (retry with a short
// sleep, then give up — the OS reaps %TEMP%). Never throws, so a green test can't be turned red by cleanup.
function rmBestEffort(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err && (err.code === "EBUSY" || err.code === "ENOTEMPTY" || err.code === "EPERM")) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // ~50ms; let the detached worker exit
        continue;
      }
      return; // any other error: leave the temp dir for the OS
    }
  }
}

test("CLI: persisted job.kind is unchanged — bare review=review, --mode maps 1:1, alias verb still stores deliberate", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-cli-state-"));
  const workDir = makeWorkDir();
  // reviewers:[claude] + a CLAUDE_BIN that exits non-zero ⇒ every seat unreachable, so any spawned
  // background worker fails fast (no real Codex/Grok/Claude call). The kind is persisted by the PARENT
  // at job-creation time — before and independent of the worker — so this reads it straight off disk.
  const fakeClaudeBin = makeAllSeatsUnreachable(workDir);
  const env = { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: fakeClaudeBin };
  try {
    const kindFor = (args) => {
      const res = spawnSync(process.execPath, [COMPANION, ...args, "--background", "--json"], {
        cwd: workDir,
        env,
        encoding: "utf8",
        timeout: 30_000
      });
      if (isSandboxBlocked(res)) return { skip: true };
      let jobId = null;
      try {
        jobId = JSON.parse(res.stdout).jobId;
      } catch {
        /* fall back to the newest job below */
      }
      const jobs = readCouncilJobs(stateRoot);
      const job = (jobId && jobs.find((j) => j.id === jobId)) || jobs[jobs.length - 1];
      return { kind: job?.kind };
    };

    const bare = kindFor(["review"]);
    if (bare.skip) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(bare.kind, "review", "the bare review verb still persists kind review (quick)");
    assert.equal(kindFor(["review", "--mode", "deliberate"]).kind, "deliberate", "review --mode deliberate persists kind deliberate");
    assert.equal(kindFor(["review", "--mode", "adversarial"]).kind, "adversarial", "review --mode adversarial persists kind adversarial");
    assert.equal(kindFor(["deliberate"]).kind, "deliberate", "the deliberate alias verb still persists kind deliberate — unchanged on disk");
  } finally {
    rmBestEffort(workDir);
    rmBestEffort(stateRoot);
  }
});
