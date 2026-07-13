#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { READONLY_DISALLOWED_TOOLS, runDeliberation } from "./lib/deliberate.mjs";
import { councilPluginRoot, findGrokBinary, probeBackends } from "./lib/discover.mjs";
import {
  DEFAULT_POLICY,
  loadPolicy,
  mergeOptionsWithPolicy,
  normalizeClaudeBackend,
  normalizeReviewers,
  skippedAgents,
  unknownReviewers
} from "./lib/policy.mjs";
import { runSolve } from "./lib/solve.mjs";
import { aggregateBenchmarks, readBenchmarks, runBenchmark } from "./lib/benchmark.mjs";
import { evaluateBudget, gatherWindowPressure, renderBudgetBreaches } from "./lib/budget.mjs";
import { aggregateMetrics, readMetrics, recordAuditMetrics, recordJobMetrics, renderMetrics } from "./lib/metrics.mjs";
import {
  collectAllTokenUsage,
  collectCodexRateLimits,
  collectGrokLimits,
  fetchClaudeLimits,
  renderLimits,
  renderTokenUsage
} from "./lib/token-usage.mjs";
import { runCommand, runCommandAsync, terminateProcessTree } from "./lib/process.mjs";
import { setTimeout as delay } from "node:timers/promises";

import { readLedgerEntries, resolveLedgerEntry } from "./lib/ledger.mjs";
import { renderOverview } from "./lib/overview.mjs";
import { colorize, formatDashboard, formatDashboardMarkdown, summarizeCouncilExtras, summarizeFindings, summarizeProgress } from "./lib/watch.mjs";
import { formatExit } from "./lib/util.mjs";
import { median } from "./lib/stats.mjs";
import { buildCodebaseModel, renderAuditReport } from "./lib/codebase-model.mjs";
import { activeReviewerCount, runAuditReview } from "./lib/audit-review.mjs";
import { runGroupedReview } from "./lib/audit-grouped-review.mjs";
import { writeAuditDoc } from "./lib/audit-doc.mjs";
import { detectCoverageCmd, detectTestCmd, loadCoverage, runAuditFix } from "./lib/audit-fix.mjs";
import { runFixLoop } from "./lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "./lib/audit-fixloop-deps.mjs";
import { makePatchReviewer, patchReviewerReady } from "./lib/audit-patch-reviewer.mjs";
import { detectLogical } from "./lib/audit-logical.mjs";
import { nodesFromGraph } from "./lib/import-graph.mjs";
import { resolveAutonomy } from "./lib/audit-autonomy.mjs";
import { reconcilePendingFixes } from "./lib/ledger.mjs";
import { runEndless } from "./lib/audit-endless.mjs";
import { runSupervised } from "./lib/supervisor.mjs";
import { runAudit } from "./lib/audit-run.mjs";
import { toSarif } from "./lib/audit-sarif.mjs";
import { buildAgentResult, withTempPrompt } from "./lib/agents.mjs";
import { writeJobHtml } from "./lib/html-report.mjs";
import { writeFixReportHtml } from "./lib/fix-report-html.mjs";
import { assembleFixMeta, changedFilesShape } from "./lib/fix-report-meta.mjs";
import { openRouterBackend } from "./lib/openrouter-agent.mjs";
import { makeCharTestGate } from "./lib/chartest-wiring.mjs";
import { addWorktree, listWorktrees, removeWorktree } from "./lib/worktree.mjs";
import { runPlanDeliberation } from "./lib/plan-deliberate.mjs";
import { parsePlanSpec, planStepTouched, planSpecDigest, renderPlanMarkdown, requestDigest, validatePlanSpec } from "./lib/plan-spec.mjs";
import { makeBuildGit, renderBuildReport, runBuild } from "./lib/build.mjs";
import { buildReviewerReady } from "./lib/build-step-reviewer.mjs";
import { collectVerdicts, evaluateApproval, selectActionable } from "./lib/verdicts.mjs";
import {
  appendLogLine,
  archiveJobResults,
  createJobLogFile,
  ensureStateDir,
  generateJobId,
  listAllJobsDirs,
  listJobs,
  nowIso,
  readJobFile,
  resolveStateDir,
  upsertJob,
  workspaceRoot,
  writeFileAtomic
} from "./lib/state.mjs";

const ROOT_DIR = councilPluginRoot();

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/council-companion.mjs setup [--json]",
      "  node scripts/council-companion.mjs review|adversarial|deliberate [flags] [focus text]",
      "  node scripts/council-companion.mjs solve [flags] [problem text]",
      "  node scripts/council-companion.mjs wait [job-id] [--follow] [--timeout <s>] [--interval <s>]",
      "  node scripts/council-companion.mjs watch [job-id] [--interval <s>] [--once] [--json]",
      "  node scripts/council-companion.mjs plan <feature-request> [--synthesizer <seat>] [--json]   (multi-model design deliberation → a validated PlanSpec; READ-ONLY)",
      "  node scripts/council-companion.mjs build --from <plan.json> [--dry-run] [--json]   (autonomous test-gated build of a PlanSpec on an isolated branch; never auto-merged)",
      "  node scripts/council-companion.mjs audit run|review|fix|endless [flags] (see below)",
      "    audit review [--groups fine|tier|lens] [--max-cells <n>] [--completeness-critic] [--areas a,b] [--churn-days <n>] [--budget <n>] [--max-units <n>] [--doc] [--write-map] [--json]",
      "    audit run [--sarif [--sarif-path <p>]] [--base <ref>] [--doc] [--json]   (self-driving audit → risk register + gate)",
      "    audit fix [--from <json>] [--autonomy <lvl>] [--min-severity P0|P1|P2] [--max-fixes <n>] [--sensitive-auto-apply] [--skip-openrouter] [--html] [--retry-on-limit] [--dry-run]",
      "    audit fix --loop [--supervise] [--flat] [--chartest] [--max-passes <n>] [--dry-streak <n>] [--resume] [--allow-untested]   (autonomous fix-until-dry on an isolated branch)",
      "    audit endless [--supervise] [--max-passes <n>] [--dry-streak <n>] [--resume]   (bounded review/propose loop)",
      "  node scripts/council-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/council-companion.mjs cancel [job-id]",
      "  node scripts/council-companion.mjs usage [--tokens] [--limits] [--days <n>] [--json]",
      "  node scripts/council-companion.mjs doctor [--no-ping] [--json]",
      "  node scripts/council-companion.mjs metrics [--days <n>] [--json]",
      "  node scripts/council-companion.mjs history [--kind <k>] [--since <days>] [--global] [--json]",
      "  node scripts/council-companion.mjs fixloop-status [job-id] [--writer <agent>] [--needed <n>] [--json]",
      "  node scripts/council-companion.mjs benchmark [--task-file <path>] [--claude-answer <path>] [--category <c>] [task text]",
      "  node scripts/council-companion.mjs benchmark --stats [--json]",
      "  node scripts/council-companion.mjs ledger [--status ...] [--resolve <fp> fixed|dismissed|ignored]",
      "  node scripts/council-companion.mjs overview [--limit <n>] [--json]",
      "  node scripts/council-companion.mjs result [job-id] [--summary|--html] [--json]",
      "  node scripts/council-companion.mjs worktree add|remove|list <slug> [--base <ref>] [--force]",
      "",
      "Flags:",
      "  --background  --base <ref>  --scope auto|working-tree|branch",
      "  --codex-model <id>  --grok-model <id>  --codex-effort <l>  --grok-effort <l>",
      "  --skip-codex  --skip-grok  --claude-findings <path>  --claude-findings-wait <path>",
      "  --wait-timeout <seconds>  --peer-severities P0,P1  --debate-rounds 0|1|2  --debate-resume",
      "  --budget-guard <percent>  --force-budget  --json",
      "  solve only: --problem-file <path>  --claude-plan <path>  --claude-plan-wait <path>",
      "",
      "Modes:",
      "  review       - parallel Codex + Grok review (single round)",
      "  adversarial  - same, adversarial framing",
      "  deliberate   - Round1 independent -> Round2 peer critique (+ optional Claude file)",
      "  solve        - independent solution plans -> cross-critique with scores -> ranking",
      "",
      "Policy file (repo root): .council.yml | .council.json",
      "Models default from policy or ~/.codex/config.toml + ~/.grok/config.toml"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw?.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), config);
}

function outputResult(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json", "init", "force"],
    valueOptions: ["reviewers", "claude-backend", "claude-model", "codex-model", "grok-model", "default-mode"]
  });
  const cwd = process.cwd();

  if (options.init) {
    const result = scaffoldPolicyFile(cwd, options);
    if (options.json) {
      outputResult(result, true);
    } else if (result.written) {
      console.log(`Wrote ${result.path}\n\n${result.contents}`);
    } else {
      console.log(`${result.message}\n`);
    }
    return;
  }

  const backends = probeBackends(cwd, ROOT_DIR);
  const policy = loadPolicy(cwd);
  // Normalize like mergeOptionsWithPolicy does: a scalar YAML value
  // (reviewers: claude, codex) is a string, and mixed case would break
  // includes()/join() and mis-report readiness. Warn on unknown tokens.
  const reviewers = normalizeReviewers(policy.reviewers ?? DEFAULT_POLICY.reviewers);
  const unknown = unknownReviewers(policy.reviewers);
  if (unknown.length) {
    console.error(`Warning: .council.yml has unknown reviewer(s): ${unknown.join(", ")} (valid: claude, codex, grok).`);
  }
  const wants = (agent) => reviewers.includes(agent);
  // A reviewer is "reachable" if it participates AND a backend can run it.
  const claudeBackend = normalizeClaudeBackend(policy.claude_backend);
  const claudeReachable = !wants("claude") || claudeBackend === "session" || backends.claude.cli.available;
  const codexReachable = !wants("codex") || backends.codex.companionAvailable || backends.codex.cli.available;
  const grokReachable = !wants("grok") || backends.grok.companionAvailable || backends.grok.cli.available;
  const ready = backends.node.available && claudeReachable && codexReachable && grokReachable;

  const report = {
    ready,
    node: backends.node,
    reviewers,
    claude: {
      backend: claudeBackend,
      model: policy.claude_model,
      participates: wants("claude"),
      // session backend = the orchestrating Claude itself; always "logged in".
      cli: backends.claude.cli,
      reachable: claudeReachable
    },
    codex: {
      companion: backends.codex.companion,
      companionAvailable: backends.codex.companionAvailable,
      cli: backends.codex.cli,
      participates: wants("codex"),
      reachable: codexReachable
    },
    grok: {
      companion: backends.grok.companion,
      companionAvailable: backends.grok.companionAvailable,
      bin: backends.grok.bin,
      cli: backends.grok.cli,
      participates: wants("grok"),
      reachable: grokReachable
    },
    policy: {
      source: policy._source,
      default_mode: policy.default_mode,
      codex_model: policy.codex_model,
      grok_model: policy.grok_model,
      claude_backend: claudeBackend,
      claude_model: policy.claude_model,
      focus: policy.focus,
      agent_timeout_minutes: policy.agent_timeout_minutes
    },
    stateDir: resolveStateDir(cwd),
    nextSteps: []
  };

  if (wants("codex") && !backends.codex.companionAvailable && !backends.codex.cli.available) {
    report.nextSteps.push("Codex: `npm i -g @openai/codex` (or /plugin install codex@openai-codex), then `codex login`.");
  }
  if (wants("grok") && !backends.grok.cli.available) {
    report.nextSteps.push(
      "Grok: the binary lives at ~/.grok/bin/grok - if it exists but isn't on PATH, set GROK_BIN to it. " +
        "To install: `curl -fsSL https://x.ai/cli/install.sh | bash` then `grok login` (needs a SuperGrok/X Premium+ plan; run this in a real terminal, the URL bot-blocks headless curls)."
    );
  }
  if (wants("claude") && claudeBackend === "spawn" && !backends.claude.cli.available) {
    report.nextSteps.push(
      "Claude (spawn backend): `npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in (or set CLAUDE_BIN). Or use claude_backend: session (no separate CLI)."
    );
  }
  if (ready) {
    report.nextSteps.push("Try `/council:review` (3-way deliberate by default) or `/council:review --quick --background`.");
  }
  if (!policy._source) {
    report.nextSteps.push("No .council.yml found - run `/council:setup --init` to scaffold one.");
  }

  if (options.json) {
    outputResult(report, true);
    return;
  }

  const flag = (ok) => (ok ? "ok" : "MISSING");
  const reviewerLine = (agent, on, detail) =>
    `  ${agent}: ${reviewers.includes(agent) ? `reviewer [${flag(on)}]` : "not a reviewer"}${detail ? ` - ${detail}` : ""}`;
  const lines = [
    `Council setup: ${ready ? "READY" : "PARTIAL / NOT READY"}`,
    `  reviewers: ${reviewers.join(", ")}`,
    `  node: ${backends.node.detail}`,
    reviewerLine(
      "claude",
      claudeReachable,
      claudeBackend === "session"
        ? "session backend (orchestrator)"
        : `spawn backend - ${backends.claude.cli.available ? backends.claude.cli.detail : "CLI not found"}${policy.claude_model ? ` (model ${policy.claude_model})` : ""}`
    ),
    reviewerLine(
      "codex",
      codexReachable,
      backends.codex.companionAvailable ? "companion" : backends.codex.cli.available ? backends.codex.cli.detail : "not found"
    ),
    reviewerLine(
      "grok",
      grokReachable,
      backends.grok.cli.available ? backends.grok.cli.detail : "not found"
    ),
    `  policy: ${policy._source ?? "(none - using defaults)"}`,
    `  state: ${report.stateDir}`,
    "Next:"
  ];
  for (const step of report.nextSteps) lines.push(`  - ${step}`);
  console.log(`${lines.join("\n")}\n`);
}

/**
 * Scaffold a `.council.yml` in the workspace root from current defaults +
 * any --reviewers/--claude-backend/--claude-model/--codex-model/--grok-model
 * /--default-mode overrides. Refuses to clobber an existing file without --force.
 */
function scaffoldPolicyFile(cwd, options) {
  const root = workspaceRoot(cwd);
  const target = path.join(root, ".council.yml");
  if (fs.existsSync(target) && !options.force) {
    return {
      written: false,
      path: target,
      message: `${target} already exists. Re-run with --force to overwrite, or edit it directly.`
    };
  }

  const reviewers = normalizeReviewers(options.reviewers ?? DEFAULT_POLICY.reviewers);
  const claudeBackend = normalizeClaudeBackend(options["claude-backend"]);
  // Model strings are interpolated into YAML - a newline or '#' could smuggle
  // extra keys or truncate parsing. Reject them rather than emit broken config.
  const claudeModel = sanitizeModelValue(options["claude-model"], "--claude-model");
  const codexModel = sanitizeModelValue(options["codex-model"], "--codex-model");
  const grokModel = sanitizeModelValue(options["grok-model"], "--grok-model");
  // default_mode is currently INFORMATIONAL only: no code path reads policy.default_mode to pick a mode
  // (the slash commands dispatch via explicit --quick/--adversarial/--loop flags). Default to
  // DEFAULT_POLICY's own value so an un-flagged scaffold doesn't silently diverge from it (council
  // companion-cli nit).
  const defaultMode = options["default-mode"] === "deliberate" ? "deliberate" : DEFAULT_POLICY.default_mode;

  const contents = [
    "# Council policy. Unknown keys are ignored; re-run /council:setup --init to regenerate.",
    "version: 1",
    `default_mode: ${defaultMode}   # review | deliberate`,
    "",
    `# Who reviews. Remove an agent to skip it entirely.`,
    `reviewers: [${reviewers.join(", ")}]`,
    "",
    "# Claude reviewer: 'session' reuses the orchestrating Claude; 'spawn' runs an",
    "# independent `claude -p --model <model>` so the reviewer is decoupled from the",
    "# orchestrator (needs the Claude CLI logged in).",
    `claude_backend: ${claudeBackend}`,
    `claude_model:${claudeModel ? ` ${claudeModel}` : " null"}   # e.g. claude-opus-4-8 (spawn backend only)`,
    "",
    "# Pin external models (leave null to use each CLI's configured default).",
    `codex_model:${codexModel ? ` ${codexModel}` : " null"}`,
    `grok_model:${grokModel ? ` ${grokModel}` : " null"}`,
    "",
    "agent_timeout_minutes: 30",
    "verify_findings: false",
    "budget_guard: 0",
    ""
  ].join("\n");

  fs.writeFileSync(target, contents, "utf8");
  return { written: true, path: target, contents };
}

/**
 * Reject model strings that could break or inject into the scaffolded YAML.
 * Model ids are short tokens (letters/digits/.-_) plus optional whitespace-free
 * form; anything with newlines, '#', quotes, or ':' is refused.
 */
function sanitizeModelValue(value, flag) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(
      `Invalid ${flag} value '${value}': model ids may contain only letters, digits, '.', '_' and '-'.`
    );
  }
  return text;
}

