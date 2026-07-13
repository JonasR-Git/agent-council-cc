import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// council-companion.mjs is a bare CLI entry point (no exports), so these findings can only be pinned
// by spawning it as a subprocess - matching the pattern used by tests/release-fixes.test.mjs,
// tests/phase-d.test.mjs and tests/setup-init.test.mjs (which this file does not modify).

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
