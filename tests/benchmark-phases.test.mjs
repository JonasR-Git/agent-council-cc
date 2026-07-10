import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBenchmark } from "../plugins/council/scripts/lib/benchmark.mjs";
import { resolveStateDir } from "../plugins/council/scripts/lib/state.mjs";

// Backends with both CLIs skipped so no real agent runs; the answer phase then
// only records Claude's answer, and judge-only reloads persisted answers.
const NOOP_BACKENDS = { codex: {}, grok: {} };

test("answer phase persists answers; judge-only reloads them without re-answering", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    const task = "Explain X in one sentence.";
    const taskHash = createHash("sha256").update(task).digest("hex").slice(0, 12);
    const claudeAnswer = path.join(workDir, "claude.md");
    fs.writeFileSync(claudeAnswer, "X is a thing.", "utf8");

    // Answer phase (both CLIs skipped -> only claude answers, persisted).
    const phase1 = await runBenchmark(workDir, NOOP_BACKENDS, {
      focusText: task,
      skipCodex: true,
      skipGrok: true,
      claudeAnswer
    });
    assert.deepEqual(Object.keys(phase1.answers), ["claude"]);
    const persisted = path.join(resolveStateDir(workDir), "benchmark-answers", taskHash, "claude.txt");
    assert.ok(fs.existsSync(persisted), "answer persisted to file");

    // Judge-only phase reloads persisted answers (no re-answer needed).
    const phase2 = await runBenchmark(workDir, NOOP_BACKENDS, {
      focusText: task,
      skipCodex: true,
      skipGrok: true,
      judgeOnly: true
    });
    assert.deepEqual(Object.keys(phase2.answers), ["claude"]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("judge-only without persisted answers fails clearly", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-state2-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-work2-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    await assert.rejects(
      runBenchmark(workDir, NOOP_BACKENDS, { focusText: "unseen task", skipCodex: true, skipGrok: true, judgeOnly: true }),
      /No persisted answers/
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