function resolveAgentModels(options = {}) {
  const legacy = options.model ?? null;
  return {
    codexModel: options.codexModel ?? options["codex-model"] ?? legacy ?? null,
    grokModel: options.grokModel ?? options["grok-model"] ?? legacy ?? null,
    codexEffort: options.codexEffort ?? options["codex-effort"] ?? null,
    grokEffort: options.grokEffort ?? options["grok-effort"] ?? null
  };
}

function buildCodexReviewArgs(options, adversarial, focusText) {
  const { codexModel } = resolveAgentModels(options);
  const args = [];
  if (options.base) args.push("--base", options.base);
  if (options.scope) args.push("--scope", options.scope);
  if (codexModel) args.push("--model", codexModel);
  // Forward the focus text regardless of mode - plain review/--quick must honor it too, not only
  // adversarial (council companion-cli P2: it was silently dropped for the companion path while the
  // grok CLI-direct fallback honored it, so identical commands behaved differently by installed backend).
  if (focusText) args.push(focusText);
  return args;
}

function buildGrokReviewArgs(options, adversarial, focusText) {
  const { grokModel, grokEffort } = resolveAgentModels(options);
  const args = [];
  if (options.base) args.push("--base", options.base);
  if (options.scope) args.push("--scope", options.scope);
  if (grokModel) args.push("--model", grokModel);
  if (grokEffort) args.push("--effort", grokEffort);
  if (focusText) args.push(focusText);
  return args;
}

async function runCodexReview(cwd, backends, options, adversarial, focusText) {
  if (options.skipCodex) {
    return { agent: "codex", skipped: true, reason: "skipped by flag" };
  }
  if (!backends.codex.companionAvailable) {
    return { agent: "codex", skipped: true, reason: "codex companion not found" };
  }

  const { codexModel } = resolveAgentModels(options);
  const command = adversarial ? "adversarial-review" : "review";
  const childArgs = buildCodexReviewArgs(options, adversarial, focusText);
  const args = [backends.codex.companion, command, ...childArgs];
  const result = await runCommandAsync(process.execPath, args, {
    cwd,
    timeoutMs: options.agentTimeoutMs
  });
  return buildAgentResult("codex", "codex-companion", result, {
    companion: backends.codex.companion,
    model: codexModel ?? "(Codex default from ~/.codex/config.toml)",
    skipped: false,
    command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`
  });
}

async function runGrokReview(cwd, backends, options, adversarial, focusText) {
  if (options.skipGrok) {
    return { agent: "grok", skipped: true, reason: "skipped by flag" };
  }

  const { grokModel, grokEffort } = resolveAgentModels(options);

  if (backends.grok.companionAvailable) {
    const command = adversarial ? "adversarial-review" : "review";
    const childArgs = buildGrokReviewArgs(options, adversarial, focusText);
    const args = [backends.grok.companion, command, ...childArgs];
    const result = await runCommandAsync(process.execPath, args, {
      cwd,
      timeoutMs: options.agentTimeoutMs
    });
    return buildAgentResult("grok", "grok-companion", result, {
      companion: backends.grok.companion,
      model: grokModel ?? "(Grok default from ~/.grok/config.toml [models].default)",
      skipped: false,
      command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`
    });
  }

  if (!backends.grok.cli.available) {
    return { agent: "grok", skipped: true, reason: "grok CLI not found" };
  }

  const bin = findGrokBinary();
  const focus = focusText ? `\nFocus: ${focusText}` : "";
  const kind = adversarial ? "adversarial code review" : "code review";
  const prompt = [
    `Perform a read-only ${kind} of the current repository git changes.`,
    "Use git status/diff. Do not edit files.",
    "Report bugs, risks, missing tests, and a P0/P1/P2 summary.",
    focus
  ].join("\n");

  return withTempPrompt(
    prompt,
    async (promptFile) => {
      const args = [
        "--prompt-file",
        promptFile,
        "--cwd",
        cwd,
        "--always-approve",
        "--disallowed-tools",
        READONLY_DISALLOWED_TOOLS,
        "--max-turns",
        "40",
        "--output-format",
        "plain"
      ];
      if (grokModel) args.push("--model", grokModel);
      if (grokEffort) args.push("--effort", grokEffort);

      const result = await runCommandAsync(bin, args, { cwd, timeoutMs: options.agentTimeoutMs });
      return buildAgentResult("grok", "grok-cli-direct", result, {
        companion: bin,
        model: grokModel ?? "(Grok default from ~/.grok/config.toml [models].default)",
        skipped: false,
        command: `${bin} ${args.filter((a) => a !== promptFile).join(" ")}`
      });
    },
    { dir: resolveStateDir(cwd) }
  );
}


function renderCouncilReport(job, results) {
  const lines = [
    `# Council Review - ${job.id}`,
    `Status: ${job.status}`,
    `Kind: ${job.kind}`,
    `Summary: ${job.summary}`,
    "",
    "## How to use this report",
    "- Treat findings as hypotheses until verified against the code.",
    "- Prefer consensus (same issue from multiple agents) and clear P0 bugs.",
    "- Claude (you / the orchestrator) decides what to fix; reviewers stay read-only.",
    ""
  ];

  for (const result of results) {
    lines.push(`## ${result.agent.toUpperCase()}`);
    if (result.skipped) {
      lines.push(`_Skipped:_ ${result.reason}`);
      lines.push("");
      continue;
    }
    lines.push(`Backend: ${result.backend ?? "unknown"}`);
    lines.push(`Model: ${result.model ?? "default"}`);
    if (result.companion) lines.push(`Binary/companion: ${result.companion}`);
    lines.push(`Exit: ${formatExit(result)}`);
    if (result.command) lines.push(`Command: \`${result.command}\``);
    lines.push("");
    lines.push(result.stdout?.trim() || result.stderr?.trim() || "(no output)");
    lines.push("");
  }

  lines.push("## Claude synthesis checklist");
  lines.push("1. List consensus findings (mentioned by >=2 agents).");
  lines.push("2. List unique high-severity findings with file:line verification.");
  lines.push("3. Drop nits unless cheap and clearly correct.");
  lines.push("4. Propose a minimal fix plan - do not implement unless the user asks.");
  lines.push("");
  return lines.join("\n");
}

function makePhaseReporter(root, job) {
  return (phase) => {
    try {
      job.phase = phase;
      job.updatedAt = nowIso();
      // Timestamped timeline for per-phase durations (metrics.phaseDurations derives
      // them). Capped so a pathological run can't grow the job file unbounded.
      if (!Array.isArray(job.phaseTimeline)) job.phaseTimeline = [];
      job.phaseTimeline.push({ phase, atMs: Date.now() });
      if (job.phaseTimeline.length > 300) job.phaseTimeline = job.phaseTimeline.slice(-300);
      upsertJob(root, job);
      appendLogLine(job.logFile, `Phase: ${phase}`);
    } catch {
      /* progress reporting must never break a run */
    }
  };
}

function jobTitle(kind) {
  if (kind === "solve") return "Council Solve";
  if (kind === "deliberate") return "Council Deliberation";
  if (kind === "adversarial") return "Council Adversarial Review";
  return "Council Review";
}

function jobSummary(mergedOpts) {
  const focusText = mergedOpts.focusText ?? "";
  return focusText
    ? focusText.slice(0, 100)
    : mergedOpts.base
      ? `branch vs ${mergedOpts.base}`
      : "uncommitted / auto target";
}

async function executeCouncilReview(cwd, options, existingJob = null) {
  const policy = loadPolicy(cwd);
  // Only probe the Claude CLI when the spawn backend actually needs it - avoids
  // `claude --version` latency on every session-backend run.
  const needsClaudeProbe = normalizeClaudeBackend(options.claudeBackend ?? policy.claude_backend) === "spawn";
  const backends = probeBackends(cwd, ROOT_DIR, { probeClaude: needsClaudeProbe });
  const mergedOpts = mergeOptionsWithPolicy(options, policy);
  const adversarial = Boolean(mergedOpts.adversarial);
  const deliberate = Boolean(mergedOpts.deliberate);
  const solve = Boolean(mergedOpts.solve);
  const focusText = mergedOpts.focusText ?? "";
  const root = workspaceRoot(cwd);

  const kind = solve ? "solve" : deliberate ? "deliberate" : adversarial ? "adversarial" : "review";
  const title = jobTitle(kind);
  const summary = jobSummary(mergedOpts);
  const job = existingJob
    ? {
        ...existingJob,
        kind,
        title,
        summary,
        status: "running",
        phase: deliberate ? "r1" : "running",
        workspaceRoot: root,
        updatedAt: nowIso(),
        finishedAt: null,
        pid: process.pid,
        exitCode: null,
        results: null,
        report: null,
        output: null,
        deliberation: null
      }
    : {
        id: generateJobId("council"),
        kind,
        title,
        summary,
        status: "running",
        phase: deliberate ? "r1" : "running",
        workspaceRoot: root,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        finishedAt: null,
        pid: process.pid,
        logFile: null,
        exitCode: null,
        results: null,
        report: null,
        deliberation: null
      };
  job.createdAt = job.createdAt ?? nowIso();
  job.logFile = job.logFile || createJobLogFile(root, job.id);
  upsertJob(root, job);
  appendLogLine(job.logFile, `Starting ${job.title}`);
  if (mergedOpts.policySource) appendLogLine(job.logFile, `Policy: ${mergedOpts.policySource}`);
  if (mergedOpts.codexEffort) {
    const warning =
      "Codex reasoning effort comes from ~/.codex/config.toml (model_reasoning_effort); --codex-effort/codex_effort is ignored.";
    console.error(warning);
    appendLogLine(job.logFile, warning);
  }

  // Any throw below (bad base ref, git failure, empty problem, ...) must not
  // leave the job stuck in status=running — mark it failed, then rethrow.
  try {
    return await executeKind();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = {
      ...job,
      status: "failed",
      phase: "error",
      exitCode: 1,
      stderr: message,
      output: message,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null
    };
    upsertJob(root, failed);
    recordJobMetrics(cwd, failed);
    appendLogLine(job.logFile, `Failed: ${message}`);
    throw error;
  }

  async function executeKind() {
  if (solve) {
    appendLogLine(job.logFile, "Solve protocol: independent plans -> plan critique -> ranking");
    const solveRun = await runSolve(cwd, backends, {
      ...mergedOpts,
      policyFocus: policy.focus,
      onPhase: makePhaseReporter(root, job)
    });
    const r1Failed = solveRun.r1.some((r) => !r.skipped && r.status !== 0);
    const allSkipped = solveRun.r1.every((r) => r.skipped && r.agent !== "claude");
    const planParseFailures = solveRun.plans.filter((p) => !p.parseOk).length;
    const finished = {
      ...job,
      status: allSkipped
        ? "failed"
        : r1Failed || planParseFailures
          ? "completed_with_errors"
          : "completed",
      phase: "done",
      exitCode: allSkipped ? 1 : 0,
      stateVersion: 2,
      results: archiveJobResults(root, job.id, [...solveRun.r1, ...solveRun.r2]),
      solve: {
        ranking: solveRun.ranking,
        plans: solveRun.plans.map((p) => ({ ...p, raw: undefined })),
        debates: solveRun.debates
      },
      report: solveRun.report,
      reportSections: solveRun.sections ?? null,
      output: solveRun.report,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null
    };
    upsertJob(root, finished);
    recordJobMetrics(cwd, finished);
    appendLogLine(job.logFile, `Solve report stored (${solveRun.report.length} chars)`);
    return finished;
  }

  if (deliberate) {
    appendLogLine(job.logFile, "Deliberate protocol: R1 independent -> R2 peer critique");
    const deliberation = await runDeliberation(cwd, backends, {
      ...mergedOpts,
      skipCodex: mergedOpts.skipCodex,
      skipGrok: mergedOpts.skipGrok,
      claudeFindingsPath: mergedOpts.claudeFindingsPath,
      claudeFindingsWaitPath: mergedOpts.claudeFindingsWaitPath,
      waitTimeoutMs: mergedOpts.waitTimeoutMs,
      policyFocus: policy.focus,
      resume: mergedOpts.resume,
      verifyFindings: mergedOpts.verifyFindings,
      claudeBackend: mergedOpts.claudeBackend,
      claudeModel: mergedOpts.claudeModel,
      skipClaude: mergedOpts.skipClaude,
      jobId: job.id,
      nowIso: nowIso(),
      nowMs: Date.now(),
      onPhase: makePhaseReporter(root, job)
    });
    const r1Failed = deliberation.r1.some((r) => !r.skipped && r.status !== 0);
    const allSkipped = deliberation.r1.every((r) => r.skipped && r.agent !== "claude");
    // Agents can exit 0 with unparsable JSON - that must not look like success.
    const r1ParseFailures = deliberation.r1.filter(
      (r) => !r.skipped && r.findings && r.findings.parseOk === false
    ).length;
    const finished = {
      ...job,
      status: allSkipped
        ? "failed"
        : r1Failed || r1ParseFailures
          ? "completed_with_errors"
          : "completed",
      phase: "done",
      exitCode: allSkipped ? 1 : 0,
      stateVersion: 2,
      results: archiveJobResults(root, job.id, [
        ...deliberation.r1,
        ...deliberation.r2,
        ...(deliberation.debates ?? [])
      ]),
      deliberation: {
        context: deliberation.context,
        merged: deliberation.merged,
        debates: deliberation.debates ?? [],
        verdicts: collectVerdicts(deliberation.r1),
        // Keep the metrics/dashboard inputs on the slimmed job: without these,
        // recordJobMetrics records verify:null / parseFailures:null for real runs.
        verification: deliberation.verification ?? null,
        parseFailures: deliberation.parseFailures ?? null,
        claudeIncluded: deliberation.claudeIncluded
      },
      report: deliberation.report,
      reportSections: deliberation.sections ?? null,
      output: deliberation.report,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null
    };
    upsertJob(root, finished);
    recordJobMetrics(cwd, finished);
    appendLogLine(job.logFile, `Deliberation stored (${deliberation.report.length} chars)`);
    return finished;
  }

  const tasks = [
    runCodexReview(cwd, backends, mergedOpts, adversarial, focusText),
    runGrokReview(cwd, backends, mergedOpts, adversarial, focusText)
  ];
  const results = await Promise.all(tasks);
  appendLogLine(job.logFile, `Agents finished: ${results.map((r) => `${r.agent}=${r.skipped ? "skip" : r.status}`).join(", ")}`);

  const anyFailed = results.some((r) => !r.skipped && r.status !== 0);
  const allSkipped = results.every((r) => r.skipped);
  const report = renderCouncilReport(job, results);
  const reviewSection = results
    .map((r) =>
      r.skipped
        ? `## ${r.agent}\n_Skipped:_ ${r.reason}`
        : `## ${r.agent} (${r.backend ?? "?"} - exit ${formatExit(r)})\n${String(r.stdout ?? "")
            .split(/\r?\n/)
            .slice(0, 40)
            .join("\n")}`
    )
    .join("\n\n");
  const REVIEW_SECTION_MAX_CHARS = 12_000;
  const sections = {
    header: `Kind: ${kind} - ${summary}`,
    merged: null,
    review:
      reviewSection.length > REVIEW_SECTION_MAX_CHARS
        ? `${reviewSection.slice(0, REVIEW_SECTION_MAX_CHARS)}\n[... summary truncated - use result without --summary for the full report ...]`
        : reviewSection
  };

  const finished = {
    ...job,
    status: allSkipped ? "failed" : anyFailed ? "completed_with_errors" : "completed",
    phase: "done",
    exitCode: allSkipped ? 1 : 0,
    stateVersion: 2,
    results: archiveJobResults(root, job.id, results),
    report,
    reportSections: sections,
    output: report,
    finishedAt: nowIso(),
    updatedAt: nowIso(),
    pid: null
  };
  upsertJob(root, finished);
  recordJobMetrics(cwd, finished);
  appendLogLine(job.logFile, `Stored report (${report.length} chars)`);
  return finished;
  }
}

function spawnBackgroundWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "council-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "worker", "--job-id", jobId, "--cwd", cwd], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function secondsToMs(value, flagName) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${flagName} must be a positive number of seconds.`);
  }
  return Math.round(seconds * 1000);
}

