import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runCodexStructured,
  runGrokStructured,
  waitForFile
} from "./agents.mjs";
import { extractJsonObject } from "./findings.mjs";
import { resolveStateDir } from "./state.mjs";

export function benchmarkFile(cwd) {
  return path.join(resolveStateDir(cwd), "benchmarks.jsonl");
}

const MAX_BENCHMARK_RECORDS = 1000;
const MAX_ANSWER_CHARS = 12_000;

function answersDir(cwd, taskHash) {
  return path.join(resolveStateDir(cwd), "benchmark-answers", taskHash);
}

function persistAnswers(cwd, taskHash, answers) {
  try {
    const dir = answersDir(cwd, taskHash);
    fs.mkdirSync(dir, { recursive: true });
    for (const [agent, text] of Object.entries(answers)) {
      fs.writeFileSync(path.join(dir, `${agent}.txt`), text, "utf8");
    }
    return dir;
  } catch {
    return null;
  }
}

function loadPersistedAnswers(cwd, taskHash) {
  const out = {};
  try {
    const dir = answersDir(cwd, taskHash);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
      out[path.basename(file, ".txt")] = fs.readFileSync(path.join(dir, file), "utf8").trim();
    }
  } catch {
    /* none */
  }
  return out;
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
  const agents = [];
  if (!options.skipCodex) agents.push("codex");
  if (!options.skipGrok) agents.push("grok");
  const clampAnswer = (text) => {
    const t = String(text).trim();
    return t.length > MAX_ANSWER_CHARS ? `${t.slice(0, MAX_ANSWER_CHARS)}\n[... answer truncated ...]` : t;
  };

  // Phase 1: independent answers. In judge-only mode, load persisted answers
  // instead of re-running the agents (so a second pass can add Claude judgements
  // for a symmetric ranking without paying for answers again).
  const answers = {};
  if (options.judgeOnly) {
    Object.assign(answers, loadPersistedAnswers(cwd, taskHash));
    if (!Object.keys(answers).length) {
      throw new Error(`No persisted answers for this task (run the answer phase first).`);
    }
  } else {
    onPhase("answers");
    const answerOpts = { ...options, maxTurns: options.maxTurnsR1 };
    const answerJobs = agents.map(async (agent) => {
      const prompt = interpolate(loadPrompt("benchmark-task"), { AGENT: agent, TASK: task, NONCE: makeFenceNonce() });
      const res = await taskAnswer(cwd, backends, agent, answerOpts, prompt, "benchmark-answer");
      return { agent, res };
    });
    for (const { agent, res } of await Promise.all(answerJobs)) {
      if (!res.skipped && res.status === 0 && String(res.stdout ?? "").trim()) {
        answers[agent] = clampAnswer(res.stdout);
      }
    }
    // Claude's answer: wait for it (parallel workflow) or read it if present.
    if (options.claudeAnswerWait) {
      const found = fs.existsSync(options.claudeAnswerWait)
        ? options.claudeAnswerWait
        : await waitForFile(options.claudeAnswerWait, Number(options.waitTimeoutMs ?? 300_000));
      if (found) answers.claude = clampAnswer(fs.readFileSync(found, "utf8"));
    } else if (options.claudeAnswer && fs.existsSync(options.claudeAnswer)) {
      answers.claude = clampAnswer(fs.readFileSync(options.claudeAnswer, "utf8"));
    }
    persistAnswers(cwd, taskHash, answers);
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

  // Optional: Claude's blind judgements, submitted by the orchestrator as a JSON
  // file { "<targetAgent>": {score, rationale}, ... } so every answer (incl.
  // codex/grok when the other is skipped) can be judged symmetrically.
  if (options.claudeJudgements && fs.existsSync(options.claudeJudgements)) {
    try {
      const doc = JSON.parse(fs.readFileSync(options.claudeJudgements, "utf8"));
      for (const [target, val] of Object.entries(doc)) {
        if (target === "claude" || !answeredAgents.includes(target)) continue;
        const score = Math.min(10, Math.max(1, Number(val?.score)));
        if (Number.isFinite(score)) {
          judgements.push({ judge: "claude", target, score: { score, rationale: String(val?.rationale ?? "").trim() } });
        }
      }
    } catch {
      /* ignore malformed claude judgements */
    }
  }

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
    judgeOnly: Boolean(options.judgeOnly),
    ranking: ranking.map((r) => ({ agent: r.agent, avgScore: r.avgScore, votes: r.votes }))
  };
  try {
    const file = benchmarkFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      /* new file */
    }
    // judge-only SUPERSEDES the answer-phase record for the same task (it is the
    // same logical run, now with fair/complete judging) - never double-count.
    if (options.judgeOnly) {
      lines = lines.filter((l) => {
        try {
          return JSON.parse(l).taskHash !== taskHash;
        } catch {
          return true;
        }
      });
    }
    lines.push(JSON.stringify(record));
    if (lines.length > MAX_BENCHMARK_RECORDS) lines = lines.slice(-MAX_BENCHMARK_RECORDS);
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  } catch {
    /* best effort */
  }

  const dir = answersDir(cwd, taskHash);
  return { taskHash, task, answers, answersDir: dir, ranking, judgements, report: renderBenchmark(task, ranking, dir) };
}

function renderBenchmark(task, ranking, dir) {
  const lines = ["# Council Benchmark", "", "## Task", task.trim().split(/\r?\n/)[0], "", "## Ranking (avg blind peer score)"];
  if (!ranking.length) lines.push("(no answers)");
  for (const [i, r] of ranking.entries()) {
    lines.push(`${i + 1}. **${r.agent}** - ${r.avgScore == null ? "-" : `${r.avgScore}/10`} (${r.votes} judge${r.votes === 1 ? "" : "s"})`);
    for (const s of r.scores) lines.push(`   - ${s.judge}: ${s.score}/10 - ${s.rationale}`);
  }
  const voteCounts = new Set(ranking.map((r) => r.votes));
  if (voteCounts.size > 1) {
    lines.push("", "**Note: judge counts differ across agents** — averages come from different sample sizes.");
    lines.push("For a symmetric ranking, read the answers and add Claude's blind scores:");
    lines.push("`benchmark --judge-only --task-file <same> --claude-judgements <json>`.");
  }
  lines.push("", `Answers persisted in: ${dir}`, "Blind scoring is nominal (a model may infer style). Persisted to benchmarks.jsonl.");
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
