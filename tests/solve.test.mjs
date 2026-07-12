import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePlanCritique, parsePlanDoc, rankPlans, runSolve } from "../plugins/council/scripts/lib/solve.mjs";

test("parsePlanDoc normalizes a valid plan", () => {
  const stdout = `Here is my plan:\n\`\`\`json\n${JSON.stringify({
    agent: "codex",
    summary: "Do the thing.",
    approach: "Small incremental refactor.",
    steps: [{ n: 1, title: "step", detail: "do it", files: ["a.mjs"] }],
    risks: [{ risk: "breaks", mitigation: "tests", severity: "P1" }],
    tradeoffs: ["slower"],
    effort: "M",
    confidence: 0.8
  })}\n\`\`\``;
  const plan = parsePlanDoc(stdout, "codex");
  assert.equal(plan.parseOk, true);
  assert.equal(plan.agent, "codex");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].files[0], "a.mjs");
  assert.equal(plan.effort, "M");
  assert.equal(plan.confidence, 0.8);
});

test("parsePlanDoc rejects prose without plan shape", () => {
  const plan = parsePlanDoc('{"summary": "no approach or steps"}', "grok");
  assert.equal(plan.parseOk, false);
  assert.equal(plan.confidence, 0);
});

test("parsePlanDoc clamps invalid effort to M", () => {
  const plan = parsePlanDoc(JSON.stringify({ approach: "x", steps: [], effort: "GIGANTIC" }), "grok");
  assert.equal(plan.parseOk, true);
  assert.equal(plan.effort, "M");
});

test("parsePlanCritique clamps scores and collects blockers", () => {
  const critique = parsePlanCritique(
    JSON.stringify({
      summary: "solid",
      scores: { feasibility: 9, risk: 0, simplicity: 3, completeness: 4 },
      overall: 12,
      blockers: ["missing migration"],
      improvements: ["add cache"]
    }),
    "grok",
    "codex"
  );
  assert.equal(critique.parseOk, true);
  assert.equal(critique.scores.feasibility, 5);
  assert.equal(critique.scores.risk, 1);
  assert.equal(critique.overall, 10);
  assert.deepEqual(critique.blockers, ["missing migration"]);
});

test("parsePlanCritique marks unparseable output", () => {
  const critique = parsePlanCritique("total garbage, no json", "codex", "grok");
  assert.equal(critique.parseOk, false);
  assert.equal(critique.overall, null);
});

test("rankPlans orders by average peer overall score", () => {
  const plans = [
    parsePlanDoc(JSON.stringify({ approach: "a", steps: [] }), "codex"),
    parsePlanDoc(JSON.stringify({ approach: "b", steps: [] }), "grok"),
    parsePlanDoc(JSON.stringify({ approach: "c", steps: [] }), "claude")
  ];
  const critiques = [
    parsePlanCritique(JSON.stringify({ overall: 4, scores: {} }), "grok", "codex"),
    parsePlanCritique(JSON.stringify({ overall: 8, scores: {} }), "codex", "grok"),
    parsePlanCritique(JSON.stringify({ overall: 9, scores: {}, blockers: ["b1"] }), "codex", "claude"),
    parsePlanCritique(JSON.stringify({ overall: 9, scores: {} }), "grok", "claude")
  ];
  const ranking = rankPlans(plans, critiques);
  assert.deepEqual(
    ranking.map((r) => r.agent),
    ["claude", "grok", "codex"]
  );
  assert.equal(ranking[0].avgOverall, 9);
  assert.equal(ranking[0].votes, 2);
  assert.equal(ranking[0].blockers.length, 1);
  assert.equal(ranking[0].blockers[0].from, "codex");
});

// --- A10: solve is SEAT-driven (six-eyes), not a hardcoded codex+grok pair ------------------
// The seat runners are injected (deps.*), so these run with no CLI and no network.

const SOLVE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "council-solve-"));

