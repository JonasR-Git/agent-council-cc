import test from "node:test";
import assert from "node:assert/strict";

import { parsePlanCritique, parsePlanDoc, rankPlans } from "../plugins/council/scripts/lib/solve.mjs";

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
