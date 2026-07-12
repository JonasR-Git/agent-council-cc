import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aggregateBenchmarks, parseJudgeScore, runBenchmark } from "../plugins/council/scripts/lib/benchmark.mjs";

// Every seat that is ACTIVE must be benchmarked — the feature exists to compare seat quality, so a
// hardcoded codex+grok pair hid the claude seat and every configured OpenRouter seat.
const ALL_SEAT_BACKENDS = {
  codex: { companionAvailable: true },
  grok: { cli: { available: true } },
  claude: { cli: { available: true } },
  openrouter: { available: true, seats: [{ id: "or-x", model: "vendor/model" }] }
};

const isJudgePrompt = (prompt) => String(prompt).includes("judging an anonymous answer");

/** Injectable seat runners: each seat answers/judges with its OWN name recorded (no CLI, no network). */
function seatDeps(calls) {
  const reply = (seat, prompt) => {
    calls.push({ seat, kind: isJudgePrompt(prompt) ? "judge" : "answer" });
    return isJudgePrompt(prompt)
      ? { agent: seat, status: 0, stdout: '{"score": 7, "rationale": "ok"}' }
      : { agent: seat, status: 0, stdout: `answer by ${seat}` };
  };
  return {
    runCodex: async (p) => reply("codex", p),
    runGrok: async (p) => reply("grok", p),
    runClaude: async (p) => reply("claude", p),
    runOpenRouter: async (_cwd, _backends, _options, p, seatId) => reply(seatId, p)
  };
}

async function withBenchState(run) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-seats-state-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-bench-seats-work-"));
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  process.env.AGENT_COUNCIL_STATE_DIR = stateRoot;
  try {
    return await run(workDir);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test("benchmark runs EVERY active seat: claude and an OpenRouter seat answer and judge too", async () => {
  await withBenchState(async (cwd) => {
    const calls = [];
    const result = await runBenchmark(cwd, ALL_SEAT_BACKENDS, { focusText: "Explain X." }, seatDeps(calls));

    assert.deepEqual(
      Object.keys(result.answers).sort(),
      ["claude", "codex", "grok", "or-x"],
      "the claude seat and the configured OpenRouter seat are benchmarked, not just codex+grok"
    );
    // Every seat answered exactly once, on its OWN runner.
    for (const seat of ["codex", "grok", "claude", "or-x"]) {
      assert.equal(calls.filter((c) => c.seat === seat && c.kind === "answer").length, 1, `${seat} answered once`);
      assert.equal(result.answers[seat], `answer by ${seat}`, `${seat}'s answer came from ${seat}'s runner`);
      // 4 seats -> each answer is judged by the 3 others.
      assert.equal(calls.filter((c) => c.seat === seat && c.kind === "judge").length, 3, `${seat} judged the 3 others`);
    }
    const orRank = result.ranking.find((r) => r.agent === "or-x");
    assert.ok(orRank, "the OpenRouter seat is ranked");
    assert.equal(orRank.votes, 3, "the OpenRouter seat's answer got a blind score from every other seat");
    assert.match(result.report, /or-x/, "the report names the OpenRouter seat");
  });
});

test("benchmark honors the seat registry: a skipped seat is neither answered nor judged", async () => {
  await withBenchState(async (cwd) => {
    const calls = [];
    const result = await runBenchmark(
      cwd,
      ALL_SEAT_BACKENDS,
      { focusText: "Explain X.", skipSeats: ["or-x"], skipClaude: true },
      seatDeps(calls)
    );
    assert.deepEqual(Object.keys(result.answers).sort(), ["codex", "grok"]);
    assert.equal(calls.filter((c) => c.seat === "or-x").length, 0, "a skipped OpenRouter seat is never called");
    assert.equal(calls.filter((c) => c.seat === "claude").length, 0, "a skipped claude seat is never called");
  });
});

test("benchmark: an orchestrator-supplied claude answer does not ALSO spawn the claude seat", async () => {
  await withBenchState(async (cwd) => {
    const calls = [];
    const claudeAnswer = path.join(cwd, "claude.md");
    fs.writeFileSync(claudeAnswer, "answer by the orchestrator", "utf8");
    const result = await runBenchmark(cwd, ALL_SEAT_BACKENDS, { focusText: "Explain X.", claudeAnswer }, seatDeps(calls));
    assert.equal(result.answers.claude, "answer by the orchestrator", "the file IS claude's entry");
    assert.equal(
      calls.filter((c) => c.seat === "claude" && c.kind === "answer").length,
      0,
      "no duplicate (double-billed) claude answer via the CLI seat"
    );
  });
});

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

test("aggregateBenchmarks treats ranking[0] as the winner", () => {
  const agg = aggregateBenchmarks([
    { taskHash: "t", ranking: [{ agent: "codex", avgScore: 9 }, { agent: "grok", avgScore: 8 }] }
  ]);
  assert.equal(agg.agents.codex.wins, 1);
  assert.equal(agg.agents.grok.wins, 0);
  assert.equal(agg.agents.grok.avgScore, 8);
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
