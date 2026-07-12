import fs from "node:fs";
import path from "node:path";

import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runStructuredWithRetry,
  waitForFile
} from "./agents.mjs";
import { runDebateRounds } from "./debate.mjs";
import { extractJsonObject } from "./findings.mjs";
import { runCommand } from "./process.mjs";
import { activeSeatNames, allSeatNames, makeSeatRunners } from "./seats.mjs";
import { SCHEMAS } from "./schemas.mjs";
import { validate } from "./validate.mjs";
import { clampScore } from "./stats.mjs";
import { firstLines, isObject } from "./util.mjs";

const REPO_HINT_MAX_FILES = 300;
const README_HEAD_CHARS = 2000;
const VALID_EFFORTS = new Set(["S", "M", "L", "XL"]);

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
    // The identity is the SEAT that produced this output, never the model-echoed `agent` field:
    // a plan that claims `"agent":"claude"` while codex wrote it would let codex critique and
    // score its OWN plan (the self-critique exclusion below matches on plan.agent). Same rule as
    // parseAgentFindings in findings.mjs.
    agent,
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
      feasibility: clampScore(scores.feasibility, 1, 5),
      risk: clampScore(scores.risk, 1, 5),
      simplicity: clampScore(scores.simplicity, 1, 5),
      completeness: clampScore(scores.completeness, 1, 5)
    },
    blockers: Array.isArray(doc.blockers) ? doc.blockers.map(String) : [],
    improvements: Array.isArray(doc.improvements) ? doc.improvements.map(String) : [],
    overall: clampScore(doc.overall, 1, 10),
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

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".json", ".jsx", ".kt",
  ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml",
  ".ts", ".tsx", ".vue", ".yaml", ".yml"
]);

function hintPriority(file) {
  // Source-like files first, shallow paths before deep ones - assets and
  // generated trees should not crowd planners out of the fixed budget.
  const ext = path.extname(file).toLowerCase();
  const depth = file.split("/").length;
  return (SOURCE_EXTENSIONS.has(ext) ? 0 : 1000) + depth;
}

