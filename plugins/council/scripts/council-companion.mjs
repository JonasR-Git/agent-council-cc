#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { READONLY_DISALLOWED_TOOLS, runDeliberation } from "./lib/deliberate.mjs";
import { councilPluginRoot, findGrokBinary, probeBackends } from "./lib/discover.mjs";
import { loadPolicy, mergeOptionsWithPolicy } from "./lib/policy.mjs";
import { runSolve } from "./lib/solve.mjs";
import { runCommandAsync, terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  createJobLogFile,
  generateJobId,
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
      "",
      "Flags:",
      "  --wait|--background  --base <ref>  --scope auto|working-tree|branch",
      "  --codex-model <id>  --grok-model <id>  --codex-effort <l>  --grok-effort <l>",
      "  --skip-codex  --skip-grok  --claude-findings <path>  --claude-findings-wait <path>",
      "  --wait-timeout <seconds>  --peer-severities P0,P1  --debate-rounds 0|1|2  --json",
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
  const { options } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const cwd = process.cwd();
  const backends = probeBackends(cwd, ROOT_DIR);
  const policy = loadPolicy(cwd);
  const ready =
    backends.node.available &&
    (backends.codex.companionAvailable || backends.codex.cli.available) &&
    (backends.grok.companionAvailable || backends.grok.cli.available);

  const report = {
    ready,
    node: backends.node,
    codex: {
      companion: backends.codex.companion,
      companionAvailable: backends.codex.companionAvailable,
      cli: backends.codex.cli
    },
    grok: {
      companion: backends.grok.companion,
      companionAvailable: backends.grok.companionAvailable,
      bin: backends.grok.bin,
      cli: backends.grok.cli
    },
    policy: {
      source: policy._source,
      default_mode: policy.default_mode,
      codex_model: policy.codex_model,
      grok_model: policy.grok_model,
      focus: policy.focus,
      agent_timeout_minutes: policy.agent_timeout_minutes
    },
    stateDir: resolveStateDir(cwd),
    nextSteps: []
  };

  if (!backends.codex.companionAvailable && !backends.codex.cli.available) {
    report.nextSteps.push("Install Codex plugin: /plugin install codex@openai-codex (and/or `npm i -g @openai/codex`).");
  }
  if (!backends.grok.cli.available) {
    report.nextSteps.push("Install Grok Build CLI (https://x.ai/cli) and run `grok login`.");
  }
  if (!backends.grok.companionAvailable) {
    report.nextSteps.push("Install grok plugin from this marketplace: /plugin install grok@agent-council (optional; council can call grok CLI directly).");
  }
  if (ready) {
    report.nextSteps.push("Try `/council:deliberate` (3-way protocol) or `/council:review --background`.");
  }
  if (!policy._source) {
    report.nextSteps.push("Optional: copy `.council.example.yml` to repo root as `.council.yml`.");
  }

  if (options.json) {
    outputResult(report, true);
    return;
  }

  const lines = [
    `Council setup: ${ready ? "READY" : "PARTIAL / NOT READY"}`,
    `  node:  ${backends.node.detail}`,
    `  codex companion: ${backends.codex.companionAvailable ? backends.codex.companion : "not found"}`,
    `  codex cli: ${backends.codex.cli.available ? backends.codex.cli.detail : backends.codex.cli.detail}`,
    `  grok companion: ${backends.grok.companionAvailable ? backends.grok.companion : "not found"}`,
    `  grok cli: ${backends.grok.cli.available ? backends.grok.cli.detail : backends.grok.cli.detail}`,
    `  policy: ${policy._source ?? "(none - using defaults)"}`,
    `  state: ${report.stateDir}`,
    "Next:"
  ];
  for (const step of report.nextSteps) lines.push(`  - ${step}`);
  console.log(`${lines.join("\n")}\n`);
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
  const backends = probeBackends(cwd, ROOT_DIR);
  const policy = loadPolicy(cwd);
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
    appendLogLine(job.logFile, `Failed: ${message}`);
    throw error;
  }

  async function executeKind() {
  if (solve) {
    appendLogLine(job.logFile, "Solve protocol: independent plans -> plan critique -> ranking");
    const solveRun = await runSolve(cwd, backends, {
      ...mergedOpts,
      policyFocus: policy.focus
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
      results: [...solveRun.r1, ...solveRun.r2],
      solve: {
        ranking: solveRun.ranking,
        plans: solveRun.plans.map((p) => ({ ...p, raw: undefined })),
        debates: solveRun.debates
      },
      report: solveRun.report,
      output: solveRun.report,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null
    };
    upsertJob(root, finished);
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
      policyFocus: policy.focus
    });
    const r1Failed = deliberation.r1.some((r) => !r.skipped && r.status !== 0);
    const allSkipped = deliberation.r1.every((r) => r.skipped && r.agent !== "claude");
    const finished = {
      ...job,
      status: allSkipped ? "failed" : r1Failed ? "completed_with_errors" : "completed",
      phase: "done",
      exitCode: allSkipped ? 1 : 0,
      results: [...deliberation.r1, ...deliberation.r2],
      deliberation: {
        context: deliberation.context,
        merged: deliberation.merged,
        claudeIncluded: deliberation.claudeIncluded
      },
      report: deliberation.report,
      output: deliberation.report,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
      pid: null
    };
    upsertJob(root, finished);
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

  const finished = {
    ...job,
    status: allSkipped ? "failed" : anyFailed ? "completed_with_errors" : "completed",
    phase: "done",
    exitCode: allSkipped ? 1 : 0,
    results,
    report,
    output: report,
    finishedAt: nowIso(),
    updatedAt: nowIso(),
    pid: null
  };
  upsertJob(root, finished);
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
      "cwd"
    ],
    booleanOptions: ["json", "background", "wait", "skip-codex", "skip-grok"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const focusText = positionals.join(" ").trim();
  const waitTimeoutMs = secondsToMs(options["wait-timeout"], "--wait-timeout");
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
    waitTimeoutMs,
    skipCodex: Boolean(options["skip-codex"]),
    skipGrok: Boolean(options["skip-grok"])
  };

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
        : `Job ${job.id}\n  status: ${job.status}\n  title:  ${job.title}\n  summary:${job.summary}\n  updated:${job.updatedAt}\n`,
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
    console.log(`  ${job.id}  ${String(job.status).padEnd(22)}  ${job.title} - ${job.summary ?? ""}`);
  }
  console.log("");
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const job = resolveJob(process.cwd(), positionals[0]);
  if (!job) throw new Error("No council jobs found.");
  if (job.status === "running" || job.status === "queued") {
    outputResult(
      options.json ? { job, pending: true } : `Job ${job.id} is still ${job.status}.\n`,
      options.json
    );
    return;
  }
  if (options.json) {
    outputResult(job, true);
    return;
  }
  console.log(job.report || job.output || "(no report stored)");
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
