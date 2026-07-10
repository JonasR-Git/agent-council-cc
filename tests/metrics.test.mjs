import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aggregateMetrics, readMetrics, recordJobMetrics } from "../plugins/council/scripts/lib/metrics.mjs";

test("recordJobMetrics appends and readMetrics/aggregate summarize", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-metrics-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-metrics-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    recordJobMetrics(workDir, {
      id: "j1",
      kind: "deliberate",
      status: "completed",
      createdAt: "2026-07-10T00:00:00Z",
      finishedAt: "2026-07-10T00:04:00Z",
      results: [
        { agent: "codex", role: "r1", status: 0, durationMs: 360000 },
        { agent: "grok", role: "r1", status: 0, durationMs: 180000 },
        { agent: "grok", aboutAgent: "codex", role: "peer", status: 0, durationMs: 90000 },
        { agent: "codex", skipped: true }
      ]
    });
    recordJobMetrics(workDir, {
      id: "j2",
      kind: "deliberate",
      status: "completed_with_errors",
      createdAt: "2026-07-10T01:00:00Z",
      finishedAt: "2026-07-10T01:06:00Z",
      results: [{ agent: "codex", role: "r1", status: 124, durationMs: 1800000, timedOut: true }]
    });

    const entries = readMetrics(workDir, 0);
    assert.equal(entries.length, 2);

    const agg = aggregateMetrics(entries);
    assert.equal(agg.jobs, 2);
    assert.equal(agg.kinds.deliberate.jobs, 2);
    assert.equal(agg.kinds.deliberate.avgWallClockMs, 300000);
    assert.equal(agg.agents.codex.calls, 2);
    assert.equal(agg.agents.codex.failures, 1);
    assert.equal(agg.agents.codex.timeouts, 1);
    assert.equal(agg.agents.grok.calls, 2);
    assert.equal(agg.agents.grok.avgDurationMs, 135000);
    assert.equal(agg.agents.grok.medianDurationMs, 135000);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("readMetrics tolerates a missing store", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "council-metrics-empty-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "council-metrics-nostore-"));
  try {
    assert.deepEqual(readMetrics(empty, 0), []);
    assert.equal(aggregateMetrics([]).jobs, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