async function handleReview(argv, adversarial, deliberate = false, solve = false) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "base",
      "scope",
      "model",
      "codex-model",
      "grok-model",
      "codex-effort",
      "grok-effort",
      "claude-findings",
      "claude-findings-wait",
      "wait-timeout",
      "peer-severities",
      "debate-rounds",
      "problem-file",
      "claude-plan",
      "claude-plan-wait",
      "budget-guard",
      "reviewers",
      "claude-backend",
      "claude-model",
      "cwd"
    ],
    // "wait" is accepted (but unused) for backward compatibility with docs/slash-commands that mention
    // --wait as the (default) opposite of --background - omitting --background already waits
    // synchronously, so it is intentionally a no-op rather than an unknown-flag error (council
    // companion-cli nit).
    booleanOptions: ["json", "background", "wait", "skip-codex", "skip-grok", "skip-claude", "debate-resume", "force-budget", "resume", "verify"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const focusText = positionals.join(" ").trim();
  const waitTimeoutMs = secondsToMs(options["wait-timeout"], "--wait-timeout");
  // A typo like `--reviewers gork` would silently fall back to all three (more
  // reviewers than intended). Surface the dropped tokens instead of swallowing.
  const unknownRev = unknownReviewers(options.reviewers);
  if (unknownRev.length) {
    console.error(`Warning: ignoring unknown --reviewers value(s): ${unknownRev.join(", ")} (valid: claude, codex, grok).`);
  }
  const request = {
    adversarial,
    deliberate,
    solve,
    focusText,
    base: options.base,
    scope: options.scope,
    model: options.model,
    codexModel: options["codex-model"],
    grokModel: options["grok-model"],
    codexEffort: options["codex-effort"],
    grokEffort: options["grok-effort"],
    claudeFindingsPath: options["claude-findings"]
      ? path.resolve(cwd, options["claude-findings"])
      : null,
    claudeFindingsWaitPath: options["claude-findings-wait"]
      ? path.resolve(cwd, options["claude-findings-wait"])
      : null,
    problemFile: options["problem-file"] ? path.resolve(cwd, options["problem-file"]) : null,
    claudePlanPath: options["claude-plan"] ? path.resolve(cwd, options["claude-plan"]) : null,
    claudePlanWaitPath: options["claude-plan-wait"]
      ? path.resolve(cwd, options["claude-plan-wait"])
      : null,
    peerCritiqueSeverities: options["peer-severities"] ?? undefined,
    debateRounds: options["debate-rounds"] != null ? Number(options["debate-rounds"]) : undefined,
    debateResume: options["debate-resume"] ? true : undefined,
    resume: options.resume ? true : undefined,
    verifyFindings: options.verify ? true : undefined,
    reviewers: options.reviewers ?? undefined,
    claudeBackend: options["claude-backend"] ?? undefined,
    claudeModel: options["claude-model"] ?? undefined,
    skipClaude: options["skip-claude"] ? true : undefined,
    budgetGuard: options["budget-guard"] != null ? Number(options["budget-guard"]) : undefined,
    forceBudget: options["force-budget"] ? true : undefined,
    waitTimeoutMs,
    skipCodex: Boolean(options["skip-codex"]),
    skipGrok: Boolean(options["skip-grok"])
  };

  // Budget guard: refuse to start the expensive multi-agent modes when a
  // provider window is over threshold. review/adversarial are cheaper and not
  // gated. Fails CLOSED when limits cannot be read (a guard that silently
  // passes is worse than none).
  const guardPolicy = mergeOptionsWithPolicy(request, loadPolicy(cwd));
  if ((deliberate || solve) && guardPolicy.budgetGuard > 0 && !guardPolicy.forceBudget) {
    const pressure = await gatherWindowPressure();
    // Use the RESOLVED skips (reviewers list + explicit flags), not the raw
    // request flags: a provider dropped via `reviewers:` must not gate the run
    // on its own usage. Claude spawn draws on the same Claude window as usage.
    const skipAgents = skippedAgents(guardPolicy, { includeClaude: true });
    const { breaches, checked, unreadable } = evaluateBudget(pressure, guardPolicy.budgetGuard, skipAgents);
    // Fail closed if ANY participating provider's limits are unreadable - a guard
    // that only checks the readable providers would silently under-protect.
    if (breaches.length || unreadable.length || !checked) {
      const reason = breaches.length
        ? `the following provider windows are at or above the threshold:\n${renderBudgetBreaches(breaches)}`
        : unreadable.length
          ? `limits could not be read for: ${unreadable.join(", ")} - failing closed.`
          : "no provider window data could be read (limits unavailable) - failing closed.";
      const msg = `Budget guard (${guardPolicy.budgetGuard}%): ${reason}\nRe-run with --force-budget to override.`;
      if (options.json) {
        outputResult(
          {
            budgetBlocked: true,
            threshold: guardPolicy.budgetGuard,
            breaches,
            checked,
            unreadable,
            reason: breaches.length ? "over-threshold" : "unreadable-limits"
          },
          true
        );
      } else {
        console.error(msg);
      }
      process.exitCode = 2;
      return;
    }
  }

  if (options.background) {
    const root = workspaceRoot(cwd);
    const kind = solve ? "solve" : deliberate ? "deliberate" : adversarial ? "adversarial" : "review";
    const job = {
      id: generateJobId("council"),
      kind,
      title: jobTitle(kind),
      summary: focusText.slice(0, 100) || (options.base ? `vs ${options.base}` : "auto"),
      status: "queued",
      phase: "queued",
      workspaceRoot: root,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      pid: null,
      logFile: null,
      request,
      results: null,
      report: null,
      output: null
    };
    job.logFile = createJobLogFile(root, job.id);
    upsertJob(root, job);
    appendLogLine(job.logFile, "Queued council background run.");

    const child = spawnBackgroundWorker(cwd, job.id);
    job.pid = child.pid ?? null;
    job.status = "running";
    job.phase = "running";
    job.updatedAt = nowIso();
    upsertJob(root, job);

    outputResult(
      options.json
        ? { jobId: job.id, status: job.status }
        : `${job.title} started in background as ${job.id}. Check /council:status ${job.id}.\n`,
      options.json
    );
    return;
  }

  const finished = await executeCouncilReview(cwd, request);
  outputResult(options.json ? finished : finished.report, options.json);
  if (finished.exitCode) process.exitCode = finished.exitCode;
}

async function handleWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["job-id", "cwd"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const root = workspaceRoot(cwd);
  const job = readJobFile(root, options["job-id"]);
  if (!job) throw new Error(`Unknown council job ${options["job-id"]}`);

  job.status = "running";
  job.phase = "running";
  job.pid = process.pid;
  job.updatedAt = nowIso();
  upsertJob(root, job);

  try {
    const request = job.request ?? {};
    await executeCouncilReview(cwd, request, job);
  } catch (error) {
    const finished = {
      ...job,
      status: "failed",
      phase: "error",
      stderr: error instanceof Error ? error.message : String(error),
      output: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null,
      exitCode: 1
    };
    upsertJob(root, finished);
    throw error;
  }
}

function resolveJob(cwd, jobId) {
  const root = workspaceRoot(cwd);
  const jobs = listJobs(root);
  if (jobId) {
    return readJobFile(root, jobId) ?? jobs.find((j) => j.id === jobId) ?? null;
  }
  if (!jobs.length) return null;
  return readJobFile(root, jobs[0].id) ?? jobs[0];
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json", "all"] });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  if (positionals[0]) {
    const job = resolveJob(cwd, positionals[0]);
    if (!job) throw new Error(`Job not found: ${positionals[0]}`);
    outputResult(
      options.json
        ? { job }
        : `Job ${job.id}\n  status: ${job.status}\n  phase:  ${job.phase ?? "-"}\n  title:  ${job.title}\n  summary:${job.summary}\n  updated:${job.updatedAt}\n`,
      options.json
    );
    return;
  }
  const jobs = listJobs(root);
  if (options.json) {
    outputResult({ jobs, stateDir: resolveStateDir(cwd) }, true);
    return;
  }
  if (!jobs.length) {
    console.log("No council jobs yet.\n");
    return;
  }
  console.log("Council jobs (newest first):");
  for (const job of jobs.slice(0, options.all ? 50 : 10)) {
    const active = job.status === "running" || job.status === "queued";
    const phaseTag = active && job.phase && job.phase !== "running" ? ` [${job.phase}]` : "";
    console.log(`  ${job.id}  ${String(job.status).padEnd(22)}${phaseTag}  ${job.title} - ${job.summary ?? ""}`);
  }
  console.log("");
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json", "summary", "html"] });
  const cwd = process.cwd();
  const job = resolveJob(cwd, positionals[0]);
  if (!job) throw new Error("No council jobs found.");
  if (job.status === "running" || job.status === "queued") {
    outputResult(
      options.json ? { job, pending: true } : `Job ${job.id} is still ${job.status}.\n`,
      options.json
    );
    return;
  }
  if (options.html) {
    const file = writeJobHtml(cwd, job);
    outputResult(options.json ? { jobId: job.id, html: file } : `HTML report written: ${file}\n`, options.json);
    return;
  }
  if (options.summary) {
    const sections = job.reportSections;
    if (!sections) {
      if (!options.json) console.log("(no summary sections stored for this job - showing full report)\n");
      outputResult(options.json ? { jobId: job.id, status: job.status, sections: null, report: job.report ?? null } : job.report || job.output || "(no report stored)", options.json);
      return;
    }
    if (options.json) {
      outputResult({ jobId: job.id, status: job.status, kind: job.kind, sections }, true);
      return;
    }
    const text = [sections.header, sections.merged, sections.ranking, sections.debate, sections.synthesis, sections.review]
      .filter(Boolean)
      .join("\n\n");
    console.log(text || "(empty summary)");
    return;
  }
  if (options.json) {
    outputResult(job, true);
    return;
  }
  console.log(job.report || job.output || "(no report stored)");
}

async function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json", "no-ping"] });
  const cwd = process.cwd();
  const backends = probeBackends(cwd, ROOT_DIR);
  const policy = loadPolicy(cwd);
  const claudeSpawnRequired =
    normalizeClaudeBackend(policy.claude_backend) === "spawn" &&
    normalizeReviewers(policy.reviewers ?? DEFAULT_POLICY.reviewers).includes("claude");
  const checks = [];

  // 1. CLI availability / versions
  checks.push({ name: "node", ok: backends.node.available, detail: backends.node.detail });
  checks.push({
    name: "codex-cli",
    ok: backends.codex.cli.available,
    detail: backends.codex.cli.detail
  });
  checks.push({
    name: "codex-companion",
    ok: backends.codex.companionAvailable,
    detail: backends.codex.companion ?? "not found"
  });
  checks.push({ name: "grok-cli", ok: backends.grok.cli.available, detail: backends.grok.cli.detail });
  checks.push({
    name: claudeSpawnRequired ? "claude-cli (spawn backend)" : "claude-cli (optional)",
    // Required only when policy actually configures the spawn backend for a
    // participating Claude reviewer; otherwise the session backend needs no CLI.
    ok: claudeSpawnRequired ? backends.claude.cli.available : true,
    detail: backends.claude.cli.available
      ? backends.claude.cli.detail
      : claudeSpawnRequired
        ? "not found - required because .council.yml sets claude_backend: spawn"
        : "not found - spawn backend unavailable, session backend (default) still works"
  });

  // 2. State dir writable
  let stateOk = false;
  let stateDetail = "";
  try {
    const dir = resolveStateDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    stateOk = true;
    stateDetail = dir;
  } catch (error) {
    stateDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: "state-dir writable", ok: stateOk, detail: stateDetail });

  // 3. Window limits reachable
  const homeDir = os.homedir();
  const claudeLimits = await fetchClaudeLimits(path.join(homeDir, ".claude"));
  checks.push({
    name: "claude limits",
    ok: !claudeLimits?.error,
    detail: claudeLimits?.error ?? `5h ${claudeLimits.fiveHour?.usedPercent ?? "?"}% / weekly ${claudeLimits.sevenDay?.usedPercent ?? "?"}%`
  });

  // 4. Live agent pings (the expensive part - a 1-sentence round trip each).
  // --no-ping skips them for a fast, quota-free offline check.
  const pingPrompt = "Reply with exactly: COUNCIL-OK (nothing else).";
  const agentChecks = options["no-ping"]
    ? []
    : await Promise.all([
    (async () => {
      const res = backends.codex.companionAvailable
        ? await runCodexStructuredPing(cwd, backends, pingPrompt)
        : { ok: false, detail: "codex companion not found" };
      return { name: "codex ping", ...res };
    })(),
    (async () => {
      const res = backends.grok.cli.available
        ? await runGrokPing(cwd, backends, pingPrompt)
        : { ok: false, detail: "grok cli not found" };
      return { name: "grok ping", ...res };
    })()
  ]);
  checks.push(...agentChecks);

  const ready = checks.every((c) => c.ok);
  if (options.json) {
    outputResult({ ready, checks, stateDir: resolveStateDir(cwd) }, true);
    return;
  }
  const lines = [`Council doctor: ${ready ? "ALL OK" : "PROBLEMS FOUND"}`];
  for (const c of checks) {
    lines.push(`  [${c.ok ? "ok" : "!!"}] ${c.name.padEnd(20)} ${c.detail ?? ""}`);
  }
  console.log(`${lines.join("\n")}\n`);
  if (!ready) process.exitCode = 1;
}

function pingFailDetail(result) {
  const snippet = String(result.stderr || result.stdout || "").trim().replace(/\s+/g, " ").slice(0, 120);
  return `exit ${result.status}${result.timedOut ? " (timeout)" : ""}${snippet ? ` - ${snippet}` : ""}`;
}

async function runCodexStructuredPing(cwd, backends, prompt) {
  try {
    return await withTempPrompt(
      prompt,
      async (promptFile) => {
        const args = [backends.codex.companion, "task", "--prompt-file", promptFile];
        const result = await runCommandAsync(process.execPath, args, { cwd, timeoutMs: 120_000 });
        const ok = result.status === 0 && /COUNCIL-OK/.test(result.stdout);
        return { ok, detail: ok ? "responded" : pingFailDetail(result) };
      },
      { dir: resolveStateDir(cwd) }
    );
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function runGrokPing(cwd, backends, prompt) {
  const bin = backends.grok.bin ?? findGrokBinary();
  try {
    return await withTempPrompt(
      prompt,
      async (promptFile) => {
        // Match production grok invocation: auto-approve + read-only lockdown,
        // else a tool attempt or approval gate hangs the ping until timeout.
        const args = [
          "--prompt-file",
          promptFile,
          "--cwd",
          cwd,
          "--always-approve",
          "--disallowed-tools",
          READONLY_DISALLOWED_TOOLS,
          "--max-turns",
          "1",
          "--output-format",
          "plain"
        ];
        const result = await runCommandAsync(bin, args, { cwd, timeoutMs: 120_000 });
        const ok = result.status === 0 && /COUNCIL-OK/.test(result.stdout);
        return { ok, detail: ok ? "responded" : pingFailDetail(result) };
      },
      { dir: resolveStateDir(cwd) }
    );
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function handleHistory(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["kind", "since", "status", "limit"],
    booleanOptions: ["json", "global"]
  });
  const cwd = process.cwd();
  const limit = options.limit != null ? Math.max(1, Number(options.limit)) : 60;
  const sinceMs = options.since ? Date.now() - Number(options.since) * 86_400_000 : 0;
  if (options.since != null && !Number.isFinite(Number(options.since))) {
    throw new Error("--since must be a number of days");
  }

  const sources = options.global
    ? listAllJobsDirs()
    : [{ workspace: path.basename(resolveStateDir(cwd)), jobsDir: path.join(resolveStateDir(cwd), "jobs") }];

  const rows = [];
  for (const { workspace, jobsDir } of sources) {
    let files;
    try {
      files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
      } catch {
        continue;
      }
      if (options.kind && job.kind !== options.kind) continue;
      if (options.status && job.status !== options.status) continue;
      const at = Date.parse(job.finishedAt ?? job.createdAt ?? "");
      if (sinceMs && (!Number.isFinite(at) || at < sinceMs)) continue;
      const consensus = job.deliberation?.merged?.consensus?.length ?? null;
      rows.push({
        workspace,
        id: job.id,
        kind: job.kind,
        status: job.status,
        createdAt: job.createdAt ?? null,
        summary: job.summary ?? "",
        consensusFindings: consensus
      });
    }
  }
  rows.sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0));

  if (options.json) {
    outputResult({ jobs: rows.length, global: Boolean(options.global), rows }, true);
    return;
  }
  if (!rows.length) {
    console.log("No matching council jobs.\n");
    return;
  }
  const lines = [`Council history (${rows.length} jobs${options.global ? ", all workspaces" : ""}, showing ${Math.min(limit, rows.length)}):`];
  for (const r of rows.slice(0, limit)) {
    const ws = options.global ? `${r.workspace.slice(0, 20).padEnd(20)}  ` : "";
    const cons = r.consensusFindings != null ? ` · consensus=${r.consensusFindings}` : "";
    lines.push(`  ${ws}${r.id}  ${String(r.status).padEnd(22)} ${String(r.kind).padEnd(11)} ${(r.createdAt ?? "").slice(0, 16)}${cons}  ${r.summary.slice(0, 50)}`);
  }
  console.log(`${lines.join("\n")}\n`);
}

function handleOverview(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["limit"], booleanOptions: ["json"] });
  const cwd = process.cwd();
  const { text, overview, recurring } = renderOverview(cwd, {
    limit: options.limit != null ? Number(options.limit) : 10
  });
  if (options.json) {
    outputResult({ overview, recurring }, true);
    return;
  }
  console.log(`${text}\n`);
}

