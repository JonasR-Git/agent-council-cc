import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aggregateMetrics, readMetrics, recordAuditMetrics, recordJobMetrics } from "../plugins/council/scripts/lib/metrics.mjs";

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

test("aggregateMetrics summarizes review quality + per-agent retries (pure)", () => {
  const entries = [
    {
      kind: "deliberate",
      wallClockMs: 300000,
      agents: [{ agent: "codex", status: 0, retryAttempts: 2 }, { agent: "grok", status: 0, retryAttempts: 1 }],
      review: { findings: 6, mustFix: 2, consensus: 3, contested: 1, parseFailures: 1 }
    },
    {
      kind: "deliberate",
      wallClockMs: 200000,
      agents: [{ agent: "codex", status: 0, retryAttempts: 1 }],
      review: { findings: 4, mustFix: 0, consensus: 1, contested: 0, parseFailures: 0 }
    }
  ];
  const agg = aggregateMetrics(entries);
  assert.equal(agg.review.runs, 2);
  assert.equal(agg.review.avgFindings, 5);
  assert.equal(agg.review.avgMustFix, 1);
  assert.equal(agg.review.consensus, 4);
  assert.equal(agg.review.parseFailures, 1);
  assert.equal(agg.agents.codex.retries, 1, "one retry across codex calls (attempts 2 -> +1)");
  assert.equal(agg.agents.grok.retries, 0);
});

test("recordJobMetrics pulls the review outcome from job.deliberation", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-rev-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-rev-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    const entry = recordJobMetrics(workDir, {
      id: "j1",
      kind: "deliberate",
      status: "completed",
      createdAt: "2026-07-10T00:00:00Z",
      finishedAt: "2026-07-10T00:04:00Z",
      results: [{ agent: "codex", role: "r1", status: 0, durationMs: 1000 }],
      deliberation: {
        merged: { all: [{ severity: "P0", consensus: true }, { severity: "P2", contested: true }] },
        verdicts: [{ agent: "codex", verdict: "block" }],
        verification: { verifiedCount: 1, refutedCount: 0 },
        parseFailures: 2
      }
    });
    assert.equal(entry.review.findings, 2);
    assert.equal(entry.review.mustFix, 1);
    assert.equal(entry.review.consensus, 1);
    assert.equal(entry.review.contested, 1);
    assert.deepEqual(entry.review.verdicts, { codex: "block" });
    assert.deepEqual(entry.review.verify, { verified: 1, refuted: 0 });
    assert.equal(entry.review.parseFailures, 2);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("recordAuditMetrics records a synchronous audit run under an audit-* kind", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-audit-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-audit-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    recordAuditMetrics(workDir, "fix", { wallClockMs: 5000, fixed: 3, failed: 1, ledgerResolved: 3 }, "2026-07-10T00:00:00Z");
    const entries = readMetrics(workDir, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "audit-fix");
    assert.equal(entries[0].audit.fixed, 3);
    assert.equal(entries[0].audit.ledgerResolved, 3);
    assert.equal(aggregateMetrics(entries).kinds["audit-fix"].jobs, 1);
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
