import test from "node:test";
import assert from "node:assert/strict";

import {
  agentR1States,
  formatDashboard,
  formatDuration,
  isTerminal,
  pipelineLine,
  progressBar,
  summarizeProgress
} from "../plugins/council/scripts/lib/watch.mjs";

const LOG = [
  "Phase: collecting-context",
  "Phase: r1",
  "Phase: r1: grok done (1/2)",
  "Phase: r1: codex done (2/2)",
  "Phase: r1-done",
  "Phase: r2 (2 critiques)",
  "Phase: r2: grok->codex done (1/2)",
  "Deliberation stored (29871 chars)" // NOT a Phase: line - must be ignored
].join("\n");

test("summarizeProgress ignores non-Phase log lines (banners) for lastPhase", () => {
  const p = summarizeProgress(LOG);
  assert.deepEqual([...p.r1Done].sort(), ["codex", "grok"]);
  assert.equal(p.r1Expected, 2);
  assert.equal(p.reachedR2, true);
  assert.equal(p.r2Done, 1);
  assert.equal(p.r2Total, 2);
  assert.equal(p.lastPhase, "r2: grok->codex done (1/2)", "the 'Deliberation stored' banner must not be the phase");
});

test("isTerminal treats cancelled (and any non-active status) as terminal", () => {
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("completed_with_errors"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal(null), false);
});

test("session-backed Claude shows as 'file', not stuck running", () => {
  const midR1 = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)");
  const states = agentR1States(midR1, { claudeBackend: "session", status: "running" });
  assert.equal(states.grok, "done");
  assert.equal(states.codex, "running");
  assert.equal(states.claude, "file", "session Claude never emits r1 done -> file, not running");
});

test("spawn Claude behaves like a normal live agent", () => {
  const midR1 = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/3)");
  const states = agentR1States(midR1, { claudeBackend: "spawn", status: "running" });
  assert.equal(states.claude, "running");
});

test("terminal job reconciles un-acked participating agents to done", () => {
  const partial = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)");
  const states = agentR1States(partial, { claudeBackend: "spawn", status: "completed" });
  assert.equal(states.grok, "done");
  assert.equal(states.codex, "done", "completed job: no explicit line still means done");
  assert.equal(states.claude, "done");
});

test("failed job leaves un-acked agents unknown, not falsely done", () => {
  const partial = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)");
  const states = agentR1States(partial, { claudeBackend: "spawn", status: "failed" });
  assert.equal(states.grok, "done");
  assert.equal(states.codex, "unknown");
});

test("skipped agents win over backend/terminal reconciliation", () => {
  const states = agentR1States(summarizeProgress(LOG), { skipped: ["claude"], status: "completed" });
  assert.equal(states.claude, "skipped");
});

test("progressBar fills proportionally and handles zero total", () => {
  assert.equal(progressBar(1, 2, 4), "##..");
  assert.equal(progressBar(0, 2, 4), "....");
  assert.equal(progressBar(2, 2, 4), "####");
  assert.equal(progressBar(0, 0, 4), "----", "unknown total renders neutral, not a div-by-zero");
});

test("pipelineLine marks the current stage", () => {
  assert.match(pipelineLine("collecting-context", false), /\(\*\) context/);
  assert.match(pipelineLine("r1: grok done (1/2)", false), /\(x\) context {2}> {2}\(\*\) R1/);
  assert.match(pipelineLine("r2 (2 critiques)", false), /\(\*\) R2/);
  assert.match(pipelineLine("anything", true), /\(\*\) done/);
});

test("formatDuration renders seconds and minutes", () => {
  assert.equal(formatDuration(5000), "5s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(-1), "-");
});

test("formatDashboard: terminal snapshot uses finishedAt, shows done + result hint", () => {
  const job = {
    id: "council-abc",
    title: "Council Deliberation",
    kind: "deliberate",
    status: "completed",
    createdAt: "2026-07-10T08:30:00.000Z",
    finishedAt: "2026-07-10T08:33:20.000Z"
  };
  const out = formatDashboard(job, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    etaMs: 180_000,
    skipped: [],
    claudeBackend: "session",
    jobPhase: "done"
  });
  assert.equal(out.terminal, true);
  assert.match(out.text, /elapsed 3m20s/, "elapsed uses finishedAt, not now");
  assert.match(out.text, /phase: done/);
  assert.match(out.text, /Round 2  peer critique/);
  assert.match(out.text, /DONE \(completed\)/);
  assert.match(out.text, /\/council:result council-abc/);
  // No lingering ETA on a finished job:
  assert.doesNotMatch(out.text, /median/);
});

test("formatDashboard: running job shows remaining time, not total median", () => {
  const job = {
    id: "council-xyz",
    title: "Council Deliberation",
    kind: "deliberate",
    status: "running",
    createdAt: "2026-07-10T08:30:00.000Z"
  };
  const out = formatDashboard(job, summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)"), {
    nowMs: Date.parse("2026-07-10T08:32:00.000Z"), // 2 min elapsed
    etaMs: 600_000, // 10 min median -> ~8 min left
    jobPhase: "r1: grok done (1/2)"
  });
  assert.equal(out.terminal, false);
  assert.match(out.text, /~8m00s left \(median 10m00s\)/);
});

test("formatDashboard: over-median running job hints at a slow agent", () => {
  const job = { id: "j", title: "t", kind: "deliberate", status: "running", createdAt: "2026-07-10T08:30:00.000Z" };
  const out = formatDashboard(job, summarizeProgress("Phase: r1"), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"), // 10 min
    etaMs: 180_000, // 3 min median
    jobPhase: "r1"
  });
  assert.match(out.text, /over median 3m00s - a slow agent\?/);
});
