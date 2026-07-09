#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { getGrokAuthHint, getGrokAvailability, runGrokPrompt } from "./lib/grok-runtime.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  createJobLogFile,
  generateJobId,
  listJobs,
  nowIso,
  readJobFile,
  resolveStateDir,
  upsertJob
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--json]",
      "  node scripts/grok-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [--json]",
      "  node scripts/grok-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [focus text] [--json]",
      "  node scripts/grok-companion.mjs rescue [--background] [--write] [--model <id>] [--effort <level>] [prompt] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), config);
}

function loadPromptTemplate(name) {
  const file = path.join(ROOT_DIR, "prompts", `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

function interpolateTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

function ensureGrok(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not available. Install Grok Build (https://x.ai/cli) and ensure `grok` is on PATH, then rerun `/grok:setup`."
    );
  }
  return availability;
}

function firstLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || fallback
  );
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const cwd = process.cwd();
  const node = binaryAvailable("node", ["--version"], { cwd });
  const grok = getGrokAvailability(cwd);
  const auth = getGrokAuthHint(cwd);
  const report = {
    ready: node.available && grok.available && auth.loggedIn,
    node,
    grok,
    auth,
    stateDir: resolveStateDir(cwd),
    nextSteps: []
  };
  if (!grok.available) {
    report.nextSteps.push("Install Grok Build CLI and ensure `grok` is on PATH.");
  }
  if (grok.available && !auth.loggedIn) {
    report.nextSteps.push("Run `!grok login` (or `grok login` in a terminal).");
  }
  if (report.ready) {
    report.nextSteps.push("Try `/grok:review --background` then `/grok:status`.");
  }
  outputResult(options.json ? report : renderSetup(report), options.json);
}

function renderSetup(report) {
  const lines = [
    `Grok setup: ${report.ready ? "READY" : "NOT READY"}`,
    `  node: ${report.node.available ? report.node.detail : report.node.detail}`,
    `  grok: ${report.grok.available ? report.grok.detail : report.grok.detail}`,
    `  auth: ${report.auth.detail}`,
    `  state: ${report.stateDir}`
  ];
  if (report.nextSteps.length) {
    lines.push("Next:");
    for (const step of report.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildReviewPrompt(kind, context, focusText) {
  const templateName = kind === "adversarial" ? "adversarial-review" : "review";
  const template = loadPromptTemplate(templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: kind === "adversarial" ? "Adversarial Review" : "Code Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function createJob({ cwd, kind, title, summary }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = {
    id: generateJobId(kind === "rescue" ? "task" : "review"),
    kind,
    title,
    summary,
    status: "running",
    phase: "starting",
    workspaceRoot,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    pid: process.pid,
    logFile: null,
    exitCode: null,
    output: null,
    stderr: null
  };
  job.logFile = createJobLogFile(workspaceRoot, job.id);
  upsertJob(workspaceRoot, job);
  return job;
}

function finishJob(workspaceRoot, job, patch) {
  const next = {
    ...job,
    ...patch,
    updatedAt: nowIso(),
    finishedAt: nowIso()
  };
  upsertJob(workspaceRoot, next);
  return next;
}

function runReview(cwd, options) {
  ensureGrok(cwd);
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  const context = collectReviewContext(cwd, target);
  const focusText = options.focusText ?? "";
  const kind = options.adversarial ? "adversarial" : "review";
  const prompt = buildReviewPrompt(kind, context, focusText);
  const summary = `${target.label}${focusText ? ` — ${focusText.slice(0, 80)}` : ""}`;
  const job =
    options.existingJob ??
    createJob({
      cwd,
      kind,
      title: kind === "adversarial" ? "Grok Adversarial Review" : "Grok Review",
      summary
    });
  job.title = kind === "adversarial" ? "Grok Adversarial Review" : "Grok Review";
  job.summary = summary;
  job.status = "running";
  job.phase = "running";
  upsertJob(context.repoRoot, job);
  appendLogLine(job.logFile, `Starting ${job.title} on ${target.label}`);

  const result = runGrokPrompt(context.repoRoot, {
    prompt,
    model: options.model,
    readOnly: true,
    alwaysApprove: true,
    maxTurns: options.maxTurns ?? 50
  });

  const finished = finishJob(context.repoRoot, job, {
    status: result.status === 0 ? "completed" : "failed",
    phase: "done",
    exitCode: result.status,
    output: result.stdout,
    stderr: result.stderr,
    pid: null
  });
  appendLogLine(job.logFile, `Finished with exit ${result.status}`);
  if (result.stderr) {
    appendLogLine(job.logFile, result.stderr);
  }

  return {
    job: finished,
    target,
    result,
    rendered: renderReview(finished, target, result)
  };
}

function renderReview(job, target, result) {
  const body = result.stdout?.trim() || result.stderr?.trim() || "(no output)";
  return [
    `# ${job.title}`,
    `Job: ${job.id}`,
    `Target: ${target.label}`,
    `Status: ${job.status}`,
    "",
    body,
    ""
  ].join("\n");
}

