import test from "node:test";
import assert from "node:assert/strict";

import {
  agentR1States,
  formatDashboard,
  formatDuration,
  isTerminal,
  progressBar,
  summarizeFindings,
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

const MERGED = {
  all: [
    { severity: "P1", agents: ["codex", "grok"], consensus: true, contested: false },
    { severity: "P1", agents: ["grok"], consensus: false, contested: true },
    { severity: "P2", agents: ["codex", "grok", "claude"], consensus: true, contested: false },
    { severity: "nit", agents: ["claude"], consensus: false, contested: false }
  ]
};

test("summarizeProgress ignores non-Phase banner lines for lastPhase", () => {
  const p = summarizeProgress(LOG);
  assert.deepEqual([...p.r1Done].sort(), ["codex", "grok"]);
  assert.equal(p.r2Done, 1);
  assert.equal(p.r2Total, 2);
  assert.equal(p.lastPhase, "r2: grok->codex done (1/2)");
});

test("isTerminal treats cancelled and any non-active status as terminal", () => {
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal(null), false);
});

test("agentR1States: session Claude is 'file', terminal reconciles, failed is unknown", () => {
  const midR1 = summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)");
  assert.equal(agentR1States(midR1, { claudeBackend: "session" }).claude, "file");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn" }).claude, "running");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn", status: "completed" }).codex, "done");
  assert.equal(agentR1States(midR1, { claudeBackend: "spawn", status: "failed" }).codex, "unknown");
  assert.equal(agentR1States(midR1, { skipped: ["codex"] }).codex, "skipped");
});

test("summarizeFindings counts totals, consensus, contested, per-severity, per-agent raised/shared", () => {
  const f = summarizeFindings(MERGED);
  assert.equal(f.total, 4);
  assert.equal(f.consensus, 2);
  assert.equal(f.unique, 2);
  assert.equal(f.contested, 1);
  assert.deepEqual(f.bySeverity, { P0: 0, P1: 2, P2: 1, nit: 1 });
  assert.deepEqual(f.byAgent.codex, { raised: 2, shared: 2, disputed: 0 });
  assert.deepEqual(f.byAgent.grok, { raised: 3, shared: 2, disputed: 1 });
  assert.deepEqual(f.byAgent.claude, { raised: 2, shared: 1, disputed: 0 });
});

test("summarizeFindings returns null when no merged findings exist yet", () => {
  assert.equal(summarizeFindings(undefined), null);
  assert.equal(summarizeFindings({}), null);
});

test("progressBar fills proportionally and renders neutral on unknown total", () => {
  assert.equal(progressBar(1, 2, 4), "██░░");
  assert.equal(progressBar(2, 2, 4), "████");
  assert.equal(progressBar(0, 0, 4), "░░░░");
});

test("formatDuration renders seconds and minutes", () => {
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(-1), "-");
});

const COMPLETED_JOB = {
  id: "council-abc",
  title: "Council Deliberation",
  kind: "deliberate",
  status: "completed",
  createdAt: "2026-07-10T08:30:00.000Z",
  finishedAt: "2026-07-10T08:33:20.000Z"
};

test("formatDashboard (completed) shows the findings breakdown and a right-aligned box", () => {
  const out = formatDashboard(COMPLETED_JOB, summarizeProgress(LOG), {
    nowMs: Date.parse("2026-07-10T08:40:00.000Z"),
    etaMs: 180_000,
    findings: summarizeFindings(MERGED),
    claudeBackend: "session",
    jobPhase: "done"
  });
  assert.equal(out.terminal, true);
  assert.match(out.text, /council-abc/);
  assert.match(out.text, /claude\s+file/, "session Claude shows as file in the table");
  assert.match(out.text, /disputed/, "table has a disputed column");
  assert.match(out.text, /4 findings\s+│\s+2 consensus\s+│\s+2 unique\s+│\s+1 disputed/);
  assert.match(out.text, /severity\s+P1 2\s+P2 1\s+nit 1/);
  assert.match(out.text, /\/council:result council-abc/);

  // Alignment invariant: every bordered line has the same length.
  const borderLens = new Set(
    out.text.split("\n").filter((l) => /^[║╔╟╠╚]/.test(l)).map((l) => l.length)
  );
  assert.equal(borderLens.size, 1, "all box lines must be equal width");
});

test("formatDashboard (running) shows remaining time and 'pending' findings", () => {
  const job = { id: "council-xyz", title: "Council Deliberation", kind: "deliberate", status: "running", createdAt: "2026-07-10T08:30:00.000Z" };
  const out = formatDashboard(job, summarizeProgress("Phase: r1\nPhase: r1: grok done (1/2)"), {
    nowMs: Date.parse("2026-07-10T08:32:00.000Z"), // 2 min elapsed
    etaMs: 600_000, // 10 min median -> ~8 min left
    findings: null,
    jobPhase: "r1: grok done (1/2)"
  });
  assert.equal(out.terminal, false);
  assert.match(out.text, /~8m00s left/);
  assert.match(out.text, /pending — available/);
});