function planJson(agent, extra = {}) {
  return JSON.stringify({
    agent,
    summary: `${agent}'s plan`,
    approach: "small incremental refactor",
    steps: [{ n: 1, title: "step", detail: "do it", files: ["a.mjs"] }],
    risks: [],
    tradeoffs: [],
    effort: "M",
    confidence: 0.8,
    ...extra
  });
}

function critiqueJson(overall = 7, blockers = []) {
  return JSON.stringify({
    summary: "ok",
    scores: { feasibility: 4, risk: 3, simplicity: 4, completeness: 4 },
    overall,
    blockers,
    improvements: []
  });
}

const isCritiquePrompt = (prompt) => /PLAN CRITIQUE/.test(String(prompt ?? ""));

/** All three CLI seats reachable, plus optional OpenRouter seats. */
function seatBackends(orSeatIds = []) {
  return {
    codex: { companionAvailable: true, companion: "companion.mjs" },
    grok: { cli: { available: true }, bin: "grok" },
    claude: { cli: { available: true }, bin: "claude" },
    openrouter: orSeatIds.length
      ? { available: true, seats: orSeatIds.map((id) => ({ id, model: `vendor/${id}` })) }
      : undefined
  };
}

/**
 * Records every seat call and answers with a valid plan (R1) / critique (R2).
 * `stdoutFor(seat, kind, callNo)` can override a single reply (e.g. malformed JSON).
 */
function recordingDeps(calls, stdoutFor = null) {
  const seen = new Map();
  const reply = (seat, prompt) => {
    const kind = isCritiquePrompt(prompt) ? "critique" : "plan";
    const callNo = (seen.get(`${seat}:${kind}`) ?? 0) + 1;
    seen.set(`${seat}:${kind}`, callNo);
    calls.push({ seat, kind, prompt });
    const override = stdoutFor?.(seat, kind, callNo);
    const stdout = override ?? (kind === "plan" ? planJson(seat) : critiqueJson());
    return { status: 0, stdout, stderr: "", skipped: false };
  };
  return {
    runCodex: async (p) => reply("codex", p),
    runGrok: async (p) => reply("grok", p),
    runClaude: async (p) => reply("claude", p),
    runOpenRouter: async (_cwd, _backends, _options, p, seatId) => reply(seatId, p)
  };
}

const solveOpts = (extra = {}) => ({ focusText: "Make the thing faster.", ...extra });

test("A10: EVERY active seat proposes AND critiques - claude and OpenRouter seats are no longer dropped", async () => {
  const calls = [];
  const run = await runSolve(SOLVE_TMP, seatBackends(["or-x"]), solveOpts(), recordingDeps(calls));

  const seats = ["codex", "grok", "claude", "or-x"];
  // R1: every seat proposed exactly once (claude no longer needs a plan FILE to participate).
  for (const seat of seats) {
    assert.equal(calls.filter((c) => c.seat === seat && c.kind === "plan").length, 1, `${seat} must propose`);
  }
  assert.deepEqual(
    run.plans.map((p) => p.agent).sort(),
    [...seats].sort()
  );
  // R2: every seat critiqued every OTHER seat's plan - all-to-all, never itself.
  for (const seat of seats) {
    assert.equal(
      calls.filter((c) => c.seat === seat && c.kind === "critique").length,
      seats.length - 1,
      `${seat} must critique every other plan`
    );
  }
  assert.equal(run.critiques.length, seats.length * (seats.length - 1));
  assert.equal(
    run.critiques.filter((c) => c.agent === c.aboutAgent).length,
    0,
    "no seat may critique its own plan"
  );
});

test("A10: the critique pools are SYMMETRIC, so the ranking averages are comparable", async () => {
  const calls = [];
  // Before: claude's plan collected 2 peer votes while codex/grok collected 1 each, so rankPlans
  // averaged over DIFFERENT critic pools. Now every plan is scored by the same pool minus its author.
  const run = await runSolve(SOLVE_TMP, seatBackends(["or-x"]), solveOpts(), recordingDeps(calls));
  const votes = new Set(run.ranking.map((r) => r.votes));
  assert.deepEqual([...votes], [3], "every plan is scored by the same pool size (seats - its own author)");
  for (const entry of run.ranking) {
    const critics = run.critiques.filter((c) => c.aboutAgent === entry.agent).map((c) => c.agent).sort();
    assert.deepEqual(critics, ["codex", "grok", "claude", "or-x"].filter((s) => s !== entry.agent).sort());
  }
});

