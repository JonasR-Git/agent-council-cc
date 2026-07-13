import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// --- M9 `audit fix --structure-auto-apply` CLI contracts --------------------------------------
// The structure transform commits MULTI-FILE consolidations autonomously, so its CLI door is
// pinned here at the subprocess boundary: the flag must parse + warn loudly; WITHOUT it the
// default path must stay transform-free; WITH it the transform runner must actually be reached
// (and fail CLOSED when no seat can plan); and the flag must never imply the §6 sensitive consent.

/** A git-repo workDir with one committed source file, EVERY seat forced unreachable, and a
 *  --from findings file — the cheapest real substrate runAuditFix's M9 structure pass runs on.
 *  Returns null (→ caller skips) when git is unavailable in this environment. */
function makeStructureFixRepo(findings) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-cli-"));
  const git = (...args) => spawnSync("git", args, { cwd: workDir, encoding: "utf8", timeout: 30_000 });
  const init = git("init");
  if (init.error || init.status !== 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(workDir, "index.mjs"), "export const value = 1;\n", "utf8");
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

/** Spawn single-shot `audit fix --from findings.json --allow-untested --json [...extraArgs]`. */
function runStructureFixCli(repo, extraArgs) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-state-"));
  try {
    return spawnSync(
      process.execPath,
      [COMPANION, "audit", "fix", "--from", "findings.json", "--allow-untested", "--json", ...extraArgs],
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
