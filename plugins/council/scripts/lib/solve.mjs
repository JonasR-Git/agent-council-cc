import fs from "node:fs";
import path from "node:path";

import {
  interpolate,
  loadPrompt,
  runCodexStructured,
  runGrokStructured,
  waitForFile
} from "./agents.mjs";
import { runDebateRounds } from "./debate.mjs";
import { extractJsonObject } from "./findings.mjs";
import { runCommand } from "./process.mjs";
import { SCHEMAS } from "./schemas.mjs";
import { validate } from "./validate.mjs";

const REPO_HINT_MAX_FILES = 300;
const README_HEAD_CHARS = 2000;
const VALID_EFFORTS = new Set(["S", "M", "L", "XL"]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function firstLines(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(0, n)
    .join("\n")
    .trim();
}

/**
 * Normalize an agent's solution plan (schemas/plan.schema.json).
 */
export function parsePlanDoc(stdout, agent) {
  const parsed = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.plan, parsed);
  if (!checked.valid) {
    return {
      agent,
      parseOk: false,
      summary: firstLines(stdout, 6),
      approach: "",
      steps: [],
      risks: [],
      tradeoffs: [],
      effort: "M",
      confidence: 0,
      validationErrors: checked.errors,
      raw: String(stdout ?? "")
    };
  }
  return {
    agent: String(parsed.agent ?? agent),
    parseOk: true,
    summary: String(parsed.summary ?? "").trim(),
    approach: String(parsed.approach ?? "").trim(),
    steps: (Array.isArray(parsed.steps) ? parsed.steps : []).map((s, i) => ({
      n: Number.isFinite(Number(s?.n)) ? Number(s.n) : i + 1,
      title: String(s?.title ?? "").trim(),
      detail: String(s?.detail ?? "").trim(),
      files: Array.isArray(s?.files) ? s.files.map(String) : []
    })),
    risks: (Array.isArray(parsed.risks) ? parsed.risks : []).map((r) => ({
      risk: String(r?.risk ?? "").trim(),
      mitigation: String(r?.mitigation ?? "").trim(),
      severity: String(r?.severity ?? "P2")
    })),
    tradeoffs: Array.isArray(parsed.tradeoffs) ? parsed.tradeoffs.map(String) : [],
    effort: VALID_EFFORTS.has(parsed.effort) ? parsed.effort : "M",
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.6,
    raw: String(stdout ?? "")
  };
}

function clampScore(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(1, n));
}

/**
 * Normalize a peer critique of a plan (scores 1-5, overall 1-10).
 */
export function parsePlanCritique(stdout, agent, aboutAgent) {
  const doc = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.planCritique, doc);
  if (!checked.valid) {
    return {
      agent,
      aboutAgent,
      parseOk: false,
      scores: {},
      blockers: [],
      improvements: [],
      overall: null,
      summary: firstLines(stdout, 4),
      validationErrors: checked.errors,
      raw: String(stdout ?? "")
    };
  }
  const scores = isObject(doc.scores) ? doc.scores : {};
  return {
    agent,
    aboutAgent,
    parseOk: true,
    scores: {
      feasibility: clampScore(scores.feasibility, 5),
      risk: clampScore(scores.risk, 5),
      simplicity: clampScore(scores.simplicity, 5),
      completeness: clampScore(scores.completeness, 5)
    },
    blockers: Array.isArray(doc.blockers) ? doc.blockers.map(String) : [],
    improvements: Array.isArray(doc.improvements) ? doc.improvements.map(String) : [],
    overall: clampScore(doc.overall, 10),
    summary: String(doc.summary ?? "").trim(),
    raw: String(stdout ?? "")
  };
}

/**
 * Rank plans by average peer overall score (desc). Plans without any peer
 * score sort last but stay listed.
 */
