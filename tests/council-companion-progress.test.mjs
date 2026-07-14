import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveStateDir } from "../plugins/council/scripts/lib/state.mjs";

// Phase 2 / Task 5+6 (end to end) — the companion actually WIRES the progress reporter (write side) and
// `council watch` renders the universal progress.json when there is no legacy job (read side). Spawns
// the real CLI as a subprocess (the handlers aren't exported), matching council-companion-cli.test.mjs.

const COMPANION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "council", "scripts", "council-companion.mjs");

const isSandboxBlocked = (res) => Boolean(res.error) && (res.error.code === "EPERM" || res.error.code === "ENOENT");

function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-progress-work-"));
  fs.writeFileSync(path.join(dir, "index.mjs"), "export const value = 1;\n", "utf8");
  return dir;
}

// Force every built-in seat inactive (reviewers:[claude] skips codex/grok; a fake claude bin probes
// unavailable) so `audit review` spends NOTHING yet still drives its reporter end to end.
function makeAllSeatsUnreachable(workDir) {
  fs.writeFileSync(path.join(workDir, ".council.yml"), "version: 1\nreviewers: [claude]\n", "utf8");
  const fakeClaudeBin = path.join(workDir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaudeBin, "@echo off\r\nexit /b 1\r\n", "utf8");
  return fakeClaudeBin;
}

function withCli(fn) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-progress-state-"));
  const workDir = makeWorkDir();
  try {
    return fn(workDir, { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot });
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** The exact stateDir the subprocess will resolve for this workDir + state root. */
function stateDirFor(workDir, stateRoot) {
  const prev = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    return resolveStateDir(workDir);
  } finally {
    if (prev === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = prev;
  }
}

const PROGRESS = (over = {}) => ({
  schemaVersion: 1,
  kind: "audit-review",
  jobId: null,
  title: "audit review",
  startedAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:05.000Z",
  phase: "review",
  phaseDetail: "12 units",
  seats: [],
  progress: { unitsDone: 3, unitsTotal: 12 },
  counters: {},
  findingsByLens: { security: { total: 2, P0: 1, P1: 1, P2: 0, nit: 0 } },
  gate: null,
  budget: null,
  etaMs: null,
  recentLines: [],
  done: false,
  ok: null,
  stopReason: null,
  ...over
});

// --- Task 5 (write side): a real command instantiates + reaches the reporter --------------------

test("`review --mode deep` writes the universal progress.json via the wired reporter (no backends needed)", (t) => {
  withCli((workDir, env) => {
    makeAllSeatsUnreachable(workDir);
    const res = spawnSync(process.execPath, [COMPANION, "review", "--mode", "deep"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    // The reporter announced the live dashboard (proves makeRunReporter ran in a non-json run).
    assert.match(res.stderr, /live dashboard: council watch/, "the run announced the live dashboard");

    const file = path.join(stateDirFor(workDir, env.AGENT_COUNCIL_STATE_DIR), "progress.json");
    assert.ok(fs.existsSync(file), "progress.json was written to the workspace state dir");
    const prog = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(prog.kind, "audit-review", "the reporter recorded the audit-review kind");
    assert.equal(prog.done, true, "reporter.done() fired at the end of the run");
    // phase progress was recorded (units were selected even though no reachable seat reviewed them).
    assert.ok(prog.progress && typeof prog.progress.unitsTotal === "number", "unit progress was recorded");
  });
});

// --- Task 6 (read side): `council watch` renders progress.json when there is NO legacy job -------

test("`status --watch --once` renders the universal progress.json as a fallback (no legacy job)", (t) => {
  withCli((workDir, env) => {
    const dir = stateDirFor(workDir, env.AGENT_COUNCIL_STATE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "progress.json"), `${JSON.stringify(PROGRESS({ done: true }))}\n`, "utf8");

    const res = spawnSync(process.execPath, [COMPANION, "status", "--watch", "--once"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /No council jobs found/, "the progress.json fallback replaced the 'no jobs' error");
    assert.match(res.stdout, /audit review|audit-review|review/i, "the progress dashboard rendered from progress.json");
  });
});

test("`status --watch --json` emits the progress dashboard payload from progress.json", (t) => {
  withCli((workDir, env) => {
    const dir = stateDirFor(workDir, env.AGENT_COUNCIL_STATE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "progress.json"), `${JSON.stringify(PROGRESS({ done: true }))}\n`, "utf8");

    const res = spawnSync(process.execPath, [COMPANION, "status", "--watch", "--json"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.kind, "audit-review", "the json fallback reports the run kind");
    assert.equal(payload.done, true);
    assert.ok(typeof payload.dashboard === "string" && payload.dashboard.length > 0, "a rendered dashboard string is included");
  });
});

// --- Finding 9 (write side): a handler that THROWS after makeRunReporter still marks the run done ----

test("finding 9: a run that throws after makeRunReporter still marks progress.json done (watch never hangs on a dead run)", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-progress-abort-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-progress-abort-work-"));
  try {
    fs.writeFileSync(path.join(workDir, "index.mjs"), "export const value = 1;\n", "utf8");
    fs.writeFileSync(path.join(workDir, ".council.yml"), "version: 1\nreviewers: [claude]\n", "utf8");
    const env = { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot };
    // A committed, CLEAN git tree so state resolution keys on this workspace and the handler reaches
    // makeRunReporter (single-shot `fix` announces the run); an escaping --from is then a throw
    // it raises AFTER the reporter exists, so main()'s finally must still mark progress.json terminal.
    const git = (args) => spawnSync("git", args, { cwd: workDir, env, encoding: "utf8", timeout: 30_000 });
    const init = git(["init", "-q"]);
    if (isSandboxBlocked(init) || init.status !== 0) {
      t.skip("git/spawn is unavailable in this sandbox");
      return;
    }
    git(["config", "core.autocrlf", "false"]);
    git(["add", "-A"]);
    const commit = git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
    if (commit.status !== 0) {
      t.skip("git commit unavailable in this sandbox");
      return;
    }

    const res = spawnSync(process.execPath, [COMPANION, "fix", "--from", "../escape.json"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, "the escaping --from fails the command (the throw still propagates to the exit code)");
    assert.match(res.stderr, /must stay within the project root/, "the handler threw its --from confinement error…");
    assert.match(res.stderr, /live dashboard/, "…AFTER makeRunReporter had announced the run (so progress.json exists, done:false at throw time)");

    const file = path.join(stateDirFor(workDir, env.AGENT_COUNCIL_STATE_DIR), "progress.json");
    assert.ok(fs.existsSync(file), "progress.json was written");
    const prog = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(prog.kind, "audit-fix-loop");
    assert.equal(prog.done, true, "main()'s finally marked the aborted run done — watch won't hang on it");
    assert.equal(prog.ok, false, "and NOT ok");
    assert.equal(prog.stopReason, "aborted");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("`status --watch` still errors when there is neither a job NOR a progress.json", (t) => {
  withCli((workDir, env) => {
    const res = spawnSync(process.execPath, [COMPANION, "status", "--watch", "--once"], { cwd: workDir, env, encoding: "utf8", timeout: 60_000 });
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, "no job and no progress.json is still an error");
    assert.match(res.stderr, /No council jobs found/, "the original error is preserved when there is nothing to watch");
  });
});
