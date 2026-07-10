import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runBenchmark, readBenchmarks } from "../plugins/council/scripts/lib/benchmark.mjs";
import { readCachedR1, writeCachedR1 } from "../plugins/council/scripts/lib/resume.mjs";
import { writeJobFile } from "../plugins/council/scripts/lib/state.mjs";

const COMPANION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "council",
  "scripts",
  "council-companion.mjs"
);

function fixloopStatus(cwd, stateRoot, jobId, args) {
  const res = spawnSync(process.execPath, [COMPANION, "fixloop-status", jobId, ...args, "--json"], {
    cwd,
    env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot },
    encoding: "utf8"
  });
  return JSON.parse(res.stdout);
}

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

function withFixloopJob(job, run) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-fl-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-fl-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    writeJobFile(workDir, job.id, job); // writes to the companion's resolved jobs dir
    return run(workDir, stateRoot);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test("fixloop-status: writer-only parse glitch does not force incomplete when peers approve", () => {
  const job = {
    id: "council-fl1",
    kind: "deliberate",
    status: "completed_with_errors",
    createdAt: "2026-07-10T00:00:00Z",
    deliberation: {
      verdicts: [
        { agent: "codex", verdict: "approve" },
        { agent: "grok", verdict: "approve_with_nits" },
        { agent: "claude", verdict: "request_changes" }
      ],
      merged: { all: [] }
    }
  };
  withFixloopJob(job, (workDir, stateRoot) => {
    const out = fixloopStatus(workDir, stateRoot, "council-fl1", ["--writer", "claude", "--needed", "2"]);
    assert.equal(out.incomplete, false, "peer council is complete despite writer glitch");
    assert.equal(out.approved, true, "two peer approvals -> approved");
    assert.equal(out.recommendation, "stop-approved");
  });
});

test("fixloop-status: too few peer voters -> incomplete -> escalate", () => {
  const job = {
    id: "council-fl2",
    kind: "deliberate",
    status: "completed",
    createdAt: "2026-07-10T00:00:00Z",
    deliberation: {
      verdicts: [{ agent: "grok", verdict: "approve" }],
      merged: { all: [{ severity: "P1", title: "x", consensus: false, agents: ["grok"] }] }
    }
  };
  withFixloopJob(job, (workDir, stateRoot) => {
    const out = fixloopStatus(workDir, stateRoot, "council-fl2", ["--writer", "claude", "--needed", "2"]);
    assert.equal(out.incomplete, true, "one voter < needed 2 -> incomplete");
    assert.equal(out.recommendation, "stop-escalate-to-human");
  });
});

test("judge-only supersedes only the latest run, keeping earlier history for --stats", async () => {
  await withState(async (cwd) => {
    const task = "Explain memoization in one sentence.";
    const taskHash = createHash("sha256").update(task).digest("hex").slice(0, 12);
    const claudeAnswer = path.join(cwd, "claude.md");
    fs.writeFileSync(claudeAnswer, "Memoization caches function results by input.", "utf8");
    const run = (opts) => runBenchmark(cwd, { codex: {}, grok: {} }, { focusText: task, skipCodex: true, skipGrok: true, ...opts });

    // Month 1: an answer+judge-only pair -> 1 record for this run.
    await run({ claudeAnswer, nowIso: "2026-06-10T00:00:00Z" });
    await run({ judgeOnly: true, nowIso: "2026-06-10T01:00:00Z" });
    // Month 2: a second chronological run of the SAME task.
    await run({ claudeAnswer, nowIso: "2026-07-10T00:00:00Z" });
    await run({ judgeOnly: true, nowIso: "2026-07-10T01:00:00Z" });

    const forTask = readBenchmarks(cwd).filter((r) => r.taskHash === taskHash);
    assert.equal(forTask.length, 2, "two chronological runs both retained");
    assert.ok(forTask.every((r) => r.judgeOnly === true));
  });
});