function runRescue(cwd, options) {
  ensureGrok(cwd);
  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("Provide a rescue prompt.");
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job =
    options.existingJob ??
    createJob({
      cwd,
      kind: "rescue",
      title: "Grok Rescue",
      summary: prompt.slice(0, 120)
    });
  job.summary = prompt.slice(0, 120);
  job.status = "running";
  job.phase = "running";
  upsertJob(workspaceRoot, job);
  appendLogLine(job.logFile, `Starting rescue: ${prompt.slice(0, 200)}`);

  const result = runGrokPrompt(workspaceRoot, {
    prompt,
    model: options.model,
    effort: options.effort,
    write: Boolean(options.write),
    alwaysApprove: true,
    maxTurns: options.maxTurns ?? 80
  });

  const finished = finishJob(workspaceRoot, job, {
    status: result.status === 0 ? "completed" : "failed",
    phase: "done",
    exitCode: result.status,
    output: result.stdout,
    stderr: result.stderr,
    pid: null
  });

  return {
    job: finished,
    result,
    rendered: [
      `# Grok Rescue`,
      `Job: ${finished.id}`,
      `Status: ${finished.status}`,
      `Write: ${options.write ? "yes" : "read-only/default"}`,
      "",
      result.stdout?.trim() || result.stderr?.trim() || "(no output)",
      ""
    ].join("\n")
  };
}

function spawnBackgroundWorker(cwd, command, jobId, extraArgs = []) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");
  const child = spawn(
    process.execPath,
    [scriptPath, "worker", "--command", command, "--job-id", jobId, "--cwd", cwd, ...extraArgs],
    {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child;
}

function enqueueBackground(cwd, kind, payload) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = {
    id: generateJobId(kind === "rescue" ? "task" : "review"),
    kind,
    title:
      kind === "rescue"
        ? "Grok Rescue"
        : kind === "adversarial"
          ? "Grok Adversarial Review"
          : "Grok Review",
    summary: payload.summary,
    status: "queued",
    phase: "queued",
    workspaceRoot,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    pid: null,
    logFile: null,
    exitCode: null,
    output: null,
    stderr: null,
    request: payload
  };
  job.logFile = createJobLogFile(workspaceRoot, job.id);
  upsertJob(workspaceRoot, job);
  appendLogLine(job.logFile, "Queued for background execution.");
  const child = spawnBackgroundWorker(cwd, kind, job.id);
  job.pid = child.pid ?? null;
  job.status = "running";
  job.phase = "running";
  job.updatedAt = nowIso();
  upsertJob(workspaceRoot, job);
  return job;
}

async function handleWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["command", "job-id", "cwd"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readJobFile(workspaceRoot, options["job-id"]);
  if (!job) {
    throw new Error(`Unknown job ${options["job-id"]}`);
  }
  job.status = "running";
  job.phase = "running";
  job.pid = process.pid;
  job.updatedAt = nowIso();
  upsertJob(workspaceRoot, job);

  try {
    const request = job.request ?? {};
    if (options.command === "rescue") {
      runRescue(cwd, {
        prompt: request.prompt,
        model: request.model,
        effort: request.effort,
        write: request.write,
        existingJob: job
      });
    } else {
      runReview(cwd, {
        base: request.base,
        scope: request.scope,
        model: request.model,
        focusText: request.focusText,
        adversarial: options.command === "adversarial" || request.adversarial,
        existingJob: job
      });
    }
  } catch (error) {
    finishJob(workspaceRoot, job, {
      status: "failed",
      phase: "error",
      exitCode: 1,
      output: null,
      stderr: error instanceof Error ? error.message : String(error),
      pid: null
    });
    throw error;
  }
}

function resolveJob(cwd, jobId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  if (jobId) {
    const full = readJobFile(workspaceRoot, jobId) ?? jobs.find((j) => j.id === jobId);
    if (!full) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return readJobFile(workspaceRoot, full.id) ?? full;
  }
  if (!jobs.length) {
    throw new Error("No Grok jobs found for this repository.");
  }
  return readJobFile(workspaceRoot, jobs[0].id) ?? jobs[0];
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json", "all"]
  });
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (positionals[0]) {
    const job = resolveJob(cwd, positionals[0]);
    const payload = { job };
    outputResult(options.json ? payload : renderJobStatus(job), options.json);
    return;
  }
  const jobs = listJobs(workspaceRoot);
  const payload = { jobs, stateDir: resolveStateDir(cwd) };
  if (options.json) {
    outputResult(payload, true);
    return;
  }
  if (!jobs.length) {
    console.log("No Grok jobs yet for this repository.\n");
    return;
  }
  const lines = ["Grok jobs (newest first):"];
  for (const job of jobs.slice(0, options.all ? 50 : 10)) {
    lines.push(`  ${job.id}  ${job.status.padEnd(10)}  ${job.title}  — ${job.summary ?? ""}`);
  }
  console.log(`${lines.join("\n")}\n`);
}

