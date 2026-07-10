import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBenchmark, readBenchmarks } from "../plugins/council/scripts/lib/benchmark.mjs";
import { readCachedR1, writeCachedR1 } from "../plugins/council/scripts/lib/resume.mjs";

async function withState(fn) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-rel-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-rel-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    return await fn(workDir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test("R1 resume cache round-trips the grok sessionId (debate_resume after --resume)", async () => {
  await withState((cwd) => {
    const snap = "snap+1234";
    writeCachedR1(cwd, snap, "grok", {
      agent: "grok",
      status: 0,
      stdout: '{"findings":[]}',
      sessionId: "sess-abc-123"
    });
    const cached = readCachedR1(cwd, snap, "grok");
    assert.equal(cached.sessionId, "sess-abc-123");
  });
});

test("benchmark --judge-only supersedes the answer-phase record (no double-count)", async () => {
  await withState(async (cwd) => {
    const task = "Explain caching in one sentence.";
    const taskHash = createHash("sha256").update(task).digest("hex").slice(0, 12);
    const claudeAnswer = path.join(cwd, "claude.md");
    fs.writeFileSync(claudeAnswer, "Caching stores results to avoid recomputation.", "utf8");

    // Answer phase records one line.
    await runBenchmark(cwd, { codex: {}, grok: {} }, {
      focusText: task,
      skipCodex: true,
      skipGrok: true,
      claudeAnswer,
      nowIso: "2026-07-10T00:00:00Z"
    });
    assert.equal(readBenchmarks(cwd).filter((r) => r.taskHash === taskHash).length, 1);

    // Judge-only supersedes -> still exactly one record for this taskHash.
    await runBenchmark(cwd, { codex: {}, grok: {} }, {
      focusText: task,
      skipCodex: true,
      skipGrok: true,
      judgeOnly: true,
      nowIso: "2026-07-10T01:00:00Z"
    });
    const forTask = readBenchmarks(cwd).filter((r) => r.taskHash === taskHash);
    assert.equal(forTask.length, 1, "judge-only replaced, not appended");
    assert.equal(forTask[0].judgeOnly, true);
  });
});