export function rankPlans(plans, critiques) {
  return plans
    .filter((p) => p.parseOk)
    .map((plan) => {
      const about = critiques.filter((c) => c.parseOk && c.aboutAgent === plan.agent && c.overall != null);
      const avgOverall = about.length
        ? about.reduce((sum, c) => sum + c.overall, 0) / about.length
        : null;
      return {
        agent: plan.agent,
        avgOverall,
        votes: about.length,
        blockers: critiques
          .filter((c) => c.parseOk && c.aboutAgent === plan.agent)
          .flatMap((c) => c.blockers.map((b) => ({ from: c.agent, blocker: b })))
      };
    })
    .sort((a, b) => (b.avgOverall ?? 0) - (a.avgOverall ?? 0));
}

function collectRepoHints(cwd) {
  const ls = runCommand("git", ["ls-files"], { cwd });
  let tree = "";
  if (ls.status === 0 && ls.stdout.trim()) {
    const files = ls.stdout.trim().split(/\r?\n/);
    tree = files.slice(0, REPO_HINT_MAX_FILES).join("\n");
    if (files.length > REPO_HINT_MAX_FILES) {
      tree += `\n[... ${files.length - REPO_HINT_MAX_FILES} more files ...]`;
    }
  } else {
    try {
      tree = fs
        .readdirSync(cwd, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .slice(0, 100)
        .join("\n");
    } catch {
      tree = "(unable to list files)";
    }
  }
  let readme = "";
  try {
    readme = fs.readFileSync(path.join(cwd, "README.md"), "utf8").slice(0, README_HEAD_CHARS);
  } catch {
    /* none */
  }
  return `## Files\n${tree}\n\n## README (head)\n${readme || "(none)"}`;
}

function buildProposalPrompt(agent, problem, hints, options) {
  const template = loadPrompt("r1-proposal");
  return interpolate(template, {
    AGENT: agent,
    PROBLEM: problem,
    REPO_HINTS: hints,
    POLICY_FOCUS: options.policyFocus || "None"
  });
}

function buildPlanCritiquePrompt(agent, plan) {
  const template = loadPrompt("r2-plan-critique");
  const slim = {
    agent: plan.agent,
    summary: plan.summary,
    approach: plan.approach,
    steps: plan.steps,
    risks: plan.risks,
    tradeoffs: plan.tradeoffs,
    effort: plan.effort,
    confidence: plan.confidence
  };
  return interpolate(template, {
    AGENT: agent,
    ABOUT_AGENT: plan.agent,
    PLAN_JSON: JSON.stringify(slim, null, 2)
  });
}

async function loadClaudePlan(options) {
  if (options.claudePlanPath && fs.existsSync(options.claudePlanPath)) {
    return parsePlanDoc(fs.readFileSync(options.claudePlanPath, "utf8"), "claude");
  }
  if (options.claudePlanWaitPath) {
    const waitTimeoutMs = Number(options.waitTimeoutMs ?? 300_000);
    const found = fs.existsSync(options.claudePlanWaitPath)
      ? options.claudePlanWaitPath
      : await waitForFile(options.claudePlanWaitPath, waitTimeoutMs);
    if (found) {
      return parsePlanDoc(fs.readFileSync(found, "utf8"), "claude");
    }
  }
  return null;
}

/**
 * Solve protocol: independent plans (codex + grok [+ claude via file]) ->
 * cross-critique with scores -> ranking [-> bounded debate on blockers].
 * Synthesis and implementation stay with the orchestrator (Claude).
 */
export async function runSolve(cwd, backends, options = {}) {
  const problem = options.problemFile
    ? fs.readFileSync(options.problemFile, "utf8")
    : String(options.focusText ?? "");
  if (!problem.trim()) {
    throw new Error("Provide a problem statement: --problem-file <path> or positional text.");
  }

  const hints = collectRepoHints(cwd);
  const r1Opts = { ...options, maxTurns: options.maxTurnsR1 };

  const r1Jobs = [];
  if (!options.skipCodex) {
    r1Jobs.push(runCodexStructured(cwd, backends, r1Opts, buildProposalPrompt("codex", problem, hints, options), "solve-r1"));
  } else {
    r1Jobs.push(Promise.resolve({ agent: "codex", skipped: true, reason: "skip", stdout: "" }));
  }
  if (!options.skipGrok) {
    r1Jobs.push(runGrokStructured(cwd, backends, r1Opts, buildProposalPrompt("grok", problem, hints, options)));
  } else {
    r1Jobs.push(Promise.resolve({ agent: "grok", skipped: true, reason: "skip", stdout: "" }));
  }

  const r1Raw = await Promise.all(r1Jobs);
  const claudePlan = await loadClaudePlan(options);

  const plans = [];
  const r1Results = [];
  for (const raw of r1Raw) {
    if (raw.skipped) {
      r1Results.push(raw);
      continue;
    }
    const plan = parsePlanDoc(raw.stdout, raw.agent);
    plans.push(plan);
    r1Results.push({ ...raw, plan });
  }
  if (claudePlan) {
    plans.push(claudePlan);
    r1Results.push({ agent: "claude", backend: "claude-plan-file", status: 0, plan: claudePlan, skipped: false });
  }

  const parsedPlans = plans.filter((p) => p.parseOk);

  const r2Opts = {
    ...options,
    maxTurns: options.maxTurnsR2,
    grokEffort: options.r2Effort ?? options.grokEffort
  };
  const critiqueJobs = [];
  for (const plan of parsedPlans) {
    for (const critic of ["codex", "grok"]) {
      if (critic === plan.agent) continue;
      if (critic === "codex" && options.skipCodex) continue;
      if (critic === "grok" && options.skipGrok) continue;
      const prompt = buildPlanCritiquePrompt(critic, plan);
      const job =
        critic === "codex"
          ? runCodexStructured(cwd, backends, r2Opts, prompt, `solve-critique-${plan.agent}`)
          : runGrokStructured(cwd, backends, r2Opts, prompt);
      critiqueJobs.push(
        job.then((res) => ({
          ...res,
          critique: res.skipped ? null : parsePlanCritique(res.stdout, critic, plan.agent),
          aboutAgent: plan.agent
        }))
      );
    }
  }
  const r2Results = await Promise.all(critiqueJobs);
  const critiques = r2Results.map((r) => r.critique).filter(Boolean);

  const ranking = rankPlans(plans, critiques);

  let debates = [];
  if ((options.debateRounds ?? 0) > 0) {
    const skipped = new Set(
      [options.skipCodex ? "codex" : null, options.skipGrok ? "grok" : null, "claude"].filter(Boolean)
    );
    const entries = ranking
      .filter((r) => r.blockers.length && !skipped.has(r.agent))
      .map((r) => {
        const plan = parsedPlans.find((p) => p.agent === r.agent);
        if (!plan || plan.confidence < 0.7) return null;
        const critic = r.blockers.map((b) => b.from).find((from) => from !== r.agent && !skipped.has(from));
        return {
          id: `plan-${r.agent}`,
          author: r.agent,
          critic: critic ?? null,
          payload: {
            title: `Plan by ${r.agent}`,
            summary: plan.summary,
            approach: plan.approach,
            critiques: r.blockers.map((b) => ({ from: b.from, note: b.blocker }))
          }
        };
      })
      .filter(Boolean);
    debates = await runDebateRounds(cwd, backends, options, entries);
  }

  const report = renderSolveReport({ problem, options, r1Results, r2Results, plans, critiques, ranking, debates });

  return {
    mode: "solve",
    problem,
    plans,
    critiques,
    ranking,
    debates,
    r1: r1Results,
    r2: r2Results,
    report
  };
}

function formatScore(value) {
  return value == null ? "-" : String(Math.round(value * 10) / 10);
}

function renderSolveReport({ problem, options, r1Results, r2Results, plans, critiques, ranking, debates }) {
  const lines = [];
  lines.push("# Council Solve");
  lines.push("");
  lines.push("## Protocol");
  lines.push("1. **Plans (independent):** each agent proposes a solution plan without seeing the others.");
  lines.push("2. **Plan critique:** each agent scores the other plans (feasibility/risk/simplicity/completeness, overall 1-10).");
  lines.push("3. **Claude synthesis (you):** build the final plan from the best-ranked skeleton + grafted improvements; get user approval; then ONE writer implements on a branch and /council:deliberate reviews the diff.");
  lines.push("");
  lines.push("## Problem");
  lines.push(problem.trim());
  lines.push("");
  if (options.policySource) lines.push(`Policy: \`${options.policySource}\``);
  lines.push("");

  lines.push("## Ranking (avg peer overall)");
  if (!ranking.length) {
    lines.push("(no parseable plans)");
  }
  for (const [index, entry] of ranking.entries()) {
    lines.push(
      `${index + 1}. **${entry.agent}** - avg ${formatScore(entry.avgOverall)}/10 (${entry.votes} peer votes, ${entry.blockers.length} blockers)`
    );
  }
  lines.push("");

  lines.push("## Plans");
  for (const r of r1Results) {
    lines.push(`### ${r.agent}`);
    if (r.skipped) {
      lines.push(`_Skipped:_ ${r.reason}`);
      lines.push("");
      continue;
    }
    const plan = r.plan;
    if (!plan?.parseOk) {
      lines.push("_Structured parse failed - raw output:_");
      for (const error of plan?.validationErrors?.slice(0, 3) ?? []) lines.push(`- ${error}`);
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
      lines.push("");
      continue;
    }
    lines.push(`Effort: ${plan.effort} · Confidence: ${plan.confidence}`);
    lines.push(plan.summary);
    lines.push("");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          approach: plan.approach,
          steps: plan.steps,
          risks: plan.risks,
          tradeoffs: plan.tradeoffs
        },
        null,
        2
      )
    );
    lines.push("```");
    lines.push("");
  }

  lines.push("## Critiques");
  for (const r of r2Results) {
    lines.push(`### ${r.critique?.agent ?? r.agent} -> ${r.aboutAgent}`);
    if (r.skipped) {
      lines.push(`_Skipped:_ ${r.reason}`);
      lines.push("");
      continue;
    }
    const c = r.critique;
    if (!c?.parseOk) {
      lines.push("_Structured parse failed - raw output:_");
      if (c?.validationErrors?.[0]) lines.push(`_Critique excluded: ${c.validationErrors[0]}_`);
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
      lines.push("");
      continue;
    }
    const s = c.scores;
    lines.push(
      `Overall: **${formatScore(c.overall)}/10** · feasibility ${formatScore(s.feasibility)} · risk ${formatScore(s.risk)} · simplicity ${formatScore(s.simplicity)} · completeness ${formatScore(s.completeness)}`
    );
    if (c.summary) lines.push(c.summary);
    if (c.blockers.length) {
      lines.push("Blockers:");
      for (const b of c.blockers) lines.push(`- ${b}`);
    }
    if (c.improvements.length) {
      lines.push("Improvements:");
      for (const impr of c.improvements) lines.push(`- ${impr}`);
    }
    lines.push("");
  }

  if (debates?.length) {
    lines.push("## Debate (bounded, blockers only)");
    for (const d of debates.filter((d) => d.round === 1)) {
      lines.push(`- **${d.id}** ${d.agent} -> **${d.stance}**: ${d.note || "(no note)"}`);
    }
    for (const d of debates.filter((d) => d.round === 2)) {
      lines.push(`  - counter by ${d.agent}: ${d.upheld ? "upholds blocker" : "withdraws blocker"} - ${d.note || "(no note)"}`);
    }
    lines.push("");
  }

  lines.push("## Your turn (Claude) - synthesis");
  lines.push("1. Take the best-ranked plan as the skeleton; graft the strongest improvements from the others.");
  lines.push("2. Resolve or explicitly accept every blocker (debate outcomes above help).");
  lines.push("3. Present the final plan to the user for approval BEFORE implementing.");
  lines.push("4. Implementation: exactly ONE writer (policy solve_writer) on a dedicated branch; then /council:deliberate on the diff. The writer's own verdict does not count towards approval.");
  lines.push("");

  return lines.join("\n");
}