function renderJobStatus(job) {
  return [
    `Job ${job.id}`,
    `  title:  ${job.title}`,
    `  status: ${job.status}`,
    `  phase:  ${job.phase ?? "-"}`,
    `  summary:${job.summary ?? ""}`,
    `  created:${job.createdAt}`,
    `  updated:${job.updatedAt}`,
    job.finishedAt ? `  finished:${job.finishedAt}` : null,
    job.logFile ? `  log:    ${job.logFile}` : null,
    ""
  ]
    .filter(Boolean)
    .join("\n");
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const job = resolveJob(process.cwd(), positionals[0]);
  if (job.status === "running" || job.status === "queued") {
    const msg = `Job ${job.id} is still ${job.status}. Use /grok:status ${job.id}.`;
    if (options.json) {
      outputResult({ job, pending: true }, true);
    } else {
      console.log(msg);
    }
    return;
  }
  const payload = {
    jobId: job.id,
    status: job.status,
    title: job.title,
    output: job.output,
    stderr: job.stderr,
    exitCode: job.exitCode
  };
  if (options.json) {
    outputResult(payload, true);
    return;
  }
  console.log(
    [
      `# ${job.title} (${job.id})`,
      `Status: ${job.status}`,
      "",
      job.output?.trim() || job.stderr?.trim() || "(no stored output)",
      ""
    ].join("\n")
  );
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = resolveJob(cwd, positionals[0]);
  if (job.status !== "running" && job.status !== "queued") {
    const msg = `Job ${job.id} is not active (status=${job.status}).`;
    outputResult(options.json ? { job, cancelled: false, msg } : `${msg}\n`, options.json);
    return;
  }
  if (job.pid) {
    terminateProcessTree(job.pid);
  }
  const finished = finishJob(workspaceRoot, job, {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    exitCode: null
  });
  outputResult(
    options.json ? { job: finished, cancelled: true } : `Cancelled ${finished.id}.\n`,
    options.json
  );
}

async function handleReviewCommand(argv, adversarial) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const focusText = positionals.join(" ").trim();

  if (options.background) {
    const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
    const job = enqueueBackground(cwd, adversarial ? "adversarial" : "review", {
      base: options.base,
      scope: options.scope,
      model: options.model,
      focusText,
      adversarial,
      summary: `${target.label}${focusText ? ` — ${focusText.slice(0, 60)}` : ""}`
    });
    const payload = {
      jobId: job.id,
      status: job.status,
      title: job.title
    };
    outputResult(
      options.json
        ? payload
        : `${job.title} started in background as ${job.id}. Check /grok:status ${job.id}.\n`,
      options.json
    );
    return;
  }

  const outcome = runReview(cwd, {
    base: options.base,
    scope: options.scope,
    model: options.model,
    focusText,
    adversarial
  });
  outputResult(options.json ? { job: outcome.job, target: outcome.target, stdout: outcome.result.stdout } : outcome.rendered, options.json);
  if (outcome.result.status !== 0) {
    process.exitCode = outcome.result.status;
  }
}

async function handleRescue(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "background", "write"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let prompt = positionals.join(" ").trim();
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  if (!prompt) {
    throw new Error("Provide a rescue prompt.");
  }

  if (options.background) {
    const job = enqueueBackground(cwd, "rescue", {
      prompt,
      model: options.model,
      effort: options.effort,
      write: Boolean(options.write),
      summary: prompt.slice(0, 100)
    });
    outputResult(
      options.json
        ? { jobId: job.id, status: job.status }
        : `Grok rescue started in background as ${job.id}. Check /grok:status ${job.id}.\n`,
      options.json
    );
    return;
  }

  const outcome = runRescue(cwd, {
    prompt,
    model: options.model,
    effort: options.effort,
    write: Boolean(options.write)
  });
  outputResult(
    options.json ? { job: outcome.job, stdout: outcome.result.stdout } : outcome.rendered,
    options.json
  );
  if (outcome.result.status !== 0) {
    process.exitCode = outcome.result.status;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case "setup":
        await handleSetup(rest);
        break;
      case "review":
        await handleReviewCommand(rest, false);
        break;
      case "adversarial-review":
        await handleReviewCommand(rest, true);
        break;
      case "rescue":
      case "task":
        await handleRescue(rest);
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

await main();