function handleLedger(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["resolve", "status"],
    booleanOptions: ["json"]
  });
  const cwd = process.cwd();
  if (options.resolve) {
    const status = positionals[0] ?? "fixed";
    if (!["fixed", "dismissed", "ignored", "open"].includes(status)) {
      throw new Error("resolve status must be fixed | dismissed | ignored | open");
    }
    const ok = resolveLedgerEntry(cwd, options.resolve, status, nowIso());
    outputResult(options.json ? { fingerprint: options.resolve, status, updated: ok } : `${ok ? "Updated" : "Not found"}: ${options.resolve} -> ${status}\n`, options.json);
    return;
  }
  let entries = readLedgerEntries(cwd);
  if (options.status) entries = entries.filter((e) => e.status === options.status);
  entries.sort((a, b) => (b.timesSeen ?? 0) - (a.timesSeen ?? 0));
  if (options.json) {
    outputResult({ entries: entries.length, rows: entries }, true);
    return;
  }
  if (!entries.length) {
    console.log("Findings ledger is empty.\n");
    return;
  }
  const lines = [`Findings ledger (${entries.length} tracked):`];
  for (const e of entries.slice(0, 60)) {
    lines.push(`  [${String(e.status).padEnd(7)}] seen ${String(e.timesSeen ?? 1).padStart(2)}x  ${(e.file ?? "-").slice(0, 40).padEnd(40)}  ${String(e.title ?? "").slice(0, 50)}`);
    lines.push(`            fp=${e.fingerprint}`);
  }
  console.log(`${lines.join("\n")}\n`);
}

function handleWorktree(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base"],
    booleanOptions: ["json", "force"]
  });
  const cwd = process.cwd();
  const action = positionals[0];
  const slug = positionals[1];

  if (action === "add") {
    if (!slug) throw new Error("Usage: worktree add <slug> [--base <ref>]");
    const res = addWorktree(cwd, slug, options.base);
    if (!res.ok) throw new Error(res.error);
    outputResult(
      options.json ? res : `Worktree ready: ${res.dir}\n  branch: ${res.branch}\n  cd there, implement, commit; then: worktree remove ${slug}\n`,
      options.json
    );
    return;
  }
  if (action === "remove") {
    if (!slug) throw new Error("Usage: worktree remove <slug> [--force]");
    const res = removeWorktree(cwd, slug, { force: Boolean(options.force) });
    if (!res.ok) throw new Error(res.error);
    outputResult(options.json ? res : `Removed worktree for ${slug} (branch ${res.branch} kept).\n`, options.json);
    return;
  }
  if (action === "list" || !action) {
    const entries = listWorktrees(cwd);
    if (options.json) {
      outputResult({ worktrees: entries }, true);
      return;
    }
    if (!entries.length) {
      console.log("No council-solve worktrees.\n");
      return;
    }
    console.log("Council-solve worktrees:");
    for (const e of entries) console.log(`  ${e.branch}  ${e.path}`);
    console.log("");
    return;
  }
  throw new Error(`Unknown worktree action: ${action} (use add|remove|list)`);
}

async function handleBenchmark(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "task-file",
      "claude-answer",
      "claude-answer-wait",
      "claude-judgements",
      "wait-timeout",
      "category",
      "codex-model",
      "grok-model",
      "grok-effort",
      "cwd"
    ],
    booleanOptions: ["json", "stats", "skip-codex", "skip-grok", "judge-only"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  if (options.stats) {
    const agg = aggregateBenchmarks(readBenchmarks(cwd));
    if (options.json) {
      outputResult(agg, true);
      return;
    }
    const lines = [`Benchmark stats (${agg.runs} runs):`];
    for (const [agent, v] of Object.entries(agg.agents)) {
      lines.push(`  ${agent.padEnd(10)} runs=${v.runs}  wins=${v.wins}  avg=${v.avgScore == null ? "-" : `${v.avgScore}/10`}`);
    }
    console.log(`${lines.join("\n")}\n`);
    return;
  }

  const backends = probeBackends(cwd, ROOT_DIR);
  const policy = loadPolicy(cwd);
  const mergedOpts = mergeOptionsWithPolicy(
    {
      focusText: positionals.join(" ").trim(),
      codexModel: options["codex-model"],
      grokModel: options["grok-model"],
      grokEffort: options["grok-effort"],
      skipCodex: Boolean(options["skip-codex"]),
      skipGrok: Boolean(options["skip-grok"])
    },
    policy
  );
  const result = await runBenchmark(cwd, backends, {
    ...mergedOpts,
    taskFile: options["task-file"] ? path.resolve(cwd, options["task-file"]) : null,
    claudeAnswer: options["claude-answer"] ? path.resolve(cwd, options["claude-answer"]) : null,
    claudeAnswerWait: options["claude-answer-wait"] ? path.resolve(cwd, options["claude-answer-wait"]) : null,
    claudeJudgements: options["claude-judgements"] ? path.resolve(cwd, options["claude-judgements"]) : null,
    waitTimeoutMs: options["wait-timeout"] ? secondsToMs(options["wait-timeout"], "--wait-timeout") : null,
    judgeOnly: Boolean(options["judge-only"]),
    category: options.category ?? null,
    nowIso: nowIso()
  });
  outputResult(options.json ? { taskHash: result.taskHash, ranking: result.ranking } : result.report, options.json);
}

function handleFixloopStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["writer", "needed"],
    booleanOptions: ["json"]
  });
  const job = resolveJob(process.cwd(), positionals[0]);
  if (!job) throw new Error("No council jobs found.");
  if (job.kind !== "deliberate") throw new Error(`fixloop-status needs a deliberate job (got ${job.kind}).`);
  let needed = options.needed != null ? Math.floor(Number(options.needed)) : 2;
  if (!Number.isFinite(needed) || needed < 1) needed = 1;
  const verdicts = job.deliberation?.verdicts ?? [];
  const approval = evaluateApproval(verdicts, { writer: options.writer ?? null, needed });
  const merged = job.deliberation?.merged ?? { all: [] };
  const actionable = selectActionable(merged, { anyBlocker: approval.blockers.length > 0 });
  // A council with fewer voters than needed, or a non-clean finish, cannot be
  // trusted to approve - fail closed with an incomplete marker.
  // Incomplete means the PEER council can't be trusted: a genuinely failed/
  // unfinished job, or too few non-writer voters (a peer that timed out or
  // parse-failed has no verdict, so it is already missing from voters). A
  // writer-only parse glitch (completed_with_errors) must NOT block a clean
  // peer approval - the writer is excluded from approval anyway.
  const jobFailed = job.status === "failed" || job.status === "running" || job.status === "queued";
  const incomplete = jobFailed || approval.voters.length < needed;
  const approved = approval.approved && !incomplete;
  // Not approved but nothing to fix (all findings are P2/nit, or a partial run
  // yielded none) - the loop must escalate to a human, not spin.
  const stuck = !approved && actionable.length === 0;
  // An incomplete council (an agent timed out / parse-failed, or too few voters)
  // must never drive another fix round - its verdict cannot be trusted even if it
  // surfaced findings. Escalate regardless of actionable count.
  const recommendation = approved
    ? "stop-approved"
    : incomplete || stuck
      ? "stop-escalate-to-human"
      : "fix-and-rereview";
  const payload = {
    jobId: job.id,
    status: job.status,
    verdicts,
    ...approval,
    approved,
    incomplete,
    stuck,
    recommendation,
    actionableCount: actionable.length,
    actionable
  };
  if (options.json) {
    outputResult(payload, true);
    return;
  }
  const decision =
    payload.recommendation === "stop-approved"
      ? "APPROVED - stop the loop"
      : payload.recommendation === "stop-escalate-to-human"
        ? incomplete
          ? "INCOMPLETE council (untrusted verdict) - escalate to a human"
          : "STUCK (not approved, nothing actionable) - escalate to a human"
        : "NOT approved - fix actionable findings and re-review";
  const lines = [
    `Fixloop status for ${job.id}${incomplete ? " (INCOMPLETE council)" : ""}:`,
    `  verdicts: ${verdicts.map((v) => `${v.agent}=${v.verdict}`).join(", ") || "(none)"}`,
    `  approvals: ${approval.approvals.join("+") || "none"} of ${needed} needed${approval.excludedWriter ? ` (writer ${approval.excludedWriter} excluded)` : ""}`,
    `  decision: ${decision}`,
    `  actionable findings: ${actionable.length}`
  ];
  for (const f of actionable.slice(0, 20)) {
    lines.push(`    - ${f.severity} [${f.agents.join("+")}] ${f.title}${f.file ? ` (${f.file}${f.line != null ? `:${f.line}` : ""})` : ""}`);
  }
  console.log(`${lines.join("\n")}\n`);
}

function handleMetrics(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["days"], booleanOptions: ["json"] });
  const cwd = process.cwd();
  const days = options.days != null ? Number(options.days) : 30;
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  const entries = readMetrics(cwd, Date.now() - days * 86_400_000);
  const agg = aggregateMetrics(entries);
  if (options.json) {
    outputResult({ days, ...agg }, true);
    return;
  }
  console.log(`${renderMetrics(agg, days)}\n`);
}

async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout", "interval"],
    booleanOptions: ["json", "follow"]
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  const jobId = positionals[0] ?? listJobs(root)[0]?.id;
  if (!jobId) throw new Error("No council jobs found.");
  const timeoutMs = secondsToMs(options.timeout, "--timeout") ?? 3_600_000;
  const intervalMs = secondsToMs(options.interval, "--interval") ?? 5000;
  const deadline = Date.now() + timeoutMs;

  let job = readJobFile(root, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  let lastPhase = null;
  while ((job.status === "running" || job.status === "queued") && Date.now() < deadline) {
    if (options.follow && !options.json && job.phase && job.phase !== lastPhase) {
      console.error(`[${job.id}] ${job.phase}`);
      lastPhase = job.phase;
    }
    await delay(intervalMs);
    job = readJobFile(root, jobId) ?? job;
  }
  const finished = job.status !== "running" && job.status !== "queued";
  outputResult(
    options.json
      ? { jobId: job.id, status: job.status, exitCode: job.exitCode ?? null, finished }
      : `Job ${job.id}: ${job.status}${finished ? "" : " (wait timed out)"}\n`,
    options.json
  );
  if (!finished) process.exitCode = 1;
}

// Median wall-clock for this kind, bucketed by participant count so a codex-only
// run and a 3-agent run don't share one ETA. Falls back to all runs of the kind
// when the same-size bucket is too small to be meaningful.
function medianWallClockForKind(cwd, kind, participantCount) {
  const entries = readMetrics(cwd).filter((e) => e.kind === kind && Number.isFinite(Number(e.wallClockMs)));
  const dur = (list) => list.map((e) => Number(e.wallClockMs)).sort((a, b) => a - b);
  if (participantCount != null) {
    const sameSize = entries.filter((e) => Array.isArray(e.agents) && e.agents.length === participantCount);
    if (sameSize.length >= 2) return median(dur(sameSize));
  }
  return median(dur(entries));
}

// Static context that does NOT change across redraws (derived from the job's own
// request + history), so the live loop only re-reads the log each frame.
function watchContext(cwd, job) {
  const hasRequest = job.request && Object.keys(job.request).length > 0;
  let skipped = [];
  let claudeBackend = "session";
  if (hasRequest) {
    const merged = mergeOptionsWithPolicy(job.request, loadPolicy(cwd));
    skipped = skippedAgents(merged, { includeClaude: true });
    claudeBackend = merged.claudeBackend;
  }
  const participantCount = 3 - skipped.length;
  return { skipped, claudeBackend, etaMs: medianWallClockForKind(cwd, job.kind, participantCount) };
}

function renderWatch(job, ctx) {
  let logText = "";
  try {
    if (job.logFile) logText = fs.readFileSync(job.logFile, "utf8");
  } catch {
    /* log may not exist yet */
  }
  return formatDashboard(job, summarizeProgress(logText), {
    nowMs: Date.now(),
    etaMs: ctx.etaMs,
    skipped: ctx.skipped,
    claudeBackend: ctx.claudeBackend,
    jobPhase: job.phase,
    // Findings only exist once the merge phase ran (terminal jobs); null otherwise.
    findings: summarizeFindings(job.deliberation?.merged)
  });
}

// Markdown snapshot for the chat, with a delta vs the previous --md call for this
// job (persisted in the state dir; a corrupt/absent prior just omits the delta).
function renderWatchMarkdown(cwd, job, ctx) {
  let logText = "";
  try {
    if (job.logFile) logText = fs.readFileSync(job.logFile, "utf8");
  } catch {
    /* log may not exist yet */
  }
  const snapFile = path.join(resolveStateDir(cwd), `watch-md-${job.id}.json`);
  let prior = null;
  try {
    prior = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  } catch {
    /* no prior snapshot */
  }
  const out = formatDashboardMarkdown(job, summarizeProgress(logText), {
    nowMs: Date.now(),
    etaMs: ctx.etaMs,
    skipped: ctx.skipped,
    claudeBackend: ctx.claudeBackend,
    jobPhase: job.phase,
    findings: summarizeFindings(job.deliberation?.merged),
    extras: summarizeCouncilExtras(job.deliberation),
    prior
  });
  try {
    writeFileAtomic(snapFile, `${JSON.stringify(out.snapshot)}\n`);
  } catch {
    /* delta persistence is best-effort */
  }
  return out;
}

/**
 * Live dashboard for a running job. Redraws every interval until the job
 * finishes (a real terminal shows it as an updating dashboard). --once/--json
 * print a single snapshot (useful inside captured/non-TTY output).
 */