test("A10: a MALFORMED R1 plan is repaired by the retry, not silently lost", async () => {
  const calls = [];
  // grok's first proposal is garbage; runStructuredWithRetry re-asks and the plan survives.
  const deps = recordingDeps(calls, (seat, kind, callNo) =>
    seat === "grok" && kind === "plan" && callNo === 1 ? "sorry, here is some prose instead of JSON" : null
  );
  const run = await runSolve(SOLVE_TMP, seatBackends(), solveOpts(), deps);

  assert.equal(calls.filter((c) => c.seat === "grok" && c.kind === "plan").length, 2, "R1 retried once");
  const grokPlan = run.plans.find((p) => p.agent === "grok");
  assert.equal(grokPlan?.parseOk, true, "the repaired plan is kept - one bad JSON must not delete a model's plan");
  assert.ok(
    run.ranking.some((r) => r.agent === "grok" && r.votes === 2),
    "and the repaired plan still gets its full peer-critique pool"
  );
});

test("A10: the plan identity is the RUNNER seat, never the model-echoed `agent` field", async () => {
  // A model can echo any agent id; trusting it would let a seat critique + score its OWN plan.
  assert.equal(parsePlanDoc(planJson("claude"), "codex").agent, "codex");

  const calls = [];
  const deps = recordingDeps(calls, (seat, kind) => (seat === "codex" && kind === "plan" ? planJson("grok") : null));
  const run = await runSolve(SOLVE_TMP, seatBackends(), solveOpts(), deps);

  assert.deepEqual(run.plans.map((p) => p.agent).sort(), ["claude", "codex", "grok"]);
  assert.equal(run.critiques.filter((c) => c.agent === c.aboutAgent).length, 0, "the self-critique exclusion still holds");
  assert.equal(run.critiques.filter((c) => c.aboutAgent === "codex").length, 2);
});

test("A10: claude's plan may still arrive as a FILE - it then critiques without re-planning via CLI", async () => {
  const planFile = path.join(SOLVE_TMP, "claude-plan.json");
  fs.writeFileSync(planFile, planJson("claude"), "utf8");
  const calls = [];
  const run = await runSolve(
    SOLVE_TMP,
    seatBackends(),
    solveOpts({ claudePlanPath: planFile }),
    recordingDeps(calls)
  );

  assert.equal(calls.filter((c) => c.seat === "claude" && c.kind === "plan").length, 0, "no duplicate claude plan run");
  assert.equal(calls.filter((c) => c.seat === "claude" && c.kind === "critique").length, 2, "claude still critiques");
  assert.deepEqual(run.plans.map((p) => p.agent).sort(), ["claude", "codex", "grok"]);
  assert.deepEqual([...new Set(run.ranking.map((r) => r.votes))], [2], "pools stay symmetric");
});

test("A10 (fail-closed): with every seat skipped there are no plans, no critiques, and both CLI seats stay visible", async () => {
  const calls = [];
  const run = await runSolve(
    SOLVE_TMP,
    seatBackends(),
    solveOpts({ skipCodex: true, skipGrok: true, skipClaude: true }),
    recordingDeps(calls)
  );
  assert.equal(calls.length, 0, "no seat may be dispatched");
  assert.deepEqual(run.plans, []);
  assert.deepEqual(run.critiques, []);
  assert.deepEqual(run.ranking, []);
  // the job status logic keys off "every R1 entry skipped" -> failed; the placeholders must survive.
  assert.deepEqual(
    run.r1.map((r) => [r.agent, r.skipped]),
    [
      ["codex", true],
      ["grok", true]
    ]
  );
});