function collectRepoHints(cwd) {
  const ls = runCommand("git", ["ls-files"], { cwd });
  let tree = "";
  if (ls.status === 0 && ls.stdout.trim()) {
    const files = ls.stdout.trim().split(/\r?\n/);
    const prioritized = [...files].sort(
      (a, b) => hintPriority(a) - hintPriority(b) || a.localeCompare(b)
    );
    tree = prioritized.slice(0, REPO_HINT_MAX_FILES).join("\n");
    if (files.length > REPO_HINT_MAX_FILES) {
      tree += `\n[... ${files.length - REPO_HINT_MAX_FILES} more files (lower priority) ...]`;
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
    NONCE: makeFenceNonce(),
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
    NONCE: makeFenceNonce(),
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
 * Solve protocol: independent plans (EVERY active seat) -> all-to-all cross-critique with scores ->
 * ranking [-> bounded debate on blockers]. Synthesis and implementation stay with the orchestrator
 * (Claude).
 *
 * SIX-EYES: the planner AND critic pool is the dynamic seat registry (codex/grok/claude + every
 * configured OpenRouter seat), never a hardcoded pair. A hardcoded ["codex","grok"] critic list
 * dropped claude (which only ever handed in a plan FILE) plus every paid OpenRouter seat, AND made
 * the ranking incomparable: claude's plan collected 2 peer votes while codex/grok collected 1 each,
 * so rankPlans averaged over DIFFERENT pools. Now every seat proposes and every seat critiques every
 * OTHER seat's plan (never its own), so each plan is scored by the same pool minus its own author.
 *
 * `deps` injects the seat runners (deps.runCodex/runGrok/runClaude/runOpenRouter) so unit tests need
 * no CLI/network.
 */
export async function runSolve(cwd, backends, options = {}, deps = {}) {
  const onPhase = typeof options.onPhase === "function" ? options.onPhase : () => {};
  onPhase("collecting-context");
  const problem = options.problemFile
    ? fs.readFileSync(options.problemFile, "utf8")
    : String(options.focusText ?? "");
  if (!problem.trim()) {
    throw new Error("Provide a problem statement: --problem-file <path> or positional text.");
  }

  const hints = collectRepoHints(cwd);
  // captureGrokSession is read by the grok runner only (every other runner ignores it) - debate
  // rebuttals resume the author's own R1 session.
  const r1Opts = { ...options, maxTurns: options.maxTurnsR1, captureGrokSession: Boolean(options.debateResume) };
  const seats = activeSeatNames(backends, options);
  const r1Runners = makeSeatRunners(cwd, backends, r1Opts, deps);
  // Claude may hand its plan in as a FILE (/council:solve has the orchestrating session plan in
  // parallel with the CLI seats): then it does not re-plan through the CLI, but it still CRITIQUES
  // like any other seat, so the critique pools stay symmetric. --skip-claude opts out of both
  // (mirrors deliberate's fileClaudeDoc gating).
  const claudePlanFromFile =
    Boolean(options.claudePlanPath || options.claudePlanWaitPath) && !options.skipClaude;

  const r1Jobs = [];
  for (const seat of allSeatNames(backends)) {
    if (seat === "claude" && claudePlanFromFile) continue; // its plan arrives via loadClaudePlan below
    if (!seats.includes(seat)) {
      // A skipped/unreachable CLI seat stays VISIBLE as an explicit skip (the job status keys off
      // "every R1 skipped" -> failed, and the report prints it). An inactive claude/OpenRouter seat
      // simply casts no plan.
      if (seat === "codex" || seat === "grok") {
        r1Jobs.push(Promise.resolve({ agent: seat, skipped: true, reason: "skip", stdout: "" }));
      }
      continue;
    }
    // R1 gets the SAME parse repair every other round has: one malformed JSON must not delete an
    // entire model's plan - it would take that seat's critiques and its ranking slot with it.
    r1Jobs.push(
      runStructuredWithRetry(r1Runners[seat], buildProposalPrompt(seat, problem, hints, options), (stdout) =>
        parsePlanDoc(stdout, seat)
      ).then((r) => ({ ...r, agent: seat }))
    );
  }

  onPhase("plans");
  let plansDone = 0;
  const r1Raw = await Promise.all(
    r1Jobs.map((job) =>
      Promise.resolve(job).then((r) => {
        plansDone += 1;
        if (r && !r.skipped) onPhase(`plans: ${r.agent} done (${plansDone}/${r1Jobs.length})`);
        return r;
      })
    )
  );
  onPhase("plans-done");
  const claudePlan = claudePlanFromFile ? await loadClaudePlan(options) : null;

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
    grokEffort: options.r2Effort ?? options.grokEffort,
    // Capture grok critic sessions so debate counters can resume them.
    captureGrokSession: Boolean(options.debateRounds >= 2 && options.debateResume)
  };
  const r2Runners = makeSeatRunners(cwd, backends, r2Opts, deps);
  const critiqueJobs = [];
  for (const plan of parsedPlans) {
    // All-to-all: every ACTIVE seat critiques every OTHER seat's plan. The pools are therefore
    // symmetric (each plan is scored by `seats` minus its own author), so rankPlans' averages are
    // comparable across plans.
    for (const critic of seats) {
      if (critic === plan.agent) continue; // never score your own plan
      const job = r2Runners[critic](buildPlanCritiquePrompt(critic, plan));
      critiqueJobs.push(
        job.then((res) => ({
          ...res,
          // The critic identity is the RUNNER seat, never a model-echoed field.
          agent: critic,
          critique: res.skipped ? null : parsePlanCritique(res.stdout, critic, plan.agent),
          aboutAgent: plan.agent
        }))
      );
    }
  }
  onPhase(`critique (${critiqueJobs.length})`);
  const r2Results = await Promise.all(critiqueJobs);
  const critiques = r2Results.map((r) => r.critique).filter(Boolean);

  const ranking = rankPlans(plans, critiques);

  let debates = [];
  if ((options.debateRounds ?? 0) > 0) {
    onPhase("debate");
    // debate.mjs can only RUN codex + grok (its runAgentPrompt routes every other name to grok), so
    // only those seats may author or critique a debate entry - a claude/OpenRouter seat must never be
    // silently impersonated by grok (fail-closed). Same effective set as the former hardcoded skip
    // list ({codex,grok} minus the skipped ones), now derived from the active seats.
    const debatable = new Set(seats.filter((seat) => seat === "codex" || seat === "grok"));
    const grokR1 = r1Raw.find((raw) => raw.agent === "grok" && !raw.skipped);
    // grok critic sessions keyed by the plan author they critiqued.
    const criticSessions = {};
    for (const r of r2Results) {
      if (r.agent === "grok" && r.sessionId && r.aboutAgent) criticSessions[r.aboutAgent] = r.sessionId;
    }
    const entries = ranking
      .filter((r) => r.blockers.length && debatable.has(r.agent))
      .map((r) => {
        const plan = parsedPlans.find((p) => p.agent === r.agent);
        if (!plan || plan.confidence < 0.7) return null;
        const critic = r.blockers.map((b) => b.from).find((from) => from !== r.agent && debatable.has(from));
        return {
          id: `plan-${r.agent}`,
          author: r.agent,
          critic: critic ?? null,
          authorSessionId: r.agent === "grok" ? grokR1?.sessionId ?? null : null,
          criticSessionId: critic === "grok" ? criticSessions[r.agent] ?? null : null,
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

  const sections = {
    header: `Problem: ${problem.trim().split(/\r?\n/)[0]}`,
    ranking: renderRankingSection(ranking),
    debate: debates.length ? renderSolveDebates(debates) : null,
    synthesis: SYNTHESIS_INSTRUCTIONS
  };

  return {
    mode: "solve",
    problem,
    plans,
    critiques,
    ranking,
    debates,
    r1: r1Results,
    r2: r2Results,
    report,
    sections
  };
}

const SYNTHESIS_INSTRUCTIONS = [
  "## Your turn (Claude) - synthesis",
  "1. Take the best-ranked plan as the skeleton; graft the strongest improvements from the others.",
  "2. Resolve or explicitly accept every blocker (debate outcomes above help).",
  "3. Present the final plan to the user for approval BEFORE implementing.",
  "4. Implementation: exactly ONE writer (policy solve_writer) on a dedicated branch; then /council:review on the diff. The writer's own verdict does not count towards approval."
].join("\n");

export function renderSolveDebates(debates) {
  const lines = ["## Debate (bounded, blockers only)"];
  for (const d of debates.filter((d) => d.round === 1)) {
    lines.push(
      `- **${d.id}** ${d.agent}${d.resumedSession ? " (resumed own R1 session)" : ""} -> **${d.stance}**: ${d.note || "(no note)"}`
    );
  }
  for (const d of debates.filter((d) => d.round === 2)) {
    lines.push(
      `  - counter by ${d.agent}: ${d.upheld ? "upholds blocker" : "withdraws blocker"} - ${d.note || "(no note)"}`
    );
  }
  return lines.join("\n");
}

function renderRankingSection(ranking) {
  const lines = ["## Ranking (avg peer overall)"];
  if (!ranking.length) {
    lines.push("(no parseable plans)");
  }
  for (const [index, entry] of ranking.entries()) {
    lines.push(
      `${index + 1}. **${entry.agent}** - avg ${formatScore(entry.avgOverall)}/10 (${entry.votes} peer votes, ${entry.blockers.length} blockers)`
    );
    for (const blocker of entry.blockers) {
      lines.push(`   - blocker (${blocker.from}): ${blocker.blocker}`);
    }
  }
  return lines.join("\n");
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
  lines.push("3. **Claude synthesis (you):** build the final plan from the best-ranked skeleton + grafted improvements; get user approval; then ONE writer implements on a branch and /council:review reviews the diff.");
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
    lines.push(renderSolveDebates(debates));
    lines.push("");
  }

  lines.push("## Your turn (Claude) - synthesis");
  lines.push("1. Take the best-ranked plan as the skeleton; graft the strongest improvements from the others.");
  lines.push("2. Resolve or explicitly accept every blocker (debate outcomes above help).");
  lines.push("3. Present the final plan to the user for approval BEFORE implementing.");
  lines.push("4. Implementation: exactly ONE writer (policy solve_writer) on a dedicated branch; then /council:review on the diff. The writer's own verdict does not count towards approval.");
  lines.push("");

  return lines.join("\n");
}