async function handleWatch(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["interval", "timeout"],
    booleanOptions: ["json", "once", "md"]
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  const jobId = positionals[0] ?? listJobs(root)[0]?.id;
  if (!jobId) throw new Error("No council jobs found.");
  let job = readJobFile(root, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  const ctx = watchContext(cwd, job); // computed once - stable across redraws

  if (options.json) {
    const snap = renderWatch(job, ctx);
    outputResult({ jobId: job.id, status: job.status, dashboard: snap.text, terminal: snap.terminal }, true);
    return;
  }

  // --md: a rich Markdown snapshot for the chat (where the terminal box renders as
  // grey text). Always a single snapshot; a delta vs the last --md call is shown.
  if (options.md) {
    console.log(renderWatchMarkdown(cwd, job, ctx).markdown);
    return;
  }

  const intervalMs = secondsToMs(options.interval, "--interval") ?? 2000;
  const timeoutMs = secondsToMs(options.timeout, "--timeout") ?? 3_600_000;
  const deadline = Date.now() + timeoutMs;
  // Color only for an interactive terminal; piped/redirected output stays plain
  // (so --once in the chat and --json are never polluted with escape codes).
  const paint = (s) => (process.stdout.isTTY ? colorize(s) : s);

  // Single snapshot (no live redraw) for --once or non-TTY stdout.
  if (options.once || !process.stdout.isTTY) {
    const snap = renderWatch(job, ctx);
    console.log(paint(snap.text));
    if (!snap.terminal) console.log("\n(snapshot; re-run or use a TTY for a live view)");
    return;
  }

  // Live redraw loop for an interactive terminal.
  for (;;) {
    job = readJobFile(root, jobId) ?? job;
    const snap = renderWatch(job, ctx);
    process.stdout.write(`\x1b[2J\x1b[H${paint(snap.text)}\n`);
    if (snap.terminal) return;
    if (Date.now() >= deadline) {
      // Mirror `wait`: a watch that hits its deadline is not a clean finish.
      console.log(`\nwatch timed out after ${Math.round(timeoutMs / 1000)}s (job still ${job.status}).`);
      process.exitCode = 1;
      return;
    }
    await delay(intervalMs);
  }
}

// Whole-project audit. `audit` (default) is static: it builds the codebase model
// and emits CANDIDATE findings + hotspots + coverage, reading source only. Writes
// are opt-in: --write-map writes docs/codebase-map.json and --doc writes the
// proposal doc (both under the project root). `audit review` additionally runs
// Codex/Grok over the hotspots — those reviewers are prompted read-only, but they
// are external CLIs whose sandboxing this command cannot itself enforce. Reviewed
// code is never auto-edited here. See docs/audit-design.md. NOTE: `audit fix` /
// `audit fix --loop` (below, M3+) DO write gated fixes on an isolated integration
// branch; only `audit` (static) and `audit review` are read-only.
// Conservative CLI cell cap for `audit review --groups` (the library backstop is 4000). A default
// fine run is ~1080 cells; this caps an accidental fan-out while still covering a normal run — raise
// it explicitly with --max-cells (a capped run reports PARTIAL coverage, never silently truncates).
const GROUPED_CLI_DEFAULT_MAX_CELLS = 1500;

// Attach the OpenRouter backend to a probed `backends`. The API key is NEVER taken from the repo policy
// file: openRouterBackend is called with a null user-key arg, so the key can come ONLY from the user's
// ENV var (council OpenRouter Claude/Grok P1). A repo-supplied openrouter_api_key is ignored + warned.
// Any resolution warnings (a base_url refused by the exfil guard, a dropped/duplicate/over-cap model)
// are surfaced so the operator isn't silently missing a seat.
function attachOpenRouterSeats(backends, merged, policy, json) {
  // --skip-openrouter is a TRUE opt-out (council Codex/Claude P1): zero out the backend so the OR seats
  // participate NOWHERE — not as finders, not as §6 reviewers, not as refuters. Merely reducing the §6
  // required-vote SUBSET would still POST the patch + reviewed source to every configured OR seat during
  // patch review (the reviewer is a superset), so a security opt-out MUST remove the seats at the source.
  if (merged.skipOpenRouter) {
    backends.openrouter = { available: false, seats: [], baseURL: null, apiKeyEnv: null, apiKeyPresent: false, keySource: null, warnings: [] };
    return;
  }
  // SECURITY (council OpenRouter Claude P1): the policy comes from the AUDITED repo, so a repo-supplied
  // API key must NEVER activate/redirect egress. Pass NO config key — the key comes only from the user's
  // ENV var (or a future user-typed CLI flag). Warn loudly if a repo file tried to set one.
  const repoKey = policy?.openrouter_api_key ?? policy?.openrouter?.apiKey ?? null;
  if (repoKey && !json) console.error("⚠ openrouter: an API key in the repo policy file is IGNORED for security — set it via the OPENROUTER_API_KEY environment variable instead (a repo-supplied key would ship your source to that key's account).");
  const backend = openRouterBackend(merged, process.env, null);
  // A per-seat skip list (--skip-seats or policy skip_seats) also removes those seats from the backend so
  // they egress nowhere, matching --skip-openrouter's guarantee at seat granularity.
  const skip = new Set(merged.skipSeats ?? []);
  if (skip.size) backend.seats = backend.seats.filter((s) => !skip.has(s.id));
  backends.openrouter = backend;
  if (!json) for (const w of backend.warnings ?? []) console.error(`⚠ openrouter: ${w}`);
}

// Build the §5 char-test gate for a fix run, or null when --chartest is off. Fail-LOUD when the flag IS
// set but no generator seat can write tests (council Grok P1): otherwise makeCharTestGate returns null,
// runAuditFix silently skips the gate, and behaviour-preserving refactors auto-apply UNGATED while the
// operator believes --chartest is protecting them. Erroring up front (before any spend) is the honest fix.
function resolveCharTestGate(cwd, backends, merged, options) {
  if (!options.chartest) return null;
  const gate = makeCharTestGate(cwd, backends, merged);
  if (!gate) throw new Error("--chartest requires a reachable generator seat (Claude/Codex/Grok/OpenRouter) to write characterization tests — none is available; fix a backend or drop --chartest");
  return gate;
}

// A12: per-seat TOKEN telemetry. collectAllTokenUsage parses the CLIs' on-disk session logs, so a run's
// own consumption is the DELTA of a snapshot taken before and after it (fix-metrics.tokenDelta). Two
// invariants:
//  - BOTH snapshots must use the SAME `sinceMs` bound. A Date.now()-relative window recomputed for the
//    second call would shift, drop older sessions from one side only, and corrupt the delta — so the
//    bound is computed ONCE per run and threaded through.
//  - FAIL-SOFT + FAIL-CLOSED: an unreadable session log yields null, and a null snapshot makes the report
//    say "not measured" (cost.tokensMeasured=false) instead of claiming the run cost $0.
// The window bounds the scan (session logs accumulate forever); anything a fix run touches was written by
// this run or by a recent session, so 30 days is generously wide.
const TOKEN_SNAPSHOT_WINDOW_MS = 30 * 86_400_000;

function tokenSnapshot(sinceMs) {
  try {
    return collectAllTokenUsage({ homeDir: os.homedir(), sinceMs });
  } catch {
    return null; // → tokensMeasured:false, never a false $0
  }
}

// Assemble the fix-report telemetry meta (metrics + before→after codebase shape). FAIL-SOFT: any git
// error just omits the shape — a telemetry report must never break a completed fix run. Only called on
// --html. The before/after shape is bounded to the CHANGED files (a fix touches a small set).
async function computeFixReportMeta(cwd, out, ctx = {}) {
  let shapeBefore;
  let shapeAfter;
  let numstat;
  try {
    const changed = Array.isArray(out?.changedFiles) ? out.changedFiles : [];
    const base = out?.baseBranch;
    const head = out?.branch;
    if (changed.length && base && head) {
      const cache = new Map();
      for (const ref of [base, head]) {
        for (const f of changed) {
          const r = await runCommandAsync("git", ["show", `${ref}:${f}`], { cwd, timeoutMs: 15_000 });
          cache.set(`${ref}:${f}`, r.status === 0 ? r.stdout : "");
        }
      }
      const shapes = changedFilesShape(changed, base, head, (ref, p) => cache.get(`${ref}:${p}`));
      shapeBefore = shapes.before;
      shapeAfter = shapes.after;
      const ns = await runCommandAsync("git", ["diff", "--numstat", `${base}..${head}`], { cwd, timeoutMs: 15_000 });
      numstat = ns.status === 0 ? ns.stdout : undefined;
    }
  } catch {
    /* fail-soft — omit the shape section */
  }
  return assembleFixMeta(out, { ...ctx, shapeBefore, shapeAfter, numstat });
}

async function handleAudit(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["areas", "churn-days", "budget", "max-units", "doc-path", "from", "min-severity", "max-fixes", "max-passes", "dry-streak", "sarif-path", "autonomy", "base", "retry-limit", "groups", "max-cells", "skip-seats"],
    booleanOptions: ["json", "write-map", "doc", "dry-run", "allow-untested", "resume", "sarif", "loop", "per-tier", "flat", "html", "retry-on-limit", "sensitive-auto-apply", "supervise", "completeness-critic", "skip-openrouter", "chartest"]
  });
  const cwd = process.cwd();
  // Validate the grouped-review preset + cap ONCE, up front — before any preflight/coverage/spend, for
  // EVERY audit subcommand (council R9 Codex P2 fail-fast + one-shot consistency). resolveLensGroups
  // also throws downstream, but a typo shouldn't first run a long coverage job or a review.
  if (options.groups != null && !["fine", "tier", "lens"].includes(String(options.groups))) throw new Error(`--groups must be one of fine|tier|lens (got: ${options.groups})`);
  if (options["max-cells"] != null) {
    const nmc = Number(options["max-cells"]);
    if (!Number.isFinite(nmc) || nmc < 1) throw new Error("--max-cells must be a positive number");
  }
  // M8 completeness critic (opt-in): only the GROUPED path (--groups) runs a cell matrix the critic can
  // judge, so the flag is inert without it — warn rather than silently ignore (council fail-loud habit).
  const completenessCritic = Boolean(options["completeness-critic"]);
  if (completenessCritic && !options.groups && !options.json) {
    console.error("note: --completeness-critic has no effect without --groups (it augments the grouped six-eyes matrix); ignoring for this run");
  }
  const areas = options.areas ? String(options.areas).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  let churnDays = 90;
  if (options["churn-days"] != null) {
    churnDays = Number(options["churn-days"]);
    if (!Number.isFinite(churnDays) || churnDays < 1) throw new Error("--churn-days must be a positive number");
  }
  const model = buildCodebaseModel(cwd, { areas, churnDays });

  if (options["write-map"]) {
    const dir = path.join(workspaceRoot(cwd), "docs");
    fs.mkdirSync(dir, { recursive: true });
    const mapPath = path.join(dir, "codebase-map.json");
    fs.writeFileSync(mapPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    if (!options.json) console.log(`Wrote ${mapPath}`);
  }

  // `audit review` (v2): deep agent review of the top hotspots + global reduce.
  // `audit run` (v5): the self-driving enterprise audit — inventory -> mandatory set
  // -> reused review engine -> canonical findings -> ranked risk register -> gate,
  // as one schema-valid report. `--sarif` also writes a SARIF 2.1.0 log (confined to
  // the project root). Reuses the review engine; does not touch the other subcommands.
  if (positionals[0] === "run") {
    const backends = probeBackends(cwd, ROOT_DIR);
    const _orPolicy = loadPolicy(cwd);
    const merged = mergeOptionsWithPolicy(options, _orPolicy);
    attachOpenRouterSeats(backends, merged, _orPolicy, options.json); // OpenRouter seats (if configured) join the six-eyes
    const { budget, maxUnits } = parseAuditBudgetOptions(options);
    const tRun = Date.now();
    const report = await runAudit(cwd, model, backends, {
      ...merged,
      budget,
      maxUnits,
      areas,
      base: options.base,
      skipCodex: merged.skipCodex,
      skipGrok: merged.skipGrok
    });
    recordAuditMetrics(cwd, "run", { wallClockMs: Date.now() - tRun, findings: report.register.length, gate: report.gate.status, mandatory: report.mandatorySurface?.count ?? 0 }, nowIso());
    if (options.sarif) {
      const base = workspaceRoot(cwd);
      const rel = String(options["sarif-path"] ?? "docs/audit.sarif.json");
      const target = path.resolve(base, rel);
      const relCheck = path.relative(base, target);
      if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error(`--sarif-path must stay within the project root (got: ${rel})`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(toSarif(report.register, { toolVersion: "2.1.0" }), null, 2)}\n`, "utf8");
      if (!options.json) console.log(`Wrote SARIF to ${target}`);
    }
    if (options.doc) {
      const docFindings = report.register.map((p) => ({ severity: p.severity, category: p.lens, title: p.title, scope: p.scope, file: p.location?.path, line: p.location?.startLine, detail: p.failureScenario, confidence: p.confidence }));
      const docPath = writeAuditDoc(workspaceRoot(cwd), docFindings, { source: "audit run" }, { docPath: options["doc-path"] });
      if (!options.json) console.log(`Wrote proposals to ${docPath}`);
    }
    if (options.json) {
      outputResult(report, true);
      return;
    }
    console.log(renderAuditRunReport(report));
    return;
  }

  if (positionals[0] === "review") {
    const backends = probeBackends(cwd, ROOT_DIR);
    const _orPolicy = loadPolicy(cwd);
    const merged = mergeOptionsWithPolicy(options, _orPolicy);
    attachOpenRouterSeats(backends, merged, _orPolicy, options.json); // OpenRouter seats (if configured) join the six-eyes
    const { budget, maxUnits } = parseAuditBudgetOptions(options);
    const t0 = Date.now();
    // --groups <preset> (M7): opt into the six-eyes GROUPED path — every (module × lens-group ×
    // chunk) CELL is reviewed by all reachable seats, coverage measured cell-granularly. The default
    // per-file path is unchanged. --max-cells bounds the matrix (overflow is reported, never silent).
    let out;
    if (options.groups) {
      // Grouped cost is bounded by CELLS, not the agent-call --budget. A default fine run is already
      // ~1080 cells (12 files × 30 groups × 3 seats); the library backstop is 4000. Use a lower CLI
      // default so an accidental run can't fan out thousands of paid spawns, and warn that --budget
      // has no effect here (council 3/3: Grok/Codex P1, Claude nit).
      let maxCells = GROUPED_CLI_DEFAULT_MAX_CELLS;
      if (options["max-cells"] != null) {
        const n = Number(options["max-cells"]);
        if (!Number.isFinite(n) || n < 1) throw new Error("--max-cells must be a positive number");
        maxCells = Math.floor(n);
      }
      if (options.budget != null && !options.json) {
        console.error("note: --budget does not bound --groups (grouped cost is bounded by --max-cells); ignoring --budget for this run");
      }
      out = await runGroupedReview(cwd, model, backends, {
        ...merged,
        maxUnits,
        lensGroups: String(options.groups),
        maxCells,
        completenessCritic, // M8: opt-in thoroughness critic (adds 1 call; surfaces coverage gaps)
        skipCodex: merged.skipCodex,
        skipGrok: merged.skipGrok,
        onProgress: options.json ? undefined : (m) => console.error(m)
      });
    } else {
      out = await runAuditReview(cwd, model, backends, {
        ...merged,
        budget,
        maxUnits,
        skipCodex: merged.skipCodex,
        skipGrok: merged.skipGrok
      });
    }
    recordAuditMetrics(cwd, "review", { wallClockMs: Date.now() - t0, findings: out.findings.length, coverage: out.coverage }, nowIso());
    if (options.doc) {
      const docPath = writeAuditDoc(workspaceRoot(cwd), out.findings, { source: "deep review" }, { docPath: options["doc-path"] });
      if (!options.json) console.log(`Wrote proposals to ${docPath}`);
    }
    if (options.json) {
      outputResult(out, true);
      return;
    }
    console.log(renderAuditReviewReport(out));
    return;
  }

  // `audit fix` (v3): SAFE auto-fix of verified LOCALIZED findings on an isolated
  // integration branch, each gated by the project's tests, reverted on failure.
  // Findings come from --from <json> (a prior review) or a fresh review run.
  if (positionals[0] === "fix") {
    const backends = probeBackends(cwd, ROOT_DIR);
    const _orPolicy = loadPolicy(cwd);
    const merged = mergeOptionsWithPolicy(options, _orPolicy);
    attachOpenRouterSeats(backends, merged, _orPolicy, options.json); // OpenRouter seats (if configured) join the six-eyes
    const { budget, maxUnits } = parseAuditBudgetOptions(options);

    // Autonomy dial (M4): resolve the level -> commit/propose gate, shared by the loop
    // AND single-shot paths. --min-severity may only TIGHTEN, never loosen, the dial.
    const auto = resolveAutonomy(options.autonomy ?? "aggressive");
    const SEVRANK = { P0: 0, P1: 1, P2: 2, nit: 3 };
    let fixMinSeverity = auto.minSeverity;
    if (options["min-severity"]) {
      fixMinSeverity = (SEVRANK[options["min-severity"]] ?? 2) <= (SEVRANK[auto.minSeverity] ?? 2) ? options["min-severity"] : auto.minSeverity;
    }
    if (!auto.apply && !options["dry-run"]) throw new Error("--autonomy propose-only: use `audit run` for a review-only pass (audit fix applies fixes)");

    // `audit fix --loop` (M3): the autonomous fix-until-dry loop. Reviews -> Tier-0
    // gates -> fixes the localized set on ONE isolated branch -> re-scopes to the blast
    // radius -> repeats until dry/budget/max-passes. Nothing auto-merged.
    if (options.loop) {
      if (options["dry-run"]) throw new Error("--dry-run is not supported with --loop (the loop commits on an isolated branch). Preview a single pass with `audit fix --dry-run`, then run `audit fix --loop`.");
      if (activeReviewerCount(backends, merged) === 0) throw new Error("no callable reviewers (Codex/Grok unavailable or skipped) — audit fix --loop needs at least one");

      // Preflight BEFORE paying for a review (the loop must never review-then-hard-stop):
      // require a branch (not detached HEAD), a clean tree, and a test gate.
      const bb = await runCommandAsync("git", ["branch", "--show-current"], { cwd, timeoutMs: 10_000 });
      const baseBranch = bb.status === 0 ? bb.stdout.trim() : "";
      if (!baseBranch) throw new Error("audit fix --loop requires being on a branch (detached HEAD detected) — check out a branch first");
      if (/^council\/audit-fix-/.test(baseBranch) && !options.resume) throw new Error(`you are on an integration branch (${baseBranch}) — check out your base branch first, or pass --resume to continue it`);
      const st = await runCommandAsync("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
      if (st.status === 0 && st.stdout.trim() !== "") throw new Error("working tree not clean — commit or stash first (the loop's rollback would destroy uncommitted work)");
      if (!detectTestCmd(workspaceRoot(cwd)) && !options["allow-untested"]) throw new Error("no test command detected — audit fix --loop needs a test gate; pass --allow-untested to run without verification (not recommended)");

      // Reconcile prior provisional fixes -> durable 'fixed' when their commit landed on
      // the fix's own base branch. Skip when checked out ON an integration branch
      // (--resume): reconcile keys on each entry's stored baseBranch, but skipping is a
      // clear belt-and-suspenders against a mis-stored base.
      if (!/^council\/audit-fix-/.test(baseBranch)) {
        try {
          const patchIdOf = (rev) => {
            const show = runCommand("git", ["show", "--no-color", String(rev)], { cwd, timeoutMs: 10_000 });
            if (show.status !== 0 || !show.stdout) return null;
            const pid = runCommand("git", ["patch-id", "--stable"], { cwd, input: show.stdout, timeoutMs: 10_000 });
            return pid.status === 0 ? pid.stdout.trim().split(/\s+/)[0] || null : null;
          };
          reconcilePendingFixes(cwd, {
            isAncestor: (sha, ref) => runCommand("git", ["merge-base", "--is-ancestor", String(sha), String(ref || "HEAD")], { cwd, timeoutMs: 10_000 }).status === 0,
            // Squash/rebase/cherry-pick: the original sha isn't an ancestor, but the same
            // change (patch-id) is reachable from the base — promote it too.
            patchIdMerged: (sha, ref) => {
              const target = patchIdOf(sha);
              if (!target) return false;
              const log = runCommand("git", ["log", "--format=%H", "-n", "300", String(ref || "HEAD")], { cwd, timeoutMs: 15_000 });
              if (log.status !== 0) return false;
              return log.stdout.split(/\r?\n/).filter(Boolean).some((h) => patchIdOf(h) === target);
            }
          });
        } catch {
          /* reconcile is best-effort */
        }
      }

      let maxPasses = 8;
      if (options["max-passes"] != null) {
        const n = Number(options["max-passes"]);
        if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("--max-passes must be between 1 and 100");
        maxPasses = Math.floor(n);
      }
      let dryStreak = 2;
      if (options["dry-streak"] != null) {
        const n = Number(options["dry-streak"]);
        if (!Number.isFinite(n) || n < 1) throw new Error("--dry-streak must be a positive number");
        dryStreak = Math.floor(n);
      }
      // R9: --groups drives the loop off the GROUPED six-eyes review (cell-granular coverage feeds the
      // convergence guard). Validate the preset + cap up front so a bad value fails before any spend.
      let loopLensGroups;
      let loopMaxCells;
      if (options.groups) {
        if (!["fine", "tier", "lens"].includes(String(options.groups))) throw new Error(`--groups must be one of fine|tier|lens (got: ${options.groups})`);
        loopLensGroups = String(options.groups);
        loopMaxCells = GROUPED_CLI_DEFAULT_MAX_CELLS;
        if (options["max-cells"] != null) {
          const nc = Number(options["max-cells"]);
          if (!Number.isFinite(nc) || nc < 1) throw new Error("--max-cells must be a positive number");
          loopMaxCells = Math.floor(nc);
        }
      }
      // The loop budget is in AGENT CALLS. A per-file pass is a handful; a GROUPED pass is up to
      // maxCells calls, so a grouped loop's budget must be CELL-SCALE — else one pass blows the 60
      // default and the loop stops after a single pass (council Grok R9). Default a grouped run to ~4
      // passes' worth of cells, and raise the ceiling accordingly. The per-pass cell dispatch is capped
      // to the remaining budget (makeFixLoopDeps), so this bounds total spend honestly.
      const budgetMax = loopLensGroups ? Math.max(2000, loopMaxCells * 20) : 2000;
      let loopBudget = loopLensGroups ? loopMaxCells * 4 : 60;
      if (options.budget != null) {
        const n = Number(options.budget);
        if (!Number.isFinite(n) || n < 2 || n > budgetMax) throw new Error(`--budget must be between 2 and ${budgetMax}`);
        loopBudget = Math.floor(n);
      }
      if (loopLensGroups && !options.json) {
        console.error(`note: --groups prices each review cell as one agent call; the loop budget is ${loopBudget} cells total (each pass reviews up to min(--max-cells ${loopMaxCells}, its per-pass budget)). Raise --budget for deeper coverage / more passes.`);
      }

      // Coverage gate (§5): produce coverage ONCE via a project script and ingest it, so
      // a fix on an unexecuted line downgrades to propose-only. Off (tests still gate)
      // when no coverage script exists — reported, not silently skipped.
      let coverage = null;
      const covCmd = detectCoverageCmd(workspaceRoot(cwd));
      if (covCmd) {
        if (!options.json) console.error("Running coverage once for the coverage gate…");
        await runCommandAsync(covCmd.cmd, covCmd.args, { cwd, timeoutMs: 300_000 });
        coverage = loadCoverage(workspaceRoot(cwd));
        if (!coverage && !options.json) console.error("  (no coverage artifact found — coverage gate off; tests still gate)");
      }
      // Tier-0 detector: run once over the exposed graph -> logical_sense proposals (dead
      // modules, over-layered indirection) + a verdict map (gates only above the confidence
      // floor; today they surface as proposals, they don't autonomously prune).
      let logical = { findings: [], verdictMap: {} };
      try {
        logical = await detectLogical({ nodes: nodesFromGraph(model.graph), entrypoints: new Set(model.graph?.entrypoints ?? []) }, {});
      } catch {
        /* Tier-0 detection is best-effort */
      }
      // §6 council-gated auto-apply (consented via --sensitive-auto-apply). Needs all
      // three seats reachable so the gate can reach unanimity; otherwise warn + keep
      // sensitive findings propose-only (fail-safe, never a silent never-approve).
      let sensitiveAutoApply = false;
      let reviewPatch;
      if (options["sensitive-auto-apply"]) {
        const ready = patchReviewerReady(backends, merged);
        if (ready.ready) {
          sensitiveAutoApply = true;
          reviewPatch = makePatchReviewer(cwd, backends, {
            // CLI flag wins, else the policy-configured model (exposed camelCase by
            // mergeOptionsWithPolicy) — don't silently drop policy model pins.
            claudeModel: merged["claude-model"] ?? merged.claudeModel,
            codexModel: merged["codex-model"] ?? merged.codexModel,
            grokModel: merged["grok-model"] ?? merged.grokModel,
            agentTimeoutMs: merged.agentTimeoutMs
            // NOTE (council OpenRouter Grok P2): deliberately no skip flags here → the reviewer runs the
            // SUPERSET of configured seats. runAuditFix's gate computes requiredPatchSeats(backends,
            // options) as a SUBSET (honoring --skip-openrouter). Superset-reviewer ⊇ subset-required
            // means every required seat is always present in the votes → no false veto, and
            // evaluatePatchVerdicts ignores votes from non-required seats → no false approve.
          });
          console.error("§6 council-gated auto-apply ENABLED — sensitive fixes require UNANIMOUS Claude+Codex+Grok confirmation of the patch.");
          console.error("⚠ SECURITY: the §6 reviewers run LLM CLIs inside this repository. Project hooks/settings still fire. Enable --sensitive-auto-apply ONLY on repositories you trust.");
        } else {
          // Name the ACTUAL unreachable seats, derived from every per-seat flag ready reports (built-ins
          // AND any configured or-* seat) — not a hardcoded three (council Codex P2). Otherwise an
          // OpenRouter seat being down prints "seats unreachable ()" and misdiagnoses the veto.
          const missing = Object.keys(ready).filter((s) => s !== "ready" && !ready[s]);
          console.error(`⚠ --sensitive-auto-apply requested but seats unreachable (${missing.join(", ")}) — §6 stays propose-only.`);
        }
      }
      const deps = makeFixLoopDeps(cwd, model, backends, {
        maxUnits,
        minSeverity: fixMinSeverity,
        allowUntested: options["allow-untested"],
        coverage,
        verdictMap: logical.verdictMap,
        lensGroups: loopLensGroups,
        maxCells: loopMaxCells,
        completenessCritic: completenessCritic && Boolean(loopLensGroups), // M8: only on the grouped loop
        skipCodex: merged.skipCodex,
        skipGrok: merged.skipGrok,
        skipClaude: merged.skipClaude, // B2 (grok-1): honor the Claude opt-out in the fix loop too
        // Thread the OpenRouter opt-outs so the §6 gate's requiredPatchSeats HONORS --skip-openrouter /
        // per-seat skips in the LOOP path too (council OpenRouter Claude P2) — else a skipped OR seat
        // would still be REQUIRED and veto every patch. The reviewer stays a superset; only the required
        // SET shrinks, and evaluatePatchVerdicts ignores the non-required OR votes.
        skipOpenRouter: merged.skipOpenRouter,
        skipSeats: merged.skipSeats ?? options.skipSeats,
        // §5 char-test gate (opt-in --chartest): behaviour-preserving refactors must keep a generated
        // characterization test green across the change, else revert to propose-only. null when off;
        // fail-loud when requested but no generator seat is reachable (never silently ungated).
        charTestGate: resolveCharTestGate(cwd, backends, merged, options),
        claudeModel: merged["claude-model"] ?? merged.claudeModel,
        sensitiveAutoApply,
        reviewPatch,
        retryOnLimit: options["retry-on-limit"],
        // The TRUE base branch, captured before the loop. On pass 2+ the process is ON the
        // integration branch, so runAuditFix's git.currentBranch() would ledger the fix's baseBranch
        // as the integration branch — reconcilePendingFixes then trivially finds the commit an
        // ancestor and falsely promotes it to durable 'fixed' though it was never merged to base
        // (council Opus O7). Pin the real base for the ledger.
        ledgerBaseBranch: baseBranch
      });
      const tLoop = Date.now();
      // A12: bracket the loop with a token snapshot so the --html report can diff it into per-seat tokens
      // + an ≈cost. Only taken when a report will consume it (the scan reads session logs); the same
      // `sinceMs` bound is reused for the AFTER snapshot below.
      const loopTokenSince = Date.now() - TOKEN_SNAPSHOT_WINDOW_MS;
      const loopTokensBefore = options.html ? tokenSnapshot(loopTokenSince) : null;
      // B5: per-tier convergence (structure → correctness → quality) is ON by default so a
      // Structure/SSOT consolidation lands before Correctness runs on the consolidated code; --flat
      // opts out (single flat convergence). --per-tier explicitly affirms the default; passing BOTH is
      // a contradiction, so reject it loudly instead of silently letting one win (council F2).
      if (options["per-tier"] && options.flat) throw new Error("--per-tier and --flat are contradictory (per-tier staging vs one flat convergence) — pass at most one");
      const loopOpts = { budget: loopBudget, maxPasses, dryStreak, maxUnits, perTierConvergence: !options.flat, retryOnLimit: options["retry-on-limit"], retryLimit: options["retry-limit"] != null ? Number(options["retry-limit"]) : undefined, logicalProposals: logical.findings, onProgress: options.json ? undefined : (m) => console.error(m) };
      // C3/M10: --supervise wraps the loop in the endless supervisor so a multi-hour autonomous run
      // survives rate-limit resets — a resumable stop (throttled/backends-down/did-not-run) waits
      // reset-aware then --resumes from the checkpoint; a terminal convergence returns as normal.
      const out = options.supervise
        ? await runSupervised(
            ({ resume }) => runFixLoop(cwd, { ...loopOpts, resume: resume || options.resume }, deps),
            { onWait: ({ attempt, waitMs, stopReason }) => options.json || console.error(`⏸ supervisor: rate-limited — reset-aware wait ${Math.round(waitMs / 1000)}s (attempt ${attempt}) [${stopReason}]…`) }
          )
        : await runFixLoop(cwd, { ...loopOpts, resume: options.resume }, deps);
      // Return to the base branch after the final pass (fix stayed on the integration
      // branch); report if the checkout couldn't complete so the user isn't stranded silently.
      out.baseBranch = baseBranch;
      out.stranded = false;
      if (out.branch) {
        const co = await runCommandAsync("git", ["checkout", baseBranch], { cwd, timeoutMs: 30_000 });
        out.stranded = co.status !== 0;
      }
      recordAuditMetrics(cwd, "fixloop", { wallClockMs: Date.now() - tLoop, fixed: out.fixed?.length ?? 0, failed: out.failed?.length ?? 0, proposed: out.proposed?.length ?? 0, passes: out.passesRun ?? 0, spent: out.spent ?? 0 }, nowIso());
      if (options.json) {
        outputResult(out, true);
        return;
      }
      if (options.html) {
        // Use the RESOLVED consent flag (in scope), not out.sensitiveAutoApply which the loop never
        // returns — else the §6-council-gated report label always fell back to safe-auto (council F3).
        const meta = await computeFixReportMeta(cwd, out, {
          startedAt: new Date(tLoop).toISOString(),
          wallClockMs: Date.now() - tLoop,
          finishedAt: nowIso(),
          autonomy: options.autonomy ?? "aggressive",
          sensitiveAutoApply,
          // A12: the AFTER snapshot closes the bracket → per-seat tokens + ≈cost actually render (the
          // machinery was built but never fed). If the BEFORE snapshot failed there is nothing to diff:
          // pass null on both sides so the report reports "not measured" rather than a fabricated $0.
          tokensBefore: loopTokensBefore,
          tokensAfter: loopTokensBefore ? tokenSnapshot(loopTokenSince) : null
          // Per-seat findings + §6 verdicts are derived from `out` inside buildRunMetrics
          // (seatContextFromResult) — including any or-* seat. Per-seat CALL counts/durations live inside
          // the review engine and are not derivable here; they stay 0 until it reports them.
        });
        const file = writeFixReportHtml(cwd, out, { seats: "Claude · Codex · Grok", sensitiveAutoApply, generatedAt: nowIso(), metrics: meta.metrics, ...(meta.shape ? { shape: meta.shape } : {}) });
        console.log(renderFixLoopReport(out));
        console.log(`\nHTML report: ${file}`);
        return;
      }
      console.log(renderFixLoopReport(out));
      return;
    }

    let findings;
    if (options.from) {
      // Confine --from to the project root (no absolute/.. escape) the same way
      // --doc-path is confined: it is read and JSON-parsed, so a stray path could
      // otherwise slurp an arbitrary file as "findings".
      const base = workspaceRoot(cwd);
      const target = path.resolve(base, String(options.from));
      const rel = path.relative(base, target);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`--from must stay within the project root (got: ${options.from})`);
      const raw = JSON.parse(fs.readFileSync(target, "utf8"));
      findings = Array.isArray(raw) ? raw : raw.findings ?? raw.all ?? [];
    } else {
      if (!options.json) console.error("No --from findings file; running a fresh audit review first…");
      // Honor --groups/--max-cells for the fresh review here too, mirroring `audit review`'s wiring —
      // otherwise a grouped request passed validation up front but silently ran the plain per-file
      // engine instead of the grouped six-eyes matrix (council companion-cli P2).
      let rev;
      if (options.groups) {
        let maxCells = GROUPED_CLI_DEFAULT_MAX_CELLS;
        if (options["max-cells"] != null) {
          const n = Number(options["max-cells"]);
          if (!Number.isFinite(n) || n < 1) throw new Error("--max-cells must be a positive number");
          maxCells = Math.floor(n);
        }
        if (options.budget != null && !options.json) {
          console.error("note: --budget does not bound --groups (grouped cost is bounded by --max-cells); ignoring --budget for this run");
        }
        rev = await runGroupedReview(cwd, model, backends, {
          ...merged,
          maxUnits,
          lensGroups: String(options.groups),
          maxCells,
          completenessCritic,
          skipCodex: merged.skipCodex,
          skipGrok: merged.skipGrok,
          onProgress: options.json ? undefined : (m) => console.error(m)
        });
      } else {
        rev = await runAuditReview(cwd, model, backends, { ...merged, budget, maxUnits, skipCodex: merged.skipCodex, skipGrok: merged.skipGrok });
      }
      findings = rev.findings;
    }
    let maxFixes;
    if (options["max-fixes"] != null) {
      const n = Number(options["max-fixes"]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--max-fixes must be a positive number");
      maxFixes = Math.floor(n);
    }
    // runAuditFix reads camelCase retryOnLimit/retryLimit; mergeOptionsWithPolicy never converts the
    // kebab CLI keys, so single-shot `audit fix --retry-on-limit` was silently ignored — only --loop
    // translated them (council Opus O6). Thread them here too (validated like its numeric siblings).
    let singleRetryLimit;
    if (options["retry-limit"] != null) {
      const n = Number(options["retry-limit"]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--retry-limit must be a positive number");
      singleRetryLimit = Math.floor(n);
    }
    // §6 council-gated auto-apply is wired ONLY in the --loop path (it injects the patch reviewer);
    // single-shot `audit fix` has no reviewer, so runAuditFix forces sensitiveAutoApply off. Warn so a
    // user passing --sensitive-auto-apply single-shot isn't misled into thinking it took effect (F3).
    if (options["sensitive-auto-apply"] && !options.json) {
      console.error("note: --sensitive-auto-apply has no effect on single-shot `audit fix` (§6 council review runs only in `audit fix --loop`); sensitive fixes stay propose-only");
    }
    const tFix = Date.now();
    // A12: same token bracket as the loop path — snapshot before the run, diff after it, only when --html
    // will consume it. Same `sinceMs` for both ends (see tokenSnapshot).
    const fixTokenSince = Date.now() - TOKEN_SNAPSHOT_WINDOW_MS;
    const fixTokensBefore = options.html ? tokenSnapshot(fixTokenSince) : null;
    // §5 char-test gate (opt-in --chartest) also on single-shot `audit fix`: a behaviour-preserving
    // refactor must keep its generated characterization test green across the change. null when off;
    // fail-loud (via resolveCharTestGate, same as the --loop path) when requested but no generator seat
    // is reachable — otherwise the raw helper would return null and refactors would auto-apply UNGATED
    // while the operator believes --chartest is protecting them (council companion-cli P1).
    const singleCharTestGate = resolveCharTestGate(cwd, backends, merged, options);
    const out = await runAuditFix(cwd, findings, backends, {
      ...merged,
      dryRun: options["dry-run"],
      allowUntested: options["allow-untested"],
      minSeverity: fixMinSeverity,
      maxFixes,
      retryOnLimit: options["retry-on-limit"],
      retryLimit: singleRetryLimit,
      onProgress: options.json ? undefined : (m) => console.error(m)
    }, singleCharTestGate ? { charTestGate: singleCharTestGate } : {});
    if (!options["dry-run"]) {
      recordAuditMetrics(cwd, "fix", { wallClockMs: Date.now() - tFix, fixed: out.fixed?.length ?? 0, failed: out.failed?.length ?? 0, rejected: out.rejected?.length ?? 0, ledgerResolved: out.ledgerResolved ?? 0, integrationFailed: Boolean(out.integrationFailed) }, nowIso());
    }
    if (options.json) {
      outputResult(out, true);
      return;
    }
    if (options.html) {
      const meta = await computeFixReportMeta(cwd, out, {
        startedAt: new Date(tFix).toISOString(),
        wallClockMs: Date.now() - tFix,
        finishedAt: nowIso(),
        autonomy: options.autonomy ?? "aggressive",
        sensitiveAutoApply: false,
        tokensBefore: fixTokensBefore,
        tokensAfter: fixTokensBefore ? tokenSnapshot(fixTokenSince) : null
      });
      const file = writeFixReportHtml(cwd, out, { seats: "Claude · Codex · Grok", sensitiveAutoApply: Boolean(out.sensitiveAutoApply), generatedAt: nowIso(), metrics: meta.metrics, ...(meta.shape ? { shape: meta.shape } : {}) });
      console.log(renderAuditFixReport(out));
      console.log(`\nHTML report: ${file}`);
      return;
    }
    console.log(renderAuditFixReport(out));
    return;
  }

  // `audit endless` (v4): bounded review passes until returns diminish / budget /
  // max passes. A REVIEW+PROPOSE loop (never endless auto-fix). Interruptible;
  // progress is checkpointed to the state dir.
  if (positionals[0] === "endless") {
    const backends = probeBackends(cwd, ROOT_DIR);
    const _orPolicy = loadPolicy(cwd);
    const merged = mergeOptionsWithPolicy(options, _orPolicy);
    attachOpenRouterSeats(backends, merged, _orPolicy, options.json); // OpenRouter seats (if configured) join the six-eyes
    // No callable reviewer => every pass reviews nothing and would falsely report
    // "diminishing returns"; fail loud instead of looping over empty passes.
    if (activeReviewerCount(backends, merged) === 0) {
      throw new Error("no callable reviewers (Codex/Grok/Claude all unavailable or skipped) — endless review needs at least one");
    }
    const { maxUnits } = parseAuditBudgetOptions(options);
    // R9: --groups drives the endless loop off the grouped six-eyes review. Validate up front (before
    // any spend) + scale the AGENT-CALL budget to cell-scale (a grouped pass is up to maxCells calls).
    let endlessLensGroups;
    let endlessMaxCells;
    if (options.groups) {
      if (!["fine", "tier", "lens"].includes(String(options.groups))) throw new Error(`--groups must be one of fine|tier|lens (got: ${options.groups})`);
      endlessLensGroups = String(options.groups);
      endlessMaxCells = GROUPED_CLI_DEFAULT_MAX_CELLS;
      if (options["max-cells"] != null) {
        const nc = Number(options["max-cells"]);
        if (!Number.isFinite(nc) || nc < 1) throw new Error("--max-cells must be a positive number");
        endlessMaxCells = Math.floor(nc);
      }
    }
    let budget = endlessLensGroups ? endlessMaxCells * 4 : 60;
    if (options.budget != null) {
      const n = Number(options.budget);
      if (!Number.isFinite(n) || n < 2) throw new Error("--budget must be a number >= 2");
      budget = Math.floor(n);
    }
    if (endlessLensGroups && !options.json) {
      console.error(`note: --groups prices each review cell as one agent call; the loop budget is ${budget} cells total (each pass reviews up to min(--max-cells ${endlessMaxCells}, its per-pass budget)). Raise --budget for deeper coverage / more passes.`);
    }
    let maxPasses = 10;
    if (options["max-passes"] != null) {
      const n = Number(options["max-passes"]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--max-passes must be a positive number");
      maxPasses = Math.floor(n);
    }
    let dryStreak = 2;
    if (options["dry-streak"] != null) {
      const n = Number(options["dry-streak"]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--dry-streak must be a positive number");
      dryStreak = Math.floor(n);
    }
    // Each pass advances the hotspot window (progressive coverage) and skips the global reduce after
    // pass 1 (its input is the static map — identical every pass — so re-running it just re-charges
    // budget). With --groups the pass is the cell-granular grouped review whose passComplete gates the
    // dry streak. The window WRAPS (% unit count) so an overrun never returns a 0-unit review that
    // grouped would report as never-complete (council R9 Claude/Codex). Grouped cells are capped to the
    // per-pass budget so a pass never dispatches more paid calls than it is allotted (council R9 P1).
    const nonTestUnits = Math.max(1, (model?.files ?? []).filter((f) => !f.isTest).length);
    const doEndlessReview = endlessLensGroups ? runGroupedReview : runAuditReview;
    const review = ({ budget: passBudget, pass }) =>
      doEndlessReview(cwd, model, backends, {
        ...merged,
        budget: passBudget,
        maxUnits,
        unitOffset: ((pass - 1) * maxUnits) % nonTestUnits,
        skipReduce: pass > 1,
        lensGroups: endlessLensGroups,
        maxCells: endlessLensGroups ? Math.max(1, Math.min(endlessMaxCells, Math.floor(passBudget))) : undefined,
        completenessCritic: completenessCritic && Boolean(endlessLensGroups), // M8: only on the grouped endless path
        skipCodex: merged.skipCodex,
        skipGrok: merged.skipGrok
      });
    const tEndless = Date.now();
    const endlessOpts = { budget, maxPasses, dryStreak, onProgress: options.json ? undefined : (m) => console.error(m) };
    // C3/M10: --supervise survives rate-limit resets across a multi-hour endless review.
    const out = options.supervise
      ? await runSupervised(
          ({ resume }) => runEndless(cwd, { ...endlessOpts, resume: resume || options.resume }, { review }),
          { onWait: ({ attempt, waitMs, stopReason }) => options.json || console.error(`⏸ supervisor: rate-limited — reset-aware wait ${Math.round(waitMs / 1000)}s (attempt ${attempt}) [${stopReason}]…`) }
        )
      : await runEndless(cwd, { ...endlessOpts, resume: options.resume }, { review });
    recordAuditMetrics(cwd, "endless", { wallClockMs: Date.now() - tEndless, passesRun: out.passesRun, spent: out.spent, findings: out.findings.length, stopReason: out.stopReason }, nowIso());
    if (options.doc) {
      const docPath = writeAuditDoc(workspaceRoot(cwd), out.findings, { source: `endless (${out.passesRun} passes)` }, { docPath: options["doc-path"] });
      if (!options.json) console.log(`Wrote proposals to ${docPath}`);
    }
    if (options.json) {
      outputResult(out, true);
      return;
    }
    console.log(renderAuditEndlessReport(out));
    return;
  }

  if (options.doc) {
    const docPath = writeAuditDoc(workspaceRoot(cwd), model.findings, { source: "static" }, { docPath: options["doc-path"] });
    if (!options.json) console.log(`Wrote proposals to ${docPath}`);
  }
  if (options.json) {
    outputResult(model, true);
    return;
  }
  console.log(renderAuditReport(model));
}

// Flatten newlines + cap length before emitting UNTRUSTED reviewer text (title/
// detail/file, sourced from external Codex/Grok output) into a markdown list, so
// crafted output cannot inject fake list items or instructions into the report
// that Claude then synthesizes.
function reportField(s, max = 500) {
  return String(s ?? "").replace(/[\r\n]+/g, " ").replace(/`/g, "'").slice(0, max);
}

function renderAuditReviewReport(out) {
  const c = out.coverage;
  const L = [];
  L.push("# Council Audit — deep review (v2)");
  L.push("");
  const reviewers = c.reviewers ? Object.entries(c.reviewers).filter(([, on]) => on).map(([k]) => k).join("+") || "none" : "Codex+Grok";
  if (c.groupPreset) {
    // M7 six-eyes GROUPED path — cell-granular coverage instead of per-file. Report cellsScheduled
    // as the authoritative post-cap count (models × groups × files × CHUNKS, then capped), NOT a
    // reviewers×groups×units equation which lies for multi-chunk or capped runs (council Grok P2).
    const gExtras = [];
    if (c.capped) gExtras.push(`capped — ${c.cellsDropped} cell(s) deferred (raise --max-cells)`);
    if (c.filesUnsupplied?.length) gExtras.push(`${c.filesUnsupplied.length} file(s) too large or unreadable`);
    if (c.unitsFailed) gExtras.push(`${c.unitsFailed} unit(s) had no successful cell`);
    if (c.ran === false) gExtras.push(c.ranReason ?? "nothing dispatched");
    L.push(`Six-eyes GROUPED review (--groups ${c.groupPreset}): ${reviewers} across ${c.groups} lens-group(s) over ${c.unitsReviewed ?? 0}/${c.unitsSelected} module(s), ${c.cellsScheduled} cell(s) scheduled. Coverage ${c.complete ? "COMPLETE (every scheduled cell reviewed by all seats)" : "PARTIAL"}.${gExtras.length ? ` ⚠ ${gExtras.join("; ")}.` : ""} Findings are candidates — Claude (you) should synthesize a decision table.`);
  } else {
    const extras = [];
    if (c.reduceRan === false) extras.push("global SSOT/architecture reduce SKIPPED (budget/reviewers)");
    if (c.truncatedUnits) extras.push(`${c.truncatedUnits} module(s) truncated — tail unreviewed`);
    if (c.unitsFailed) extras.push(`${c.unitsFailed} unit(s) failed`);
    if (c.unparsedReturns) extras.push(`${c.unparsedReturns} unparseable reviewer return(s) after retry`);
    L.push(`Reviewed ${c.unitsReviewed}/${c.unitsSelected} hotspot modules with ${reviewers} (budget ${c.budgetSpent}/${c.budgetTotal} agent calls). ${c.suppliedChars}/${c.totalCharsOfReviewed} chars of reviewed modules supplied.${extras.length ? ` ⚠ ${extras.join("; ")}.` : ""} Findings are candidates — Claude (you) should synthesize a decision table.`);
  }
  L.push("");
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  const sorted = [...out.findings].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  L.push(`## Findings (${sorted.length})`);
  for (const f of sorted) {
    const agents = f.agents ? ` [${f.agents.join("+")}]` : "";
    L.push(`- **${f.severity}** [${reportField(f.category, 40)}]${agents} ${reportField(f.title, 200)}${f.file ? ` · ${reportField(f.file, 200)}${f.line ? `:${f.line}` : ""}` : ""}${f.consensus ? " · consensus" : ""} · ${f.scope ?? "?"}`);
    if (f.detail) L.push(`  ${reportField(f.detail)}`);
  }
  L.push("");
  L.push("Next (Claude): verify consensus + P0/P1, produce Fix now / Verify / Ignore.");
  return L.join("\n");
}

/** Parse + validate the shared --budget / --max-units options for audit review/fix. */
function parseAuditBudgetOptions(options) {
  let budget = 20;
  if (options.budget != null) {
    const n = Number(options.budget);
    if (!Number.isFinite(n) || n < 2) throw new Error("--budget must be a number >= 2");
    budget = Math.floor(n);
  }
  let maxUnits = 12;
  if (options["max-units"] != null) {
    const n = Number(options["max-units"]);
    if (!Number.isFinite(n) || n < 1) throw new Error("--max-units must be a positive number");
    maxUnits = Math.floor(n);
  }
  return { budget, maxUnits };
}

function renderAuditFixReport(out) {
  const L = [];
  L.push("# Council Audit — safe auto-fix (v3)");
  L.push("");
  if (!out.ok) {
    L.push(`✗ ${out.error}`);
    return L.join("\n");
  }
  if (out.dryRun) {
    L.push(`Dry run — ${out.planned.length} file(s) would be fixed${out.gated ? " (test-gated)" : " (UNVERIFIED — no test gate)"}, ${out.rejected.length} finding(s) rejected. No branch created, nothing edited.`);
    for (const t of out.planned) {
      L.push(`- **${t.file}** — ${t.findings.length} finding(s): ${t.findings.map((f) => `${f.severity} ${f.title}`).join("; ")}`);
    }
    if (out.rejected.length) {
      L.push("");
      L.push("## Rejected (never auto-fixed)");
      for (const r of out.rejected) L.push(`- ${r.finding.severity ?? "?"} ${r.finding.title ?? "(untitled)"}${r.finding.file ? ` · ${r.finding.file}` : ""} — ${r.reason}`);
    }
    return L.join("\n");
  }
  if (!out.branch) {
    L.push(out.note ?? "Nothing to fix.");
    if (out.rejected?.length) {
      L.push("");
      for (const r of out.rejected) L.push(`- skipped: ${r.finding.title ?? "(untitled)"} — ${r.reason}`);
    }
    return L.join("\n");
  }
  const gate = out.gated ? "tests green per commit" : "⚠ UNVERIFIED (no test gate — fixes committed without verification)";
  L.push(`Integration branch **${out.branch}** (off ${String(out.baseRef).slice(0, 8)}), ${gate}. Base branch never modified${out.returnedToBase ? `; returned to ${out.baseBranch}` : ""}.`);
  if (out.integration) L.push(out.integration.ok ? "Final full test run: **green**." : "Final full test run: **RED** — ok:false; review the branch before merging, do NOT merge as-is.");
  if (out.capped) L.push(`⚠ ${out.capped} eligible finding(s) skipped by the --max-fixes cap.`);
  // Automation-bias counter (docs/enterprise-fix-design.md §6): make the gaps as
  // visible as the passes so a human scrutinizes the branch instead of a wall of green.
  const oStates = {
    active: "oracle (lint/typecheck): **green per fix**",
    disabled: "oracle (lint/typecheck): **DISABLED** (baseline not green) — only tests gated these fixes",
    none: "oracle (lint/typecheck): **none detected** — only tests gated these fixes"
  };
  L.push("");
  L.push("## Verified vs. NOT verified (review the gaps)");
  L.push(`- test gate: ${out.gated ? "**green per commit + final integration**" : "**OFF — fixes UNVERIFIED**"}`);
  L.push(`- ${oStates[out.oracleState] ?? "oracle: unknown"}`);
  L.push("- export/API snapshot: name-level, regex-based (fails closed on star-reexport / whole CommonJS)");
  L.push("- content protection: **pattern-based**, not a full secret/CI/migration scanner — eyeball the diffs");
  L.push("- NOT measured yet: change-line coverage, behaviour-equivalence, mutation adequacy (later milestones)");
  L.push("");
  L.push(`## Fixed (${out.fixed.length})`);
  for (const f of out.fixed) L.push(`- ✓ ${f.finding.severity} ${f.finding.title} · \`${f.file}\` · ${String(f.commit).slice(0, 8)}`);
  if (out.failed.length) {
    L.push("");
    L.push(`## Failed / reverted (${out.failed.length})`);
    for (const f of out.failed) L.push(`- ✗ ${f.finding.severity} ${f.finding.title} · \`${f.file}\` — ${f.reason}`);
  }
  if (out.skipped.length) {
    L.push("");
    L.push(`## Skipped (${out.skipped.length})`);
    for (const s of out.skipped) L.push(`- – ${s.finding.title} · \`${s.file}\` — ${s.reason}`);
  }
  if (out.rejected.length) {
    L.push("");
    L.push(`## Rejected — never eligible (${out.rejected.length})`);
    for (const r of out.rejected) L.push(`- ${r.finding.severity ?? "?"} ${r.finding.title ?? "(untitled)"}${r.finding.file ? ` · ${r.finding.file}` : ""} — ${r.reason}`);
  }
  L.push("");
  L.push(`Review: \`git checkout ${out.branch}\` → inspect the per-fix commits → merge or discard. Nothing was auto-merged.`);
  return L.join("\n");
}

function renderFixLoopReport(out) {
  const L = [];
  L.push("# Council Audit — autonomous fix loop (M3)");
  L.push("");
  L.push(`${out.passesRun} pass(es) · ${out.fixed.length} fix(es) committed · ${out.failed.length} reverted · ${out.proposed.length} proposal(s). Stopped: ${out.stopReason ?? "—"}.`);
  if (out.branch) L.push(`Integration branch **${out.branch}** — review + merge or discard. Nothing was auto-merged.`);
  if (out.stranded) L.push(`⚠ Could not return to base **${out.baseBranch}** — you are still on the integration branch. Resolve the tree, then \`git checkout ${out.baseBranch}\`.`);
  L.push(`Budget: ${out.spent}/${out.budget} agent calls.`);

  // Automation-bias counter (§6): make the gaps as visible as the passes.
  const unverified = out.fixed.filter((f) => f.verified === false).length;
  L.push("");
  L.push("## Verified vs. NOT verified (review the gaps)");
  L.push(`- ${out.fixed.length - unverified}/${out.fixed.length} fix(es) test-gated (green per commit + final integration)${unverified ? ` · ${unverified} UNVERIFIED (--allow-untested)` : ""}`);
  L.push("- change-line coverage is §5-gated per fix WHEN a coverage artifact (--coverage/lcov) was supplied, else NOT measured; behaviour-equivalence + mutation adequacy are NOT measured — eyeball the diffs + the proposals below");

  if (out.fixed.length) {
    L.push("");
    L.push(`## Fixed (${out.fixed.length})`);
    for (const f of out.fixed) L.push(`- ${f.verified === false ? "⚠" : "✓"} ${f.finding?.severity ?? ""} ${f.finding?.title ?? "(untitled)"} · \`${f.file}\``);
  }
  if (out.failed.length) {
    L.push("");
    L.push(`## Reverted (${out.failed.length})`);
    for (const f of out.failed.slice(0, 20)) L.push(`- ✗ ${f.finding?.severity ?? ""} ${f.finding?.title ?? "(untitled)"} · \`${f.file ?? f.finding?.file ?? ""}\` — ${f.reason ?? "reverted"}`);
  }
  if (out.proposed.length) {
    L.push("");
    L.push(`## Proposals — surfaced, not auto-fixed (${out.proposed.length})`);
    for (const p of out.proposed.slice(0, 20)) L.push(`- ${p.severity ?? ""} ${p.title ?? "(untitled)"}${p.file ? ` · \`${p.file}\`` : ""}${p.rejectedReason ? ` — ${p.rejectedReason}` : ""}`);
    if (out.proposed.length > 20) L.push(`- … and ${out.proposed.length - 20} more`);
  }
  if (out.branch) {
    L.push("");
    L.push(`Review: \`git checkout ${out.branch}\` → inspect the per-fix commits → merge or discard.`);
  }
  return L.join("\n");
}

