import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runCodexStructured,
  runGrokStructured
} from "./agents.mjs";
import { extractJsonObject } from "./findings.mjs";
import { resolveStateDir } from "./state.mjs";

export function benchmarkFile(cwd) {
  return path.join(resolveStateDir(cwd), "benchmarks.jsonl");
}

export function parseJudgeScore(stdout) {
  const doc = extractJsonObject(stdout);
  if (!doc || !Number.isFinite(Number(doc.score))) return null;
  const score = Math.min(10, Math.max(1, Number(doc.score)));
  return { score, rationale: String(doc.rationale ?? "").trim() };
}

/** Average of an array of numbers, or null when empty. */
function avg(nums) {
  const valid = nums.filter((n) => Number.isFinite(n));
  return valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : null;
}

function taskAnswer(cwd, backends, agent, options, prompt, label) {
  if (agent === "codex") return runCodexStructured(cwd, backends, options, prompt, label);
  return runGrokStructured(cwd, backends, options, prompt);
}

/**
 * Benchmark: every non-skipped agent answers the same task; each answer is then
 * blind-scored (1-10) by the OTHER agents. Returns per-agent aggregate scores and
 * appends a record to benchmarks.jsonl. Read-only tasks only.
 */
export async function runBenchmark(cwd, backends, options = {}) {
  const onPhase = typeof options.onPhase === "function" ? options.onPhase : () => {};
  const task = options.taskFile ? fs.readFileSync(options.taskFile, "utf8") : String(options.focusText ?? "");
  if (!task.trim()) {
    throw new Error("Provide a benchmark task: --task-file <path> or positional text.");
  }
  const taskHash = createHash("sha256").update(task).digest("hex").slice(0, 12);

  // Phase 1: independent answers.
  onPhase("answers");
  const answerOpts = { ...options, maxTurns: options.maxTurnsR1 };
  const agents = [];
  if (!options.skipCodex) agents.push("codex");
  if (!options.skipGrok) agents.push("grok");

  const answers = {};
  const answerJobs = agents.map(async (agent) => {
    const prompt = interpolate(loadPrompt("benchmark-task"), { AGENT: agent, TASK: task, NONCE: makeFenceNonce() });
    const res = await taskAnswer(cwd, backends, agent, answerOpts, prompt, "benchmark-answer");
    return { agent, res };
  });
  for (const { agent, res } of await Promise.all(answerJobs)) {
    if (!res.skipped && res.status === 0 && String(res.stdout ?? "").trim()) {
      answers[agent] = res.stdout.trim();
    }
  }
  if (options.claudeAnswer && fs.existsSync(options.claudeAnswer)) {
    const text = fs.readFileSync(options.claudeAnswer, "utf8").trim();
    if (text) answers.claude = text;
  }

  const answeredAgents = Object.keys(answers);

  // Phase 2: each agent blind-scores every OTHER agent's answer.
  onPhase("judging");
  const judges = agents; // codex/grok can run judge prompts; claude judges in synthesis
  const judgeOpts = { ...options, maxTurns: options.maxTurnsR2, grokEffort: options.r2Effort ?? options.grokEffort };
  const judgeJobs = [];
  for (const target of answeredAgents) {
    for (const judge of judges) {
      if (judge === target) continue;
      const prompt = interpolate(loadPrompt("benchmark-judge"), {
        AGENT: judge,
        TASK: task,
        ANSWER: answers[target],
        NONCE: makeFenceNonce()
      });
      judgeJobs.push(
        taskAnswer(cwd, backends, judge, judgeOpts, prompt, "benchmark-judge").then((res) => ({
          judge,
          target,
          score: res.skipped ? null : parseJudgeScore(res.stdout)
        }))
      );
    }
  }
  const judgements = await Promise.all(judgeJobs);

  // Aggregate blind peer scores per answering agent.
  const scoresByAgent = {};
  for (const agent of answeredAgents) scoresByAgent[agent] = [];
  for (const j of judgements) {
    if (j.score && scoresByAgent[j.target]) scoresByAgent[j.target].push({ judge: j.judge, ...j.score });
  }
  const ranking = answeredAgents
    .map((agent) => ({
      agent,
      avgScore: avg(scoresByAgent[agent].map((s) => s.score)),
      votes: scoresByAgent[agent].length,
      scores: scoresByAgent[agent]
    }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  const record = {
    taskHash,
    date: options.nowIso ?? new Date().toISOString(),
    category: options.category ?? null,
    ranking: ranking.map((r) => ({ agent: r.agent, avgScore: r.avgScore, votes: r.votes }))
  };
  try {
    const file = benchmarkFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* best effort */
  }

  return { taskHash, task, answers, ranking, judgements, report: renderBenchmark(task, ranking) };
}

function renderBenchmark(task, ranking) {
  const lines = ["# Council Benchmark", "", "## Task", task.trim().split(/\r?\n/)[0], "", "## Ranking (avg blind peer score)"];
  if (!ranking.length) lines.push("(no answers)");
  for (const [i, r] of ranking.entries()) {
    lines.push(`${i + 1}. **${r.agent}** - ${r.avgScore == null ? "-" : `${r.avgScore}/10`} (${r.votes} judges)`);
    for (const s of r.scores) lines.push(`   - ${s.judge}: ${s.score}/10 - ${s.rationale}`);
  }
  lines.push("", "Note: agents scored answers blind (author hidden). Persisted to benchmarks.jsonl.");
  return lines.join("\n");
}

export function readBenchmarks(cwd) {
  try {
    return fs
      .readFileSync(benchmarkFile(cwd), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function aggregateBenchmarks(records) {
  const byAgent = {};
  for (const rec of records) {
    for (const r of rec.ranking ?? []) {
      const stats = (byAgent[r.agent] = byAgent[r.agent] ?? { runs: 0, scores: [], wins: 0 });
      stats.runs += 1;
      if (Number.isFinite(Number(r.avgScore))) stats.scores.push(Number(r.avgScore));
    }
    const winner = (rec.ranking ?? [])[0];
    if (winner && byAgent[winner.agent]) byAgent[winner.agent].wins += 1;
  }
  return {
    runs: records.length,
    agents: Object.fromEntries(
      Object.entries(byAgent).map(([k, v]) => [
        k,
        { runs: v.runs, wins: v.wins, avgScore: avg(v.scores) }
      ])
    )
  };
}
