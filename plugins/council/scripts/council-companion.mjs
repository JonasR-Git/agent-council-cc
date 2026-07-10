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
  unknownReviewers
} from "./lib/policy.mjs";
import { runSolve } from "./lib/solve.mjs";
import { aggregateBenchmarks, readBenchmarks, runBenchmark } from "./lib/benchmark.mjs";
import { evaluateBudget, gatherWindowPressure, renderBudgetBreaches } from "./lib/budget.mjs";
import { aggregateMetrics, readMetrics, recordJobMetrics, renderMetrics } from "./lib/metrics.mjs";
import {
  collectAllTokenUsage,
  collectCodexRateLimits,
  collectGrokLimits,
  fetchClaudeLimits,
  renderLimits,
  renderTokenUsage
} from "./lib/token-usage.mjs";
import { runCommandAsync, terminateProcessTree } from "./lib/process.mjs";
import { setTimeout as delay } from "node:timers/promises";

import { readLedgerEntries, resolveLedgerEntry } from "./lib/ledger.mjs";
import { renderOverview } from "./lib/overview.mjs";
import { colorize, formatDashboard, summarizeFindings, summarizeProgress } from "./lib/watch.mjs";
import { writeJobHtml } from "./lib/html-report.mjs";
import { addWorktree, listWorktrees, removeWorktree } from "./lib/worktree.mjs";
import { collectVerdicts, evaluateApproval, selectActionable } from "./lib/verdicts.mjs";
import {
  appendLogLine,
  archiveJobResults,
  createJobLogFile,
  generateJobId,
  listAllJobsDirs,
  listJobs,
  nowIso,
  readJobFile,
  resolveStateDir,
  upsertJob,
  workspaceRoot
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
      "  --wait|--background  --base <ref>  --scope auto|working-tree|branch",
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
    report.nextSteps.push("Codex: install the Codex plugin (/plugin install codex@openai-codex) and run `codex login`.");
  }
  if (wants("grok") && !backends.grok.cli.available) {
    report.nextSteps.push("Grok: install the Grok Build CLI (https://x.ai/cli) and run `grok login`.");
  }
  if (wants("grok") && !backends.grok.companionAvailable) {
    report.nextSteps.push("Grok: optionally install the grok plugin (/plugin install grok@agent-council); council can also call the grok CLI directly.");
  }
  if (wants("claude") && claudeBackend === "spawn" && !backends.claude.cli.available) {
    report.nextSteps.push("Claude (spawn backend): install the Claude CLI or set CLAUDE_BIN; run `claude` once to log in. Or use claude_backend: session.");
  }
  if (ready) {
    report.nextSteps.push("Try `/council:deliberate` (3-way protocol) or `/council:review --background`.");
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
  const defaultMode = options["default-mode"] === "review" ? "review" : "deliberate";

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
  if (adversarial && focusText) args.push(focusText);
  return args;
}

function buildGrokReviewArgs(options, adversarial, focusText) {
  const { grokModel, grokEffort } = resolveAgentModels(options);
  const args = [];
  if (options.base) args.push("--base", options.base);
  if (options.scope) args.push("--scope", options.scope);
  if (grokModel) args.push("--model", grokModel);
  if (grokEffort) args.push("--effort", grokEffort);
  if (adversarial && focusText) args.push(focusText);
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
  return {
    agent: "codex",
    backend: "codex-companion",
    companion: backends.codex.companion,
    model: codexModel ?? "(Codex default from ~/.codex/config.toml)",
    skipped: false,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    durationMs: result.durationMs ?? null,
    command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`
  };
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
    return {
      agent: "grok",
      backend: "grok-companion",
      companion: backends.grok.companion,
      model: grokModel ?? "(Grok default from ~/.grok/config.toml [models].default)",
      skipped: false,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: Boolean(result.timedOut),
      truncated: Boolean(result.truncated),
      durationMs: result.durationMs ?? null,
      command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`
    };
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

  const promptFile = path.join(resolveStateDir(cwd), `prompt-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt, "utf8");

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
  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* ignore */
  }
  return {
    agent: "grok",
    backend: "grok-cli-direct",
    companion: bin,
    model: grokModel ?? "(Grok default from ~/.grok/config.toml [models].default)",
    skipped: false,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    durationMs: result.durationMs ?? null,
    command: `${bin} ${args.filter((a) => a !== promptFile).join(" ")}`
  };
}

function formatExit(result) {
  return `${result.status}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`;
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
    const skipAgents = [
      guardPolicy.skipCodex ? "codex" : null,
      guardPolicy.skipGrok ? "grok" : null,
      guardPolicy.skipClaude ? "claude" : null
    ].filter(Boolean);
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
  const promptFile = path.join(resolveStateDir(cwd), `doctor-ping-${process.pid}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt, "utf8");
  const args = [backends.codex.companion, "task", "--prompt-file", promptFile];
  try {
    const result = await runCommandAsync(process.execPath, args, { cwd, timeoutMs: 120_000 });
    const ok = result.status === 0 && /COUNCIL-OK/.test(result.stdout);
    return { ok, detail: ok ? "responded" : pingFailDetail(result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
  }
}

async function runGrokPing(cwd, backends, prompt) {
  const bin = backends.grok.bin ?? findGrokBinary();
  const promptFile = path.join(resolveStateDir(cwd), `doctor-grok-${process.pid}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt, "utf8");
  // Match production grok invocation: auto-approve + read-only lockdown, else a
  // tool attempt or approval gate hangs the ping until timeout.
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
  try {
    const result = await runCommandAsync(bin, args, { cwd, timeoutMs: 120_000 });
    const ok = result.status === 0 && /COUNCIL-OK/.test(result.stdout);
    return { ok, detail: ok ? "responded" : pingFailDetail(result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
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

function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : Math.round((sortedNums[mid - 1] + sortedNums[mid]) / 2);
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
    skipped = [
      merged.skipCodex ? "codex" : null,
      merged.skipGrok ? "grok" : null,
      merged.skipClaude ? "claude" : null
    ].filter(Boolean);
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

/**
 * Live dashboard for a running job. Redraws every interval until the job
 * finishes (a real terminal shows it as an updating dashboard). --once/--json
 * print a single snapshot (useful inside captured/non-TTY output).
 */
async function handleWatch(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["interval", "timeout"],
    booleanOptions: ["json", "once"]
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

async function handleUsage(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["days"],
    booleanOptions: ["json", "all", "tokens", "limits"]
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