function renderAuditRunReport(report) {
  const GATE = { pass: "✅ PASS", fail: "⛔ FAIL", indeterminate: "🟠 INDETERMINATE" };
  const c = report.coverage ?? {};
  const L = [];
  L.push("# Council Audit — full report (v5)");
  L.push("");
  L.push(`Gate: **${GATE[report.gate?.status] ?? report.gate?.status}**${report.gate?.newHighSeverity ? ` · ${report.gate.newHighSeverity} new P0/P1` : ""}`);
  L.push(`Coverage: ${c.mandatory?.done ?? 0}/${c.mandatory?.total ?? 0} mandatory reviewed · ${c.total ?? 0} files mapped${c.mandatory?.complete ? "" : " · ⚠ mandatory surface incomplete"}`);
  if (report.falsePositiveRate) L.push(`False-positive rate: ${Math.round(report.falsePositiveRate.rate * 100)}% (n=${report.falsePositiveRate.n})`);
  L.push("");
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  const flat = (s, n = 140) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/`/g, "'").slice(0, n);
  const top = [...(report.register ?? [])].sort((a, b) => (b.risk?.calibrated ?? 0) - (a.risk?.calibrated ?? 0)).slice(0, 15);
  L.push(`## Risk register (top ${top.length} of ${report.register?.length ?? 0})`);
  for (const f of top) {
    L.push(`- **${f.severity}** [${f.lens}] risk ${f.risk?.calibrated ?? "?"} · ${flat(f.title)}${f.location?.path ? ` · \`${f.location.path}:${f.location.startLine}\`` : ""}${f.lifecycle ? ` · ${f.lifecycle}` : ""}`);
  }
  if (report.proposals?.length) {
    L.push("");
    L.push(`## Propose-only (cross-cutting, ${report.proposals.length}) — never auto-fixed`);
    for (const p of [...report.proposals].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2)).slice(0, 10)) {
      L.push(`- **${p.severity}** [${p.lens}] ${flat(p.title)}${p.location?.path ? ` · \`${p.location.path}\`` : ""}`);
    }
  }
  L.push("");
  L.push("Next (Claude): synthesize; `audit fix` handles only confirmed localized findings.");
  return L.join("\n");
}

function renderAuditEndlessReport(out) {
  const L = [];
  L.push("# Council Audit — endless review (v4)");
  L.push("");
  L.push(`Ran **${out.passesRun} pass(es)**, spent **${out.spent}/${out.budget}** agent calls, accumulated **${out.findings.length}** unique findings. Stopped: ${out.stopReason}.`);
  L.push("");
  L.push("## Passes");
  for (const p of out.passes) {
    if (p.error) L.push(`- pass ${p.pass}: ERROR — ${p.error}`);
    else L.push(`- pass ${p.pass}: ${p.found} found, **+${p.fresh} new** (spent ${p.spent})`);
  }
  L.push("");
  const rank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  const sorted = [...out.findings].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  L.push(`## Unique findings (${sorted.length})`);
  for (const f of sorted) {
    const agents = f.agents ? ` [${f.agents.join("+")}]` : "";
    L.push(`- **${f.severity}** [${reportField(f.category, 40)}]${agents} ${reportField(f.title, 200)}${f.file ? ` · ${reportField(f.file, 200)}${f.line ? `:${f.line}` : ""}` : ""}${f.consensus ? " · consensus" : ""}${f.scope ? ` · ${f.scope}` : ""}`);
    if (f.detail) L.push(`  ${reportField(f.detail)}`);
  }
  L.push("");
  L.push("Findings are candidates — Claude (you) synthesizes. Progress is checkpointed atomically; re-run with `--resume` to continue accumulating.");
  return L.join("\n");
}

