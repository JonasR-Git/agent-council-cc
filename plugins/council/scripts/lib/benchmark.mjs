import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  waitForFile
} from "./agents.mjs";
import { extractJsonObject } from "./findings.mjs";
import { readJsonl, writeJsonlCapped } from "./jsonl.mjs";
import { activeSeatNames, makeSeatRunners } from "./seats.mjs";
import { resolveStateDir } from "./state.mjs";
import { avg, clampScore } from "./stats.mjs";

function benchmarkFile(cwd) {
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
  const score = clampScore(doc.score, 1, 10);
  return { score, rationale: String(doc.rationale ?? "").trim() };
}

/**
 * The seats this benchmark runs itself: EVERY active seat (codex/grok/claude + every configured
 * OpenRouter seat) via the dynamic registry. Benchmarking exists to COMPARE seat quality, so a
 * hardcoded codex+grok pair silently hid the claude seat and every OpenRouter seat the user paid to
 * configure. Claude drops out of the runner-driven set exactly when the ORCHESTRATOR supplies its
 * entry as a file (--claude-answer/--claude-answer-wait for answers, --claude-judgements for
 * scores): that file IS claude's contribution, so also spawning the claude CLI would double-bill and
 * produce two conflicting "claude" entries.
 */
function benchmarkSeats(backends, options) {
  const seats = activeSeatNames(backends, options);
  const answerFromFile = Boolean(options.claudeAnswer || options.claudeAnswerWait);
  const judgeFromFile = Boolean(options.claudeJudgements);
  return {
    answerSeats: seats.filter((seat) => !(seat === "claude" && answerFromFile)),
    judgeSeats: seats.filter((seat) => !(seat === "claude" && judgeFromFile))
  };
}

/**
 * Benchmark: every ACTIVE seat answers the same task; each answer is then blind-scored (1-10) by the
 * OTHER seats. Returns per-agent aggregate scores and appends a record to benchmarks.jsonl.
 * Read-only tasks only. deps.run* stay injectable (tests need no CLI/network).
 */
export async function runBenchmark(cwd, backends, options = {}, deps = {}) {
  const onPhase = typeof options.onPhase === "function" ? options.onPhase : () => {};
  const task = options.taskFile ? fs.readFileSync(options.taskFile, "utf8") : String(options.focusText ?? "");
  if (!task.trim()) {
    throw new Error("Provide a benchmark task: --task-file <path> or positional text.");
  }
  const taskHash = createHash("sha256").update(task).digest("hex").slice(0, 12);
  const { answerSeats, judgeSeats } = benchmarkSeats(backends, options);
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
    const answerRunners = makeSeatRunners(cwd, backends, answerOpts, deps);
    const answerJobs = answerSeats.map(async (agent) => {
      const prompt = interpolate(loadPrompt("benchmark-task"), { AGENT: agent, TASK: task, NONCE: makeFenceNonce() });
      const run = answerRunners[agent];
      // Fail-closed: a seat without a runner contributes NO answer — it is never answered for it.
      const res = run ? await run(prompt) : { skipped: true, reason: `no runner for seat ${agent}` };
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

  // Phase 2: each seat blind-scores every OTHER seat's answer. Judges are the active seats (claude
  // judges via --claude-judgements when the orchestrator supplies them, see benchmarkSeats).
  onPhase("judging");
  const judgeOpts = { ...options, maxTurns: options.maxTurnsR2, grokEffort: options.r2Effort ?? options.grokEffort };
  const judgeRunners = makeSeatRunners(cwd, backends, judgeOpts, deps);
  const judgeJobs = [];
  for (const target of answeredAgents) {
    for (const judge of judgeSeats) {
      if (judge === target) continue;
      const run = judgeRunners[judge];
      // Fail-closed: no runner -> no vote. A judgement is NEVER routed to another seat (it would be
      // attributed to the seat that never cast it).
      if (!run) continue;
      const prompt = interpolate(loadPrompt("benchmark-judge"), {
        AGENT: judge,
        TASK: task,
        ANSWER: answers[target],
        NONCE: makeFenceNonce()
      });
      judgeJobs.push(
        run(prompt).then((res) => ({
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
        const score = clampScore(val?.score, 1, 10);
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
    const records = readJsonl(benchmarkFile(cwd));
    // judge-only SUPERSEDES only the MOST RECENT same-task record (the answer
    // phase of THIS run) - it must not wipe earlier chronological runs of the
    // same task, which are the longitudinal history --stats tracks.
    if (options.judgeOnly) {
      let lastIdx = -1;
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i]?.taskHash === taskHash) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) records.splice(lastIdx, 1);
    }
    records.push(record);
    writeJsonlCapped(benchmarkFile(cwd), records, MAX_BENCHMARK_RECORDS);
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
  return readJsonl(benchmarkFile(cwd));
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
