import test from "node:test";
import assert from "node:assert/strict";

import {
  agentR1States,
  formatDashboard,
  formatDuration,
  summarizeProgress
} from "../plugins/council/scripts/lib/watch.mjs";

const LOG = [
  "Phase: collecting-context",
  "Phase: r1",
  "Phase: r1: grok done (1/3)",
  "Phase: r1: codex done (2/3)",
  "Phase: r1: claude done (3/3)",
  "Phase: r1-done",
  "Phase: r2 (3 critiques)",
  "Phase: r2: grok->claude done (1/3)",
  "Phase: r2: codex->claude done (2/3)"
].join("\n");

test("summarizeProgress derives R1 completions, expected count, and R2 progress", () => {
  const p = summarizeProgress(LOG);
  assert.deepEqual([...p.r1Done].sort(), ["claude", "codex", "grok"]);
  assert.equal(p.r1Expected, 3);
  assert.equal(p.reachedR2, true);
  assert.equal(p.r2Done, 2);
  assert.equal(p.r2Total, 3);
  assert.equal(p.lastPhase, "r2: codex->claude done (2/3)");
});

test("agentR1States: done / running / pending / skipped", () => {
  const midR1 = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/3)");
  const states = agentR1States(midR1, ["codex"]);
  assert.equal(states.grok, "done");
  assert.equal(states.claude, "running", "reached r1 but not done -> running");
  assert.equal(states.codex, "skipped", "not a reviewer");
});

test("agentR1States before R1 starts are all pending", () => {
  const pre = summarizeProgress("Phase: collecting-context");
  const states = agentR1States(pre, []);
  assert.equal(states.grok, "pending");
  assert.equal(states.codex, "pending");
  assert.equal(states.claude, "pending");
});

test("formatDuration renders seconds and minutes", () => {
  assert.equal(formatDuration(5000), "5s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(-1), "-");
  assert.equal(formatDuration(Number.NaN), "-");
});

test("formatDashboard shows agents, R2 line, and a done banner on terminal status", () => {
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
    skipped: []
  });
  assert.equal(out.terminal, true);
  assert.match(out.text, /codex/);
  assert.match(out.text, /Round 2 \(peer critique\): 2\/3/);
  // elapsed uses finishedAt (3m20s), not now:
  assert.match(out.text, /elapsed: 3m20s/);
  assert.match(out.text, /DONE \(completed\)/);
});

test("formatDashboard flags an over-median running job", () => {
  const job = {
    id: "council-xyz",
    title: "Council Deliberation",
    kind: "deliberate",
    status: "running",
    createdAt: "2026-07-10T08:30:00.000Z"
  };
  const out = formatDashboard(job, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"), // 10 min elapsed
    etaMs: 180_000, // 3 min median
    skipped: []
  });
  assert.equal(out.terminal, false);
  assert.match(out.text, /running longer than the 3m00s median/);
});