async function handleUsage(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["days"],
    booleanOptions: ["json", "tokens", "limits"] // (dropped dead "all" — handleUsage never read it; F2)
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  const days = options.days != null ? Number(options.days) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive number");
  }
  const homeDir = os.homedir();
  const tokens = options.tokens
    ? collectAllTokenUsage({ homeDir, sinceMs: Date.now() - days * 86_400_000 })
    : null;
  const limits = options.limits
    ? {
        claude: await fetchClaudeLimits(path.join(homeDir, ".claude")),
        codex: collectCodexRateLimits(path.join(homeDir, ".codex")),
        grok: collectGrokLimits(path.join(homeDir, ".grok"))
      }
    : null;
  const jobs = listJobs(root).map((slim) => readJobFile(root, slim.id) ?? slim);
  const kinds = {};
  const agents = {};
  for (const job of jobs) {
    const kind = job.kind ?? "unknown";
    const entry = (kinds[kind] = kinds[kind] ?? { jobs: 0, wallClockMs: 0, byStatus: {} });
    entry.jobs += 1;
    entry.byStatus[job.status] = (entry.byStatus[job.status] ?? 0) + 1;
    const duration = Date.parse(job.finishedAt ?? "") - Date.parse(job.createdAt ?? "");
    if (Number.isFinite(duration) && duration > 0) entry.wallClockMs += duration;
    for (const result of job.results ?? []) {
      if (!result || result.skipped || !result.agent) continue;
      const stats = (agents[result.agent] = agents[result.agent] ?? { calls: 0, failures: 0, timeouts: 0 });
      stats.calls += 1;
      if (result.status !== 0) stats.failures += 1;
      if (result.timedOut) stats.timeouts += 1;
    }
  }
  const notes = [
    "Token usage is not exposed by the external CLIs; the numbers above are per-call statistics from council jobs in this workspace.",
    "Claude: /usage (plan limits) or /cost inside Claude Code.",
    "Codex: /status inside the Codex TUI, or the ChatGPT dashboard.",
    "Grok: the xAI console (grok.com) shows plan usage."
  ];
  if (options.json) {
    outputResult(
      { stateDir: resolveStateDir(cwd), jobs: jobs.length, kinds, agents, tokens, limits, notes },
      true
    );
    return;
  }
  const lines = [];
  if (limits) {
    lines.push(renderLimits(limits), "");
  }
  if (tokens) {
    lines.push(renderTokenUsage(tokens, days), "");
  }
  lines.push(`Council usage (${jobs.length} jobs in this workspace):`);
  for (const [kind, entry] of Object.entries(kinds)) {
    const statuses = Object.entries(entry.byStatus)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    lines.push(`  ${kind.padEnd(12)} jobs=${entry.jobs}  wall-clock=${Math.round(entry.wallClockMs / 60000)}min  (${statuses})`);
  }
  lines.push("Per agent (calls across all council rounds):");
  for (const [agent, stats] of Object.entries(agents)) {
    lines.push(`  ${agent.padEnd(12)} calls=${stats.calls}  failures=${stats.failures}  timeouts=${stats.timeouts}`);
  }
  lines.push("Provider usage/quota:");
  for (const note of notes.slice(1)) lines.push(`  - ${note}`);
  console.log(`${lines.join("\n")}\n`);
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  const job = resolveJob(cwd, positionals[0]);
  if (!job) throw new Error("No job to cancel.");
  if (job.status !== "running" && job.status !== "queued") {
    outputResult(
      options.json ? { job, cancelled: false } : `Job ${job.id} is not active.\n`,
      options.json
    );
    return;
  }
  if (job.pid) terminateProcessTree(job.pid);
  const finished = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    finishedAt: nowIso(),
    updatedAt: nowIso()
  };
  upsertJob(root, finished);
  outputResult(options.json ? { job: finished, cancelled: true } : `Cancelled ${job.id}.\n`, options.json);
}

