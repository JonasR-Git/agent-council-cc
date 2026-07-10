import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aggregateBenchmarks, parseJudgeScore } from "../plugins/council/scripts/lib/benchmark.mjs";

test("parseJudgeScore clamps to 1-10 and extracts rationale", () => {
  assert.deepEqual(parseJudgeScore('{"score": 8, "rationale": "solid"}'), { score: 8, rationale: "solid" });
  assert.deepEqual(parseJudgeScore('prose then {"score": 15, "rationale": "x"}'), { score: 10, rationale: "x" });
  assert.equal(parseJudgeScore('{"score": 0.5}').score, 1);
  assert.equal(parseJudgeScore("no json here"), null);
  assert.equal(parseJudgeScore('{"rationale": "no score"}'), null);
});

test("aggregateBenchmarks computes runs, wins and average per agent", () => {
  const records = [
    { taskHash: "a", ranking: [{ agent: "codex", avgScore: 9 }, { agent: "grok", avgScore: 7 }, { agent: "claude", avgScore: 8 }] },
    { taskHash: "b", ranking: [{ agent: "claude", avgScore: 9 }, { agent: "codex", avgScore: 6 }, { agent: "grok", avgScore: 6 }] }
  ];
  const agg = aggregateBenchmarks(records);
  assert.equal(agg.runs, 2);
  assert.equal(agg.agents.codex.runs, 2);
  assert.equal(agg.agents.codex.wins, 1);
  assert.equal(agg.agents.codex.avgScore, 7.5);
  assert.equal(agg.agents.claude.wins, 1);
  assert.equal(agg.agents.grok.wins, 0);
  assert.equal(agg.agents.grok.avgScore, 6.5);
});

test("readBenchmarks tolerates a missing store", async () => {
  const { readBenchmarks } = await import("../plugins/council/scripts/lib/benchmark.mjs");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-state-"));
  try {
    assert.deepEqual(readBenchmarks(empty), []);
    assert.equal(aggregateBenchmarks([]).runs, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