// ---------------------------------------------------------------------------------------------
// `council plan` / `council build` — multi-model design deliberation + autonomous test-gated build.
// See docs/plan-build-design.md. plan is strictly READ-ONLY (its only write is the plan artifact in
// the state dir); build is the riskiest capability in the tool and is gated at every step
// (test-first RED->GREEN, the declared-file capability boundary, unanimous §6 on the exact staged
// diff, reviewed-byte commit binding, abort+rollback on any failure, never auto-merged).
// ---------------------------------------------------------------------------------------------

/** Resolve a repo-confined --from path (mirrors handleAudit's confinement: no absolute/.. escape). */
function confinedPlanPath(cwd, from) {
  const base = workspaceRoot(cwd);
  const target = path.resolve(base, String(from));
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`--from must stay within the project root (got: ${from})`);
  }
  return target;
}

/** plan-spec REQUIRES a kind-returning existence probe: "file" | "dir" | false (a bare boolean fails closed). */
function planFileExists(relPosix, root) {
  try {
    const st = fs.statSync(path.join(root, relPosix));
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : false;
  } catch {
    return false;
  }
}

async function handlePlan(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["synthesizer", "budget", "base", "codex-model", "grok-model", "claude-model"],
    booleanOptions: ["json", "skip-openrouter"]
  });
  const cwd = process.cwd();
  const request = positionals.join(" ").trim();
  if (!request) throw new Error("council plan needs a feature request: council plan <what you want built>");

  const backends = probeBackends(cwd, ROOT_DIR, { probeClaude: true });
  const policy = loadPolicy(cwd);
  const merged = mergeOptionsWithPolicy(options, policy);
  attachOpenRouterSeats(backends, merged, policy, options.json); // or-* seats are part of the six-eyes promise
  if (activeReviewerCount(backends, merged) === 0) {
    throw new Error("no callable seats (Codex/Grok/Claude all unavailable or skipped) — `council plan` needs at least one to propose");
  }

  const out = await runPlanDeliberation(cwd, request, backends, {
    ...merged,
    synthesizer: options.synthesizer,
    budget: options.budget != null ? Number(options.budget) : undefined,
    onPhase: options.json ? undefined : (m) => console.error(m)
  });
  if (!out?.planSpec) throw new Error("the council could not synthesize a VALID PlanSpec (fail-closed: an invalid plan is never emitted)");

  // Persist BOTH artifacts so `council build --from <path>` works, and print the path.
  const dir = ensureStateDir(cwd);
  const slug = `plan-${planSpecDigest(out.planSpec).slice(0, 8)}`;
  const jsonPath = path.join(dir, `${slug}.json`);
  const mdPath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(out.planSpec, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, renderPlanMarkdown(out.planSpec), "utf8");

  if (options.json) {
    outputResult({ planSpec: out.planSpec, seats: out.seats, synthesizer: out.synthesizer, ranking: out.ranking, budget: out.budget, artifacts: { json: jsonPath, markdown: mdPath } }, true);
    return;
  }
  console.log(renderPlanMarkdown(out.planSpec));
  console.log(`\nSeats: ${out.seats.join(" · ")} (synthesized by ${out.synthesizer})`);
  console.log(`Plan saved:\n  ${mdPath}\n  ${jsonPath}`);
  console.log(`\nReview/edit the plan, then build it:\n  council build --from ${path.relative(workspaceRoot(cwd), jsonPath).split(path.sep).join("/")}`);
}

async function handleBuild(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["from", "base", "codex-model", "grok-model", "claude-model"],
    booleanOptions: ["json", "dry-run", "skip-openrouter"]
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  if (!options.from) throw new Error("council build needs a PlanSpec: council build --from <plan.json> (produce one with `council plan`)");

  const planPath = confinedPlanPath(cwd, options.from);
  let raw;
  try {
    raw = fs.readFileSync(planPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read the PlanSpec at ${options.from}: ${err?.message ?? err}`);
  }
  const parsed = parsePlanSpec(raw);
  if (!parsed.ok) throw new Error(`the PlanSpec is not valid JSON: ${parsed.error}`);
  const check = validatePlanSpec(parsed.spec, { root, fileExists: planFileExists });
  if (!check.valid) throw new Error(`the PlanSpec is INVALID (fail-closed — nothing is built):\n  - ${check.errors.join("\n  - ")}`);
  const planSpec = check.value;

  // A positional request, when given, must be the SAME request the plan was made for — otherwise the
  // operator believes they are building X while the plan builds Y.
  const askedFor = positionals.join(" ").trim();
  if (askedFor && requestDigest(askedFor) !== planSpec.requestHash) {
    throw new Error("the feature request you passed does not match the one this PlanSpec was made for — refusing to build a plan for a different request");
  }

  const backends = probeBackends(cwd, ROOT_DIR, { probeClaude: true });
  const policy = loadPolicy(cwd);
  const merged = mergeOptionsWithPolicy(options, policy);
  attachOpenRouterSeats(backends, merged, policy, options.json);

  if (options["dry-run"]) {
    // Preflight + validation ONLY. Spends nothing.
    const ready = buildReviewerReady(backends, merged);
    const lines = [
      `PlanSpec ${planSpecDigest(planSpec).slice(0, 8)} — ${planSpec.steps.length} step(s), base ${String(planSpec.baseCommit).slice(0, 8)}`,
      `Request: ${planSpec.request}`,
      "",
      ...planSpec.steps.map((s, i) => `  ${i + 1}. [${s.id}] ${s.title}\n       files: ${planStepTouched(s).join(", ")}`),
      "",
      `§6 required seats: ${Object.keys(ready).filter((k) => k !== "ready").join(", ")} — ${ready.ready ? "ALL reachable" : "NOT all reachable (build would refuse to start)"}`,
      "",
      "(--dry-run: nothing was built and no model was called)"
    ];
    outputResult(options.json ? { planSpec, dryRun: true, reviewerReady: ready } : `${lines.join("\n")}\n`, options.json);
    return;
  }

  const out = await runBuild(cwd, planSpec, backends, {
    ...merged,
    onProgress: options.json ? undefined : (m) => console.error(m)
  }, { git: makeBuildGit(root) });

  if (options.json) {
    outputResult(out, true);
  } else {
    console.log(renderBuildReport(out));
  }
  // Any failed gate / stranded run is a non-zero exit — a build that did not fully land must not look green.
  if (!out?.ok || out?.stranded) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  if (!command || command === "help" || command === "-h" || command === "--help") {
    printUsage();
    return;
  }
  try {
    switch (command) {
      case "setup":
        await handleSetup(rest);
        break;
      case "review":
        await handleReview(rest, false, false);
        break;
      case "adversarial":
      case "adversarial-review":
        await handleReview(rest, true, false);
        break;
      case "deliberate":
      case "deliberation":
        await handleReview(rest, false, true);
        break;
      case "solve":
        await handleReview(rest, false, false, true);
        break;
      case "status":
        handleStatus(rest);
        break;
      case "result":
        handleResult(rest);
        break;
      case "wait":
        await handleWait(rest);
        break;
      case "watch":
        await handleWatch(rest);
        break;
      case "audit":
        await handleAudit(rest);
        break;
      case "plan":
        await handlePlan(rest);
        break;
      case "build":
        await handleBuild(rest);
        break;
      case "usage":
        await handleUsage(rest);
        break;
      case "doctor":
        await handleDoctor(rest);
        break;
      case "metrics":
        handleMetrics(rest);
        break;
      case "history":
        handleHistory(rest);
        break;
      case "fixloop-status":
        handleFixloopStatus(rest);
        break;
      case "benchmark":
        await handleBenchmark(rest);
        break;
      case "worktree":
        handleWorktree(rest);
        break;
      case "ledger":
        handleLedger(rest);
        break;
      case "overview":
        handleOverview(rest);
        break;
      case "cancel":
        handleCancel(rest);
        break;
      case "worker":
        await handleWorker(rest);
        break;
      default:
        printUsage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
