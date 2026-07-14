#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { READONLY_DISALLOWED_TOOLS, runDeliberation } from "./lib/deliberate.mjs";
import { councilPluginRoot, findClaudeBinary, findGrokBinary, probeBackends } from "./lib/discover.mjs";
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
import { colorize, formatDashboard, formatDashboardMarkdown, pickFreshestWatchSource, readProgressState, renderProgressDashboard, renderRunDashboard, summarizeCouncilExtras, summarizeFindings, summarizeProgress } from "./lib/watch.mjs";
import { makeProgressReporter, mutedFindingsReporter } from "./lib/progress.mjs";
import { formatExit } from "./lib/util.mjs";
import { median } from "./lib/stats.mjs";
import { buildCodebaseModel, renderAuditReport } from "./lib/codebase-model.mjs";
import { activeReviewerCount, runAuditReview } from "./lib/audit-review.mjs";
import { runGroupedReview } from "./lib/audit-grouped-review.mjs";
import { writeAuditDoc } from "./lib/audit-doc.mjs";
import { detectCoverageCmd, detectTestCmd, loadCoverage, runAuditFix } from "./lib/audit-fix.mjs";
import { evaluateResumeGuard, loadFixLoopCheckpoint, runFixLoop } from "./lib/audit-fixloop.mjs";
import { makeFixLoopDeps } from "./lib/audit-fixloop-deps.mjs";
import { parsePause5hOption, parseUsageCeiling } from "./lib/usage-guard.mjs";
import { booleanOptionsFor, fixConfigBooleans, fixConfigValues, negatableFlags, valueOptionsFor } from "./lib/cli-registry.mjs";
import { CONSENT_ENV_VAR, LOCAL_CONSENT_FILE, evaluateAckWrite, formatConsentBanner, resolveConsents, writeConsentAck } from "./lib/consent.mjs";
import { emitAliasNotes } from "./lib/cli-aliases.mjs";
import { route } from "./lib/cli-dispatch.mjs";
import { assertCodeWriteAllowed } from "./lib/cli-mutation.mjs";
import { buildClaudeReviewArgs, makePatchReviewer, patchReviewerReady } from "./lib/audit-patch-reviewer.mjs";
import { detectLogical } from "./lib/audit-logical.mjs";
import { nodesFromGraph } from "./lib/import-graph.mjs";
import { resolveAutonomy } from "./lib/audit-autonomy.mjs";
import { reconcilePendingFixes } from "./lib/ledger.mjs";
import { runEndless } from "./lib/audit-endless.mjs";
import { runSupervised } from "./lib/supervisor.mjs";
import { runAudit } from "./lib/audit-run.mjs";
import { toSarif } from "./lib/audit-sarif.mjs";
import { buildAgentResult, runCodexStructured, runGrokStructured, runStructuredWithRetry, withTempPrompt } from "./lib/agents.mjs";
import { writeJobHtml } from "./lib/html-report.mjs";
import { writeFixReportHtml } from "./lib/fix-report-html.mjs";
import { assembleFixMeta, changedFilesShape } from "./lib/fix-report-meta.mjs";
import { openRouterBackend, runOpenRouterStructured } from "./lib/openrouter-agent.mjs";
import { makeCharTestGate } from "./lib/chartest-wiring.mjs";
import { addWorktree, listWorktrees, removeWorktree } from "./lib/worktree.mjs";
import { runPlanDeliberation } from "./lib/plan-deliberate.mjs";
import { isPlanTestPath, parsePlanSpec, planStepTouched, planSpecDigest, renderPlanMarkdown, validatePlanSpec } from "./lib/plan-spec.mjs";
import { makeBuildGit, makeStepPorts, renderBuildReport, runBuild } from "./lib/build.mjs";
import { buildReviewerReady, makeBuildStepReviewer } from "./lib/build-step-reviewer.mjs";
import { activeSeatNames, makeSeatRunners, seatActive } from "./lib/seats.mjs";
import { runStructureTransform } from "./lib/structure-wiring.mjs";
import { snapshotViolation } from "./lib/audit-snapshot.mjs";
import { buildPoisonedSource, changedLinesCovered } from "./lib/chartest-node-harness.mjs";
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
      "Usage: node scripts/council-companion.mjs <verb> [flags]",
      "",
      "The 7 verbs (READ-only never touch tracked source/git; WRITE verbs are test-gated on an isolated branch, never auto-merged):",
      "  review   [RO]  multi-model review — --mode quick|deliberate|adversarial|deep|endless|run  (NEVER writes)",
      "  fix      [W]   the findings→fixes writer — review→fix→re-review loop from the `fix:` config",
      "  plan     [RO]  multi-model design deliberation → a validated PlanSpec",
      "  build    [W]   autonomous test-gated build of a PlanSpec",
      "  solve    [RO]  independent solutions → scored cross-critique → ranking",
      "  status   [RO]  --result|--watch|--wait|--cancel|--fixloop|--overview|--history|--metrics|--usage|--ledger (one action)",
      "  setup    [RO/state]  tool config + diagnose — default | --check (doctor) | --usage",
      "",
      "Aliases (old names still work; each maps to a verb above):",
      "  deliberate|deliberation|adversarial|adversarial-review → review --mode …   |   audit review|run|endless → review --mode deep|run|endless",
      "  audit fix → fix   |   watch|wait|result|cancel|history|metrics|usage|ledger|overview|fixloop-status → status --…   |   doctor → setup --check",
      "",
      "Details:",
      "  node scripts/council-companion.mjs setup [--json]",
      "  node scripts/council-companion.mjs review [--mode quick|deliberate|adversarial] [flags] [focus text]",
      "      e.g.  review --mode quick        parallel Codex + Grok, single round (the CLI default)",
      "      e.g.  review --mode deliberate   R1 independent -> R2 peer critique (+ optional Claude file)",
      "      e.g.  review --mode adversarial  same as quick, adversarial framing",
      "      legacy aliases (still work): `adversarial` = review --mode adversarial; `deliberate` = review --mode deliberate",
      "  node scripts/council-companion.mjs solve [flags] [problem text]",
      "  node scripts/council-companion.mjs wait [job-id] [--follow] [--timeout <s>] [--interval <s>]",
      "  node scripts/council-companion.mjs watch [job-id] [--interval <s>] [--once] [--json]",
      "  node scripts/council-companion.mjs plan <feature-request> [--synthesizer <seat>] [--json]   (multi-model design deliberation → a validated PlanSpec; READ-ONLY)",
      "  node scripts/council-companion.mjs build --from <plan.json> [--dry-run] [--json]   (autonomous test-gated build of a PlanSpec on an isolated branch; never auto-merged)",
      "  node scripts/council-companion.mjs audit run|review|fix|endless [flags] (see below)",
      "    audit review [--groups fine|tier|lens] [--max-cells <n>] [--completeness-critic] [--areas a,b] [--churn-days <n>] [--budget <n>] [--max-units <n>] [--doc] [--write-map] [--json]",
      "      --budget : ADVANCED/LEGACY agent-call cap — most runs never need it; steer cost with --deep (analysis scope) + --usage-ceiling / --pause-at-5h (quota) instead.",
      "    audit run [--sarif [--sarif-path <p>]] [--base <ref>] [--doc] [--json]   (self-driving audit → risk register + gate)",
      "    audit fix [--from <json>] [--autonomy <lvl>] [--min-severity P0|P1|P2] [--max-fixes <n>] [--sensitive-auto-apply] [--structure-auto-apply] [--acknowledge-consents] [--skip-openrouter] [--html] [--retry-on-limit] [--dry-run]",
      "    audit fix --loop [--deep] [--supervise] [--flat] [--max-passes <n>] [--dry-streak <n>] [--resume] [--usage-ceiling [pct]] [--pause-at-5h off|<pct>|auto[:<pct>]]   (autonomous fix-until-dry on an isolated branch)",
      "      CONFIG-FIRST: a `fix:` block in .council.yml supplies the run-behavior DEFAULTS (loop/deep/epoch_sweep/per_tier/supervise/autonomy/usage_ceiling/pause_at_5h/max_passes/budget), so a bare `audit fix` runs your configured autonomous profile. Flags are OVERRIDE-ONLY: an explicit flag > fix.<key> > built-in default. Turn a config-true OFF for one run with --no-<flag> (e.g. --no-deep, --no-structure-auto-apply). Run /council:setup --init to see a commented example.",
      "      CONSENTS (auto-apply) are NOT config-sourced: a tracked .council.yml fix.structure_auto_apply/sensitive_auto_apply is IGNORED + warned (it would spread to clones). Enable auto-apply ONLY via (a) an explicit --structure-auto-apply/--sensitive-auto-apply flag (per-invocation, no persistence), (b) a gitignored .council.local.yml (consents + trust_fingerprint matching this repo's git origin) acknowledged once per clone with `fix --acknowledge-consents`, or (c) COUNCIL_TRUST_FIX + that same per-clone ack. No channel + no flag ⇒ propose-only.",
      "      --deep : ONE flag for max analysis depth — grouped six-eyes over the full lens partition (incl. SSOT/architecture), completeness critic, char-test gate, budget auto-sized to a full sweep. Auto-apply stays explicit (--structure-auto-apply/--sensitive-auto-apply, or a gitignored+acknowledged .council.local.yml / COUNCIL_TRUST_FIX — never the tracked config).",
      "      --usage-ceiling : WEEKLY hard stop on a confirmed per-model quota breach (default 40/50/40). --pause-at-5h : SOFT pause on the 5h window, ON BY DEFAULT at 85% (a plain run pauses safely with a manual-resume contract; `off` disables, `<pct>` retunes, `auto` waits in-process to the reset then resumes itself).",
      "    audit endless [--supervise] [--max-passes <n>] [--dry-streak <n>] [--resume] [--groups fine|tier|lens] [--max-cells <n>] [--usage-ceiling [pct]] [--pause-at-5h off|<pct>|auto[:<pct>]]   (bounded review/propose loop)",
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
      "  --mode quick|deliberate|adversarial  (canonical review-mode selector; the alias verbs are legacy sugar)",
      "  --background  --base <ref>  --scope auto|working-tree|branch",
      "  --codex-model <id>  --grok-model <id>  --codex-effort <l>  --grok-effort <l>",
      "  --skip-codex  --skip-grok  --claude-findings <path>  --claude-findings-wait <path>",
      "  --wait-timeout <seconds>  --peer-severities P0,P1  --debate-rounds 0|1|2  --debate-resume",
      "  --budget-guard <percent>  --force-budget  --json",
      "  solve only: --problem-file <path>  --claude-plan <path>  --claude-plan-wait <path>",
      "",
      "Modes (review --mode <x>):",
      "  quick        - parallel Codex + Grok review (single round) [default]",
      "  adversarial  - same, adversarial framing",
      "  deliberate   - Round1 independent -> Round2 peer critique (+ optional Claude file)",
      "  solve        - separate verb: independent solution plans -> cross-critique with scores -> ranking",
      "",
      "Policy file (repo root): .council.yml | .council.json",
      "Models default from policy or ~/.codex/config.toml + ~/.grok/config.toml"
    ].join("\n")
  );
}

// The reporter of the run currently in flight (each CLI process runs exactly one command), so a
// throw that escapes a handler can still be marked terminal — otherwise progress.json stays
// done:false forever and `council watch` hangs on a dead run. A handler that finishes normally has
// already called reporter.done(), so the flush below is an idempotent no-op on the success path.
let __activeRunReporter = null;

/**
 * If the in-flight run's reporter never reached a terminal state (its handler threw before calling
 * done()), mark it aborted so watchers stop. Best-effort + idempotent: a run that already finished
 * (snapshot().done) is left untouched. NEVER throws — telemetry must not perturb the exit path.
 */
function flushActiveRunReporter() {
  const reporter = __activeRunReporter;
  __activeRunReporter = null;
  if (!reporter) return;
  try {
    if (!reporter.snapshot()?.done) reporter.done({ ok: false, stopReason: "aborted" });
  } catch {
    /* fail-soft: a telemetry flush must never change the outcome or exit code */
  }
}

/**
 * Whether an endless review run finished cleanly. It is ok unless it stopped on an error / did-not-run
 * / failed reason (a review-error stopReason must not report the dashboard green). Mirrors how plan/build
 * derive `ok` from the outcome rather than hardcoding true. Pure + exported for unit tests.
 */
export function endlessRunOk(stopReason) {
  return !/error|did not run|failed/i.test(String(stopReason ?? ""));
}

/**
 * One progress reporter per long-running command, writing the current-run `progress.json` slot in
 * this workspace's state dir (the universal live-dashboard contract read by `council watch`). In a
 * non-json run it forwards every line to stderr byte-identically to the old inline `onProgress` AND
 * persists it; in a --json run the sink is silent but progress.json is STILL written (a JSON/file
 * consumer can watch it). Best-effort: the reporter is fail-soft, so a plain call never affects the
 * command's outcome. Non-json runs also print a one-line pointer to the live dashboard.
 */
function makeRunReporter(cwd, { kind, title, jobId = null, json = false }) {
  const stateDir = resolveStateDir(cwd);
  const reporter = makeProgressReporter({
    kind,
    title,
    jobId,
    stateDir,
    logSink: json ? () => {} : (m) => console.error(m)
  });
  if (!json) {
    console.error(`  ▶ live dashboard: council watch${jobId ? ` ${jobId}` : ""}  (add --md for a chat snapshot)`);
  }
  __activeRunReporter = reporter; // register so a thrown handler still marks the run terminal (see main())
  return reporter;
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
      config_version: policy.config_version,
      default_mode: policy.default_mode,
      codex_model: policy.codex_model,
      grok_model: policy.grok_model,
      claude_backend: claudeBackend,
      claude_model: policy.claude_model,
      focus: policy.focus,
      agent_timeout_minutes: policy.agent_timeout_minutes,
      // Unknown-key warnings for the per-verb config blocks (loadPolicy already printed them to stderr
      // during this load; surfaced here too so --json consumers and the human text see them).
      warnings: policy._warnings ?? []
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
    ...(policy._warnings ?? []).map((w) => `  config: ${w}`),
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
    "",
    "# Run-behavior DEFAULTS for `audit fix` (flag-reduction). With this block a BARE `audit fix`",
    "# runs your configured profile; every CLI flag is override-only (explicit flag > fix.<key> >",
    "# built-in default). Turn a config-true off for one run with --no-<flag> (e.g. --no-deep).",
    "# NOTE (Appendix D): the auto-apply CONSENTS (structure_auto_apply / sensitive_auto_apply) are",
    "# DELIBERATELY NOT placed here — a consent in this TRACKED file spreads to every clone/fork/",
    "# PR-checkout and would let a bare `fix` auto-apply WRITES with no consent from that operator.",
    "# Put consents ONLY in a gitignored .council.local.yml (or env COUNCIL_TRUST_FIX), fingerprint-",
    "# bound, then run `fix --acknowledge-consents` once per clone. See docs/cli-surface-design.md.",
    "# Uncomment to enable the (non-consent) run-behavior profile:",
    "# fix:",
    "#   loop: true",
    "#   deep: true",
    "#   epoch_sweep: true",
    "#   per_tier: true                 # friendly inverse of `flat` (per-tier convergence is the default)",
    "#   supervise: true",
    "#   autonomy: aggressive",
    "#   retry_on_limit: true",
    "#   usage_ceiling: 90/90/90",
    "#   pause_at_5h: auto:90",
    "#   max_passes: 100",
    "#   budget: 2000",
    "",
    "# --- Auto-apply consents live OUT OF TREE (Appendix D) -------------------------------------",
    "# Create a gitignored `.council.local.yml` (NOT this file) in the repo root:",
    "#   fix:",
    "#     structure_auto_apply: true   # may apply multi-file structural transforms",
    "#     sensitive_auto_apply: true   # may apply §6-gated security/sensitive fixes",
    "#   trust_fingerprint: <hash>      # must match this repo's git origin (see `fix --acknowledge-consents`)",
    "# then run `/council:fix --acknowledge-consents` ONCE in this clone to enable them. A fresh clone",
    "# (no .council.local.yml, no ack) stays propose-only — the safe default.",
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
    // Phase 2: live-dashboard reporter for the deliberation (phase per R1/R2/verify/debate milestone,
    // threaded ALONGSIDE the existing job phase reporter — see runDeliberation's onPhase wrapper).
    const reporter = makeRunReporter(cwd, { kind: "deliberate", title: "council deliberate", jobId: job.id, json: Boolean(options.json) });
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
      reporter,
      onPhase: makePhaseReporter(root, job)
    });
    const r1Failed = deliberation.r1.some((r) => !r.skipped && r.status !== 0);
    const allSkipped = deliberation.r1.every((r) => r.skipped && r.agent !== "claude");
    reporter.done({ ok: !allSkipped });
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

// The three review modes the single `review` surface exposes. `solve` is a SEPARATE protocol (its own
// verb), not a review mode. These strings are the CLI surface only — the persisted job.kind stays
// review|deliberate|adversarial (see the `kind` derivation in handleReview), so watch/history/metrics
// on disk are unaffected.
export const REVIEW_MODES = ["quick", "deliberate", "adversarial"];

// Flags that only affect the deliberate protocol. Passing them under quick/adversarial is silently
// ineffective today, so handleReview warns once. Value/boolean both land in `options` (a value flag
// as a string, a boolean flag as `true`); an absent flag is `undefined`, so `!= null` selects exactly
// the ones the user actually passed. Keyed on the raw CLI flag names as they appear in `options`.
export const DELIBERATE_ONLY_FLAGS = [
  "debate-rounds",
  "debate-resume",
  "claude-findings",
  "claude-findings-wait",
  "resume",
  "budget-guard"
];

/**
 * Resolve the single effective review mode from the verb-alias params and an optional `--mode`.
 * Pure + exported for unit tests. Precedence:
 *   1. the verb alias encoded by the dispatch params (a `deliberate`/`adversarial` dispatch, or a
 *      skill passing them) — highest. A bare `review` verb encodes NO alias (both params false), so
 *      `--mode` selects freely there.
 *   2. an explicit `--mode quick|deliberate|adversarial`.
 * An explicit `--mode` that DISAGREES with the verb alias is a conflict and throws BEFORE any job is
 * created; an equivalent/duplicate selector (e.g. `deliberate --mode deliberate`) is fine. Returns
 * the resolved `mode` plus the `adversarial`/`deliberate` booleans the rest of handleReview consumes.
 * Byte-identical defaults: no `--mode` + no alias ⇒ "quick"; the deliberate/adversarial verbs keep
 * resolving to their own mode.
 */
export function resolveReviewMode({ adversarial = false, deliberate = false, modeOption = null } = {}) {
  const aliasMode = deliberate ? "deliberate" : adversarial ? "adversarial" : null;

  let requested = null;
  if (modeOption != null) {
    requested = String(modeOption).trim().toLowerCase();
    if (!REVIEW_MODES.includes(requested)) {
      throw new Error(`Invalid --mode "${modeOption}". Expected one of: ${REVIEW_MODES.join(", ")}.`);
    }
  }

  if (aliasMode && requested && requested !== aliasMode) {
    throw new Error(
      `Conflicting review mode: the "${aliasMode}" verb (legacy alias for review --mode ${aliasMode}) ` +
        `cannot be combined with --mode ${requested}. Use a single selector, e.g. "review --mode ${requested}".`
    );
  }

  const mode = aliasMode ?? requested ?? "quick";
  return { mode, adversarial: mode === "adversarial", deliberate: mode === "deliberate" };
}

/**
 * The deliberate-only flags the user passed while NOT in deliberate mode (they would be silently
 * ignored). Pure + exported for unit tests. Empty in deliberate mode.
 */
export function incompatibleReviewFlags(mode, options = {}) {
  if (mode === "deliberate") return [];
  return DELIBERATE_ONLY_FLAGS.filter((flag) => options[flag] != null);
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
      "mode",
      "cwd"
    ],
    // "wait" is accepted (but unused) for backward compatibility with docs/slash-commands that mention
    // --wait as the (default) opposite of --background - omitting --background already waits
    // synchronously, so it is intentionally a no-op rather than an unknown-flag error (council
    // companion-cli nit).
    booleanOptions: ["json", "background", "wait", "skip-codex", "skip-grok", "skip-claude", "debate-resume", "force-budget", "resume", "verify"]
  });

  // Consolidate the verb aliases + the canonical `--mode` into a single effective mode BEFORE any job
  // is created. The verb-alias params (a deliberate/adversarial dispatch, or the /council:review skill
  // passing them) stay highest precedence; a disagreeing `--mode` is rejected here. `solve` is its own
  // protocol, not a review mode, so `--mode` does not apply to it. Reassigning the adversarial/deliberate
  // params flows the resolved mode into the request, the budget guard, and the persisted `kind` below.
  let mode;
  if (solve) {
    if (options.mode != null) {
      throw new Error(`solve does not support --mode (solve is its own mode); drop --mode ${String(options.mode)}.`);
    }
    mode = "solve";
  } else {
    const resolved = resolveReviewMode({ adversarial, deliberate, modeOption: options.mode });
    mode = resolved.mode;
    adversarial = resolved.adversarial;
    deliberate = resolved.deliberate;
    const incompatible = incompatibleReviewFlags(mode, options);
    if (incompatible.length) {
      console.error(
        `Note: ${incompatible.map((flag) => `--${flag}`).join(", ")} only apply to --mode deliberate; ` +
          `ignored under --mode ${mode}.`
      );
    }
  }

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

  // Stage 4 (Appendix D) consent audit: print the RESOLVED auto-apply policy + WARN on the three
  // misconfigurations that make a bare `fix` unsafe or silently different — a tracked-config consent
  // (ignored but present), a `.council.local.yml` whose fingerprint mismatches this repo, or a
  // world-writable policy file. These are advisory warnings; they do not flip the ping-based readiness.
  const consentRoot = workspaceRoot(cwd);
  const consentResolution = resolveConsents({ cwd: consentRoot, options: {}, stateDir: resolveStateDir(cwd), deps: {} });
  const effectivePolicyLine = formatConsentBanner(consentResolution, { verb: "fix" });
  const consentWarnings = [];
  // The tracked-config-consent warning (from loadPolicy) + EVERY consent-resolution warning — the
  // commonest misconfig is the missing-ack case, so surface it too (do NOT filter by /trust_fingerprint/).
  for (const w of policy._warnings ?? []) if (/IGNORED for consent/.test(w)) consentWarnings.push(w);
  for (const w of consentResolution.warnings) consentWarnings.push(w);
  // World-writable policy files (POSIX only; Windows ACLs are not mode bits). Cover BOTH the tracked
  // .council.yml AND the gitignored .council.local.yml — a writable consent file is the stricter risk.
  if (process.platform !== "win32") {
    for (const f of [policy._source, path.join(consentRoot, LOCAL_CONSENT_FILE)]) {
      if (!f) continue;
      try {
        const mode = fs.statSync(f).mode;
        if (mode & 0o002) consentWarnings.push(`Warning: ${f} is WORLD-WRITABLE (mode ${(mode & 0o777).toString(8)}) — any local user could inject run-behavior/consents. chmod go-w it.`);
      } catch { /* absent / stat failure is non-fatal */ }
    }
  }

  const ready = checks.every((c) => c.ok);
  if (options.json) {
    outputResult({ ready, checks, stateDir: resolveStateDir(cwd), effectivePolicy: effectivePolicyLine, consentWarnings }, true);
    return;
  }
  const lines = [`Council doctor: ${ready ? "ALL OK" : "PROBLEMS FOUND"}`];
  for (const c of checks) {
    lines.push(`  [${c.ok ? "ok" : "!!"}] ${c.name.padEnd(20)} ${c.detail ?? ""}`);
  }
  lines.push(`  ${effectivePolicyLine}`);
  for (const w of consentWarnings) lines.push(`  [!!] ${w}`);
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
  const requestedId = positionals[0];
  let job = requestedId ? readJobFile(root, requestedId) : null;
  if (requestedId && !job) throw new Error(`Job not found: ${requestedId}`);

  // Phase 2: with no explicit job requested, watch the FRESHEST source. Every long-running command
  // now writes a universal progress.json; a stale legacy job must not shadow a live run.
  if (!requestedId) {
    const prog = readProgressState(resolveStateDir(cwd));
    const latestId = listJobs(root)[0]?.id;
    job = latestId ? readJobFile(root, latestId) : null;
    if (pickFreshestWatchSource(prog, job).kind === "progress") {
      await watchProgress(cwd, prog, options);
      return;
    }
  }
  if (!job) throw new Error("No council jobs found.");
  const jobId = job.id;
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

/**
 * Watch the universal progress.json (Phase 2) — the fallback path for `council watch` when there is
 * no legacy job. Mirrors handleWatch's json / --md / --once / TTY-loop shape, but renders the
 * kind-agnostic dashboard (renderProgressDashboard, TOTAL/never-throws) and re-reads the file each
 * interval, terminating on `prog.done`. `initial` is the state that was present when the fallback
 * fired; a subsequent read failure falls back to it rather than blanking the screen.
 */
async function watchProgress(cwd, initial, options) {
  const stateDir = resolveStateDir(cwd);
  const reread = () => readProgressState(stateDir) ?? initial;
  // Phase 2 + usage guard: when the run stashed a per-model usage snapshot (a `--usage-ceiling`
  // fix loop), render the RICH quota/token/ceiling markdown box (renderRunDashboard); otherwise the
  // plain kind-agnostic dashboard, byte-identical to before. renderRunDashboard is markdown-only, so
  // it also serves the live redraw here (paint() still adds harmless ANSI accents).
  const renderUniversal = (state, md) => {
    const usage = state && typeof state === "object" && state.usage && typeof state.usage === "object" ? state.usage : null;
    return usage
      ? renderRunDashboard(state, { usage, ceiling: state.usageCeiling ?? null, nowMs: Date.now() })
      : renderProgressDashboard(state, { md, nowMs: Date.now() });
  };

  if (options.json) {
    const prog = reread();
    outputResult({ kind: prog?.kind ?? null, done: Boolean(prog?.done), dashboard: renderUniversal(prog, false) }, true);
    return;
  }
  if (options.md) {
    console.log(renderUniversal(reread(), true));
    return;
  }
  const paint = (s) => (process.stdout.isTTY ? colorize(s) : s);
  // Single snapshot for --once or non-TTY stdout (no live redraw).
  if (options.once || !process.stdout.isTTY) {
    const prog = reread();
    console.log(paint(renderUniversal(prog, false)));
    if (!prog?.done) console.log("\n(snapshot; re-run or use a TTY for a live view)");
    return;
  }
  const intervalMs = secondsToMs(options.interval, "--interval") ?? 2000;
  const timeoutMs = secondsToMs(options.timeout, "--timeout") ?? 3_600_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const prog = reread();
    process.stdout.write(`\x1b[2J\x1b[H${paint(renderUniversal(prog, false))}\n`);
    if (prog?.done) return;
    if (Date.now() >= deadline) {
      console.log(`\nwatch timed out after ${Math.round(timeoutMs / 1000)}s (progress still running).`);
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
// A — the LOOP grouped path uses a SMALL per-pass cell cap by default (not the one-shot 1500) so a
// `audit fix --loop --deep` cycles review→fix roughly every ~20 min instead of burning one ~1500-cell
// (~15h) pass before the first fix / quota check / persisted finding. Coverage stays complete via the
// progressive unitOffset window + blast-radius re-scope across passes; the GATE + SSOT reduce run over
// the ACCUMULATED findings ledger (audit-findings.jsonl), so small passes bound WORK, not evidence. 40
// cells ≈ a handful of files × the active seats — one focused review→fix cycle. --max-cells overrides.
const LOOP_DEFAULT_MAX_CELLS = 40;

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

/**
 * Build the versioned `council.pause.v1` contract from a finished fix-loop result carrying a `pause`
 * (a --pause-at-5h stop). PURE (no I/O; `observedAt` is injectable) so the exit-75 payload is
 * unit-testable. `argv` is the normalized audit-subcommand token list (what handleAudit received); the
 * emitted resume argv re-invokes the companion with `--resume` appended (idempotent). `state`
 * distinguishes a schedulable pause ("pause_requested") from a manual stop ("manual_stop"); both exit 75.
 */
export function buildResumeArgv(argv) {
  // The resume argv BOTH the machine payload (resume.argv) and the human resume hint reuse: the
  // original audit tokens + --resume (idempotent). Keeping them derived from ONE place is what makes a
  // copied stderr line carry the run's original flags exactly like the JSON contract (grok-hint / F).
  const resumeArgv = ["audit", ...(Array.isArray(argv) ? argv : [])];
  if (!resumeArgv.includes("--resume")) resumeArgv.push("--resume");
  return resumeArgv;
}

export function buildPausePayload(out, { baseBranch = null, cwd = null, argv = [], observedAt } = {}) {
  const pz = (out && out.pause) || {};
  return {
    schemaVersion: 1,
    event: "council.pause.v1",
    state: pz.schedulable ? "pause_requested" : "manual_stop",
    reason: "quota_5h",
    // A THRASH stop (resume→re-pause on the SAME still-full 5h window with no progress) and a plain
    // unschedulable-timestamp stop are BOTH manual_stop; `thrash` distinguishes them for a machine
    // consumer without breaking the v1 schema (additive field, grok-thrash / E).
    thrash: pz.thrash === true,
    runId: out?.branch ?? baseBranch ?? null,
    pauseId: pz.pauseId ?? null,
    pass: out?.passesRun ?? 0,
    checkpoint: { branch: out?.branch ?? null, base: baseBranch },
    blockers: (pz.blockers ?? []).map((b) => ({ model: b.model, usedPercent: b.percent, threshold: b.threshold, resetsAt: b.resetsAt ?? null })),
    observedAt: observedAt ?? nowIso(),
    resumeAt: pz.resumeAt ?? null,
    resume: { cwd, argv: buildResumeArgv(argv) }
  };
}

/**
 * Emit a --pause-at-5h clean stop (a NON-autonomous pause, or an autonomous one whose reset was not
 * schedulable) and set EXIT 75 (EX_TEMPFAIL). Shared by BOTH loops (fix-loop + endless) so the resume
 * CONTRACT never forks: --json prints the machine `council.pause.v1` payload, else a human resume line.
 * `argv` is the raw audit-subcommand argv (buildPausePayload appends --resume); `resumeHint` is the
 * exact human re-run command for THIS subcommand. The caller MUST `return` right after (skip the normal
 * report — a pause is neither a crash nor a completion).
 */
function emitPauseContract(out, { baseBranch = null, cwd = null, argv = [], json = false } = {}) {
  process.exitCode = 75;
  const pz = out.pause ?? {};
  const nArgv = normalizeArgv(argv);
  if (json) {
    outputResult(buildPausePayload(out, { baseBranch, cwd, argv: nArgv }), true);
    return;
  }
  const blockersDesc = (pz.blockers ?? []).map((b) => `${b.model} 5h ${b.percent}%≥${b.threshold}%`).join(", ");
  // The human resume hint reuses the run's ORIGINAL audit argv + --resume (SSOT with the JSON
  // resume.argv via buildResumeArgv), so a copied stderr line keeps --usage-ceiling / --max-passes /
  // etc. instead of the flag-less `audit fix --loop --resume` it printed before (grok-hint / F).
  const self = process.argv[1] ?? "council-companion.mjs";
  // Shell-quote any token containing whitespace so a copied resume line survives paths with spaces
  // (e.g. --doc-path "C:/My Reports/a.md") in PowerShell/sh — the JSON resume.argv keeps token
  // boundaries on its own, this is the human line's equivalent (F).
  const shellQuote = (tok) => (/\s/.test(String(tok)) ? `"${tok}"` : String(tok));
  const resumeHint = `node ${shellQuote(self)} ${buildResumeArgv(nArgv).map(shellQuote).join(" ")}`;
  // A schedulable pause resumes at a known time. An UNSCHEDULABLE one (schedulable:false) is one of two
  // different things and must not be mislabelled: a THRASH stop (resume→re-pause on the SAME still-full
  // 5h window with no new progress) vs a genuinely unschedulable reset timestamp (grok-thrash / E).
  const tail = pz.schedulable
    ? `resume ${pz.resumeAt}; resume with: ${resumeHint}`
    : pz.thrash
      ? `resume manually — the same 5h window is still over threshold with no new progress; resume with: ${resumeHint}`
      : `resume manually — reset time not schedulable; resume with: ${resumeHint}`;
  console.error(`⏸ Paused safely after pass ${out.passesRun ?? 0}: ${blockersDesc}; ${tail}${out.stranded ? ` (note: could not return to ${baseBranch} — a resume will continue on ${out.branch})` : ""}`);
}

/**
 * Finalize a review/fix loop's live telemetry (progress.json), shared by BOTH loops (SSOT). A
 * --pause-at-5h stop is NEITHER a completion NOR a crash — it is SUSPENDED, exiting 75 pending a
 * --resume. Reporting it done+ok (the old order ran reporter.done BEFORE the out.pause branch) made the
 * dashboard show a paused run as finished-green (codex-5). On a pause we stamp a distinct terminal
 * "paused" phase with ok:null (NOT done+ok) so a watcher reads SUSPENDED yet still stops polling;
 * otherwise the run finalizes done with the caller's ok. PURE w.r.t. the reporter (it just forwards).
 */
export function finalizeLoopReporter(reporter, out, { ok = null, stopReason = null } = {}) {
  if (out && out.pause) {
    reporter.done({ ok: null, stopReason: stopReason ?? out.stopReason ?? null, phase: "paused" });
    return;
  }
  reporter.done({ ok, stopReason: stopReason ?? out?.stopReason ?? null });
}

// --- Flag reduction: a `fix:` block in .council.yml supplies DEFAULTS for `audit fix` -----------
// Precedence for EVERY option: explicit CLI flag > policy.fix.<key> > built-in default. parseArgs
// records an absent boolean as `undefined` (present ⇒ true, `--no-<flag>` ⇒ explicit false), so the
// tri-state is captured directly: config fills ONLY the truly-absent (undefined) options.
// Recognized boolean keys (snake_case config → the kebab option key parseArgs stores). DERIVED from the
// flag registry (lib/cli-registry.mjs) — the single source of truth for the CLI surface (Stage 2). The
// registry reproduces these maps byte-identically; see tests/cli-registry.test.mjs for the golden pins.
const FIX_CONFIG_BOOLEANS = fixConfigBooleans();
// The boolean flags that accept a `--no-<flag>` negation (so a config-true can be turned OFF for one
// run). `flat` is here too — its config side is the friendlier `per_tier` (inverse), handled below.
const FIX_NEGATABLE_FLAGS = negatableFlags("audit");
// Value keys (config → kebab option) with the SAME validator the CLI flag uses. `validate` THROWS on
// a bad value; the merge wraps that into a fail-loud "in .council.yml fix.<key>" error. autonomy /
// min_severity match the CLI's lenient handling (unknown → safe fallback), so no validator.
const FIX_CONFIG_VALUES = fixConfigValues();

/**
 * Fold each `--no-<flag>` (parseArgs stored it as options["no-<flag>"] === true) into an EXPLICIT
 * `false` on the base flag, in place, and drop the `no-*` key. This is the tri-state maker: after
 * this, a base boolean is `true` (--flag), `false` (--no-flag), or `undefined` (absent) — so
 * applyFixPolicyDefaults can fill ONLY the truly-absent options without a --no-flag being clobbered.
 */
export function applyNoFlagNegations(options) {
  for (const f of FIX_NEGATABLE_FLAGS) {
    if (options[`no-${f}`] === true) {
      options[f] = false;
      delete options[`no-${f}`];
    }
  }
  return options;
}

/**
 * Merge a `.council.yml` `fix:` map into the parsed CLI `options`, in place, as DEFAULTS ONLY: a
 * value is written ONLY when the user did not pass the corresponding flag (booleans undefined; value
 * options undefined). Explicit flags — and `--no-<flag>` explicit-false — always win. Invalid config
 * values fail LOUD ("Invalid .council.yml fix.<key>: …") instead of being silently ignored. Returns
 * the Set of option keys that were sourced FROM config (so the consent warnings can note the source).
 */
export function applyFixPolicyDefaults(options, policyFix, { emit = () => {} } = {}) {
  const fromConfig = new Set();
  if (!policyFix || typeof policyFix !== "object" || Array.isArray(policyFix)) return fromConfig;

  for (const [cfgKey, optKey] of Object.entries(FIX_CONFIG_BOOLEANS)) {
    if (!(cfgKey in policyFix)) continue;
    if (options[optKey] !== undefined) continue; // explicit --flag / --no-flag wins
    options[optKey] = policyFix[cfgKey] === true;
    if (options[optKey]) fromConfig.add(optKey);
  }

  // flat / per_tier: per_tier is the friendly INVERSE of flat (per-tier is already the default). Only
  // when the user passed neither --flat nor --no-flat (options.flat === undefined). `flat` wins over
  // `per_tier` with a note; else per_tier:true ⇒ flat=false, per_tier:false ⇒ flat=true.
  if (options.flat === undefined) {
    if ("flat" in policyFix) {
      options.flat = policyFix.flat === true;
      if ("per_tier" in policyFix) emit("note: .council.yml fix: has BOTH `flat` and `per_tier` — `flat` wins for this run.");
      if (options.flat) fromConfig.add("flat");
    } else if ("per_tier" in policyFix) {
      options.flat = !(policyFix.per_tier === true);
      if (options.flat) fromConfig.add("flat");
    }
  }

  for (const [cfgKey, spec] of Object.entries(FIX_CONFIG_VALUES)) {
    if (!(cfgKey in policyFix)) continue;
    if (options[spec.opt] !== undefined) continue; // explicit flag wins
    const raw = policyFix[cfgKey];
    if (raw == null || raw === "") continue;
    if (spec.validate) {
      try {
        spec.validate(raw);
      } catch (e) {
        throw new Error(`Invalid .council.yml fix.${cfgKey}: ${e.message}`);
      }
    }
    options[spec.opt] = String(raw);
    fromConfig.add(spec.opt);
  }
  return fromConfig;
}

export async function handleAudit(argv, { verb: dispatchVerb } = {}) {
  // Capture the run-start clock BEFORE any work so --usage-ceiling's token scan (tokens spent SINCE
  // the run began) and the loop's usage snapshots share one honest baseline. Date.now() is allowed
  // in the companion (this is not a workflow script).
  const usageSince = Date.now();
  // --usage-ceiling accepts an OPTIONAL value: `--usage-ceiling` alone means "use the default
  // 40/50/40", `--usage-ceiling 40/50/40` (or `=45` / `=claude=40,codex=50`) overrides it, and an
  // absent flag means no ceiling. --pause-at-5h likewise takes an OPTIONAL value (bare = the default-on
  // 85%). The arg parser errors on a value-option given no value, so rewrite a BARE occurrence of
  // either to an empty inline value up front — the parsers treat "" as the default.
  const preArgv = normalizeArgv(argv).map((tok, i, a) =>
    (tok === "--usage-ceiling" || tok === "--pause-at-5h") && (a[i + 1] == null || String(a[i + 1]).startsWith("-")) ? `${tok}=` : tok
  );
  const { options, positionals } = parseCommandInput(preArgv, {
    // DERIVED from the flag registry (lib/cli-registry.mjs, Stage 2 SSOT). valueOptionsFor / booleanOptionsFor
    // reproduce the previous hand-written arrays byte-for-byte, incl. the `--no-*` twins that negate the
    // config-backed booleans (`--no-deep` beats a `fix: { deep: true }` for one run — registered so parseArgs
    // accepts them; applyNoFlagNegations folds each into an explicit `false` on the base key).
    valueOptions: valueOptionsFor("audit"),
    booleanOptions: booleanOptionsFor("audit")
  });
  // Flag-reduction (`audit fix` only): fold `--no-<flag>` into an EXPLICIT false so a `fix:` config
  // default can't switch it back on for this run (explicit-false wins), then apply the `.council.yml`
  // `fix:` block as DEFAULTS for the options the user did NOT pass. Runs BEFORE the --deep expansion
  // so a config `deep: true` cascades to groups/chartest/budget exactly like the flag would. A repo
  // with no `fix:` block sets nothing here ⇒ option resolution stays byte-identical to before.
  applyNoFlagNegations(options);
  let fixFromConfig = new Set();
  // Stage 4 (Appendix D): the RESOLVED auto-apply consents for the fix run. Computed from the OUT-OF-TREE
  // channel (gitignored .council.local.yml / env COUNCIL_TRUST_FIX) + fingerprint + per-clone ack — never
  // the tracked config. Consumed by the structure/sensitive wiring below.
  let consent = null;
  if (positionals[0] === "fix") {
    // mutationClass boundary (foundation #2) — the EARLIEST fix-detection point. `fix` is the ONE
    // findings→fixes writer; assert the write is allowed BEFORE any fix work (policy load, codebase
    // model, backend probe, and every downstream writer: runAuditFix, runFixLoop, the --resume loop,
    // runStructureTransform). FAIL-CLOSED: an undefined/read-only verb THROWS (no default admits a
    // write). main() always threads the resolved verb; review/plan/solve reroute to the review/run/
    // endless positionals, never "fix", so this fires only on a genuine miswiring or a forged verb.
    assertCodeWriteAllowed(dispatchVerb);
    // Consent containment: resolve from the workspace ROOT (where .council.local.yml lives) + this
    // workspace's STATE dir (where the ack lives). Resolve + print the effective-policy banner FIRST —
    // BEFORE any policy load / ack write / early error — so a recognized fix invocation can NEVER exit
    // without the stderr banner (the silent-behavior-change defense). All git/fs/tracked come from real deps.
    const consentRoot = workspaceRoot(process.cwd());
    const consentStateDir = resolveStateDir(process.cwd());
    consent = resolveConsents({ cwd: consentRoot, options, stateDir: consentStateDir, deps: {} });
    for (const w of consent.warnings) console.error(w); // stderr — safe under --json
    console.error(formatConsentBanner(consent, { verb: "fix" })); // ONE stderr line, EVEN under --json
    // `--acknowledge-consents` is a one-time per-clone enable gesture: it records the ack and exits (the
    // operator re-runs `fix` to apply). It writes ONLY when a valid channel + non-null fingerprint exist
    // NOW (never pre-created to later validate a force-added file), and under --dry-run it prints-only.
    if (options["acknowledge-consents"]) {
      const evalAck = evaluateAckWrite({ cwd: consentRoot, deps: {} });
      if (!evalAck.ok) {
        if (options.json) outputResult({ acknowledged: false, reason: evalAck.reason, stateDir: consentStateDir }, true);
        else console.error(`Cannot record consent acknowledgment: ${evalAck.reason}`);
        return;
      }
      if (options["dry-run"]) {
        const msg = `--dry-run: WOULD record this workspace's consent ack (channel=${evalAck.channel}, fingerprint=${evalAck.fingerprint.slice(0, 12)}…, path=${path.join(consentStateDir, "consent-ack.json")}); wrote nothing.`;
        if (options.json) outputResult({ acknowledged: false, dryRun: true, wouldRecord: { channel: evalAck.channel, fingerprint: evalAck.fingerprint, cwd: consentRoot }, stateDir: consentStateDir }, true);
        else console.error(msg);
        return;
      }
      const rec = writeConsentAck(consentStateDir, { fingerprint: evalAck.fingerprint, cwd: consentRoot });
      if (options.json) {
        outputResult({ acknowledged: true, ...rec, channel: evalAck.channel, stateDir: consentStateDir }, true);
      } else {
        console.error(`Recorded this workspace's auto-apply consent acknowledgment (channel=${evalAck.channel}, fingerprint=${evalAck.fingerprint.slice(0, 12)}…, at ${rec.acknowledgedAt}).`);
        console.error(`Consents in ${LOCAL_CONSENT_FILE} / ${CONSENT_ENV_VAR} now apply in THIS workspace — re-run \`fix\` to use them.`);
      }
      return;
    }
    const _fixPolicy = loadPolicy(process.cwd());
    fixFromConfig = applyFixPolicyDefaults(options, _fixPolicy.fix, {
      emit: (m) => { if (!options.json) console.error(m); }
    });
  }
  // --deep: ONE flag for maximum ANALYSIS depth, so a thorough run needs no long flag list. It turns on
  // the grouped six-eyes review over a FULL lens partition (every lens — incl. SSOT/architecture — gets
  // its own deep pass, so none is starved), the completeness critic, and the char-test gate; and it
  // auto-scales --budget to cover one full sweep (groups × units × 3 seats) so the agent-call budget
  // never runs out before the later lenses. It deliberately does NOT enable any AUTO-APPLY consent
  // (--structure-auto-apply / --sensitive-auto-apply stay explicit) — depth of analysis and permission
  // to mutate are separate decisions. Each piece is only defaulted when not already set, so an explicit
  // --groups fine / --budget still wins.
  if (options.deep) {
    if (options.groups == null) options.groups = "lens";
    options.chartest = true;
    options["completeness-critic"] = true;
    if (options.budget == null) {
      const GROUP_COUNT = { tier: 4, lens: 13, fine: 30 };
      const groupN = GROUP_COUNT[String(options.groups)] ?? 13;
      const maxU = options["max-units"] != null && Number.isFinite(Number(options["max-units"])) ? Math.max(1, Number(options["max-units"])) : 12;
      options.budget = String(groupN * maxU * 3); // one full sweep: every lens group × every hotspot unit × 3 seats
    }
  }
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
    // Phase 2: the live-dashboard reporter for `audit review` (per-file OR grouped). onProgress is
    // reporter.line so today's stderr stays byte-identical (non-json) AND is now persisted.
    const reporter = makeRunReporter(cwd, { kind: "audit-review", title: "audit review", json: options.json });
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
        reporter,
        onProgress: reporter.line
      });
    } else {
      out = await runAuditReview(cwd, model, backends, {
        ...merged,
        budget,
        maxUnits,
        skipCodex: merged.skipCodex,
        skipGrok: merged.skipGrok,
        reporter,
        onProgress: reporter.line
      });
    }
    reporter.done({ ok: true });
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
    // (mutationClass already asserted at the earliest fix-detection point above, before any fix work.)
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

    // M9 structure transform (opt-in --structure-auto-apply, strict === true): the ONE door to the
    // multi-file structure transform (structure-wiring.mjs). Applies to BOTH the single-shot and the
    // --loop path. Without the flag, NOTHING is threaded — the default runAuditFix options/deps stay
    // byte-identical and structural findings remain propose-only proposals, exactly as before.
    // Stage 4: consent is RESOLVED from the out-of-tree channel (never the tracked config) — see the
    // effective-policy banner already printed above. `consent` is always set on the fix path.
    const structureAutoApply = consent ? consent.structureAutoApply : false;
    if (structureAutoApply) {
      console.error(
        "M9 structure auto-apply ENABLED — cross-cutting architecture_ssot/logical_sense findings may be applied AUTONOMOUSLY as MULTI-FILE consolidations. Every transform must clear the full ladder (plan-declared file boundary, full test suite green, public API provably unchanged, UNANIMOUS §6 council over the exact staged multi-file diff) or it is reverted to a proposal."
      );
      console.error(
        "⚠ SECURITY: the transform planner/author and the §6 reviewers run LLM CLIs inside this repository. --structure-auto-apply does NOT imply --sensitive-auto-apply — a structural finding that is ALSO §6-sensitive still needs BOTH consents. Enable --structure-auto-apply ONLY on repositories you trust."
      );
      const src = consent?.sources?.structure;
      if (src === "local" || src === "env") {
        console.error(`  (consent from the gitignored ${LOCAL_CONSENT_FILE}${src === "env" ? ` / ${CONSENT_ENV_VAR}` : ""}, acknowledged for THIS clone — never from the tracked .council.yml)`);
      }
    }
    const structureTransformRunner = structureAutoApply ? makeStructureTransformRunner(workspaceRoot(cwd), cwd, backends, merged) : null;

    // `audit fix --loop` (M3): the autonomous fix-until-dry loop. Reviews -> Tier-0
    // gates -> fixes the localized set on ONE isolated branch -> re-scopes to the blast
    // radius -> repeats until dry/budget/max-passes. Nothing auto-merged.
    if (options.loop) {
      if (options["dry-run"]) throw new Error("--dry-run is not supported with --loop (the loop commits on an isolated branch). Preview a single pass with `audit fix --dry-run`, then run `audit fix --loop`.");

      // Preflight BEFORE paying for a review (the loop must never review-then-hard-stop):
      // require a branch (not detached HEAD), a clean tree, and a test gate.
      const bb = await runCommandAsync("git", ["branch", "--show-current"], { cwd, timeoutMs: 10_000 });
      const baseBranch = bb.status === 0 ? bb.stdout.trim() : "";
      if (!baseBranch) throw new Error("audit fix --loop requires being on a branch (detached HEAD detected) — check out a branch first");
      if (/^council\/audit-fix-/.test(baseBranch) && !options.resume) throw new Error(`you are on an integration branch (${baseBranch}) — check out your base branch first, or pass --resume to continue it`);
      const st = await runCommandAsync("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
      const treeDirty = st.status === 0 && st.stdout.trim() !== "";
      // Resume guard (LOAD-BEARING — never overwrite the user's work): on --resume, FAIL CLOSED if the
      // tree is dirty (the user edited during the pause) or the checkpoint's integration branch no
      // longer exists (fingerprint mismatch). We NEVER stash/reset/clean — we print `resume_blocked:`
      // and exit non-zero, leaving the tree exactly as-is. Runs FIRST — before probing reviewers or the
      // generic clean-tree throw — so a dirty/mismatched resume fails closed as early and cheaply as
      // possible with the explicit resume_blocked contract.
      if (options.resume) {
        const priorCheckpoint = loadFixLoopCheckpoint(cwd);
        let branchExists = true;
        if (priorCheckpoint?.branch) {
          const rp = await runCommandAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${priorCheckpoint.branch}`], { cwd, timeoutMs: 10_000 });
          branchExists = rp.status === 0;
        }
        const guard = evaluateResumeGuard({ checkpoint: priorCheckpoint, dirty: treeDirty, branchExists });
        if (!guard.ok) {
          process.exitCode = 1;
          if (options.json) outputResult({ ok: false, resumeBlocked: true, reason: guard.reason, error: `resume_blocked: ${guard.reason}` }, true);
          else console.error(`resume_blocked: ${guard.reason}`);
          return;
        }
      }
      if (treeDirty) throw new Error("working tree not clean — commit or stash first (the loop's rollback would destroy uncommitted work)");
      if (activeReviewerCount(backends, merged) === 0) throw new Error("no callable reviewers (Codex/Grok unavailable or skipped) — audit fix --loop needs at least one");
      if (!detectTestCmd(workspaceRoot(cwd))) throw new Error("no test command detected — audit fix --loop requires a test gate (audit only auto-fixes tested code)");

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
      // --usage-ceiling: stop the loop between passes on a CONFIRMED per-model provider-quota breach
      // (Claude 5h/7d, Codex weekly, Grok weekly). Present-but-empty ("") means the bare flag → default
      // 40/50/40; absent → undefined → no ceiling. parseUsageCeiling validates + throws fail-fast here.
      const usageCeiling = options["usage-ceiling"] != null ? parseUsageCeiling(options["usage-ceiling"]) : undefined;
      if (usageCeiling && !options.json) {
        console.error(`note: --usage-ceiling active — the loop STOPS between passes on a confirmed quota breach (claude ${usageCeiling.claude}% / codex ${usageCeiling.codex}% / grok ${usageCeiling.grok}%). Unknown/unavailable usage never stops it.`);
      }
      // --pause-at-5h: the SOFT 5h-window pause, a SEPARATE policy from --usage-ceiling (weekly hard
      // stop). ON BY DEFAULT at 85% for the --loop path — an ABSENT flag yields { enabled:true,
      // threshold:85, autonomous:false } so a plain `audit fix --loop` already pauses safely with a
      // manual-resume contract. `--pause-at-5h off` disables; `--pause-at-5h 90` retunes; `--pause-at-5h
      // auto` (or auto:N) makes it AUTONOMOUS (waits in-process to the reset, then resumes itself).
      // parsePause5hOption validates + throws fail-fast here. (Only the loop pauses between passes; the
      // single-shot `audit fix` path never reaches this and is unaffected.)
      const pause5h = parsePause5hOption(options["pause-at-5h"]);
      if (!options.json) {
        if (pause5h.enabled) {
          console.error(`note: --pause-at-5h active — the loop PAUSES between passes when an available model's 5h window is ≥ ${pause5h.threshold}% (${pause5h.autonomous ? "AUTONOMOUS: waits in-process to the reset then resumes itself" : "safe stop with a manual-resume contract, exit 75"}). Disable with --pause-at-5h off. Unknown/unavailable usage never pauses.`);
        } else {
          console.error("note: --pause-at-5h off — the 5h soft-pause safety is DISABLED for this run (the run will not pause when the 5h window fills).");
        }
      }
      // R9: --groups drives the loop off the GROUPED six-eyes review (cell-granular coverage feeds the
      // convergence guard). Validate the preset + cap up front so a bad value fails before any spend.
      let loopLensGroups;
      let loopMaxCells;
      if (options.groups) {
        if (!["fine", "tier", "lens"].includes(String(options.groups))) throw new Error(`--groups must be one of fine|tier|lens (got: ${options.groups})`);
        loopLensGroups = String(options.groups);
        // A: the LOOP defaults to a SMALL per-pass cell cap (not the one-shot 1500) so review→fix cycles
        // frequently and a quota breach is caught within a pass, not after ~15h. --max-cells overrides.
        loopMaxCells = LOOP_DEFAULT_MAX_CELLS;
        if (options["max-cells"] != null) {
          const nc = Number(options["max-cells"]);
          if (!Number.isFinite(nc) || nc < 1) throw new Error("--max-cells must be a positive number");
          loopMaxCells = Math.floor(nc);
        }
        if (!options.json) {
          console.error(`note: the loop reviews up to ${loopMaxCells} cell(s)/pass by default (small passes → frequent review→fix cycles + fast quota response); the GATE + SSOT reduce run over the ACCUMULATED findings ledger across passes, so bounding per-pass work does not fragment cross-file/SSOT issues. Raise --max-cells for bigger passes.`);
        }
      }
      // WAVE 2 (epoch-sweep): opt into the DURABLE, run-wide cell-coverage ledger that drives per-pass
      // scheduling + tier-advance from a sealed manifest denominator instead of the modulo window +
      // passRan heuristic. FAIL CLOSED — it REQUIRES the grouped path (the per-file path has no cell
      // ledger) and per-tier convergence, and REJECTS --flat; never silently fall back to legacy.
      // WAVE3: the coverage guarantee is now proven by the property test (tests/audit-tier-sweep-guarantee.
      // test.mjs), but flipping the DEFAULT ON for `fix --loop --groups --per-tier` runs (the modulo skip
      // hole is a confirmed correctness bug) is a SEPARATE FOLLOW-UP after the first successful LIVE run —
      // the positional-chunking cost caveat (a fix early in a large file re-opens its later chunks) needs a
      // real-repo budget validation before it becomes the default. Wave 3 keeps --epoch-sweep strictly opt-in.
      const epochSweep = options["epoch-sweep"] === true;
      if (epochSweep) {
        if (!loopLensGroups) throw new Error("--epoch-sweep requires --groups (the durable coverage ledger is cell-granular; the per-file path has no cells to track)");
        if (options.flat) throw new Error("--epoch-sweep is incompatible with --flat (the sweep drives per-tier coverage; --flat is a single flat convergence)");
        if (!options.json) {
          console.error("note: --epoch-sweep active — per-pass scheduling + tier-advance are driven by a DURABLE run-wide cell-coverage ledger (audit-tier-sweep-cursor.jsonl in the state dir, never the working tree). Coverage is PROVEN per tier by a sealed manifest denominator; a budget/pass ceiling stops with an explicit COVERAGE INCOMPLETE debt the ledger persists so a same-epoch --resume continues the denominator (it does not restart at zero).");
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
      if (consent && consent.sensitiveAutoApply) {
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
          const src = consent?.sources?.sensitive;
          if (src === "local" || src === "env") {
            console.error(`  (consent from the gitignored ${LOCAL_CONSENT_FILE}${src === "env" ? ` / ${CONSENT_ENV_VAR}` : ""}, acknowledged for THIS clone — never from the tracked .council.yml)`);
          }
        } else {
          // Name the ACTUAL unreachable seats, derived from every per-seat flag ready reports (built-ins
          // AND any configured or-* seat) — not a hardcoded three (council Codex P2). Otherwise an
          // OpenRouter seat being down prints "seats unreachable ()" and misdiagnoses the veto.
          const missing = Object.keys(ready).filter((s) => s !== "ready" && !ready[s]);
          console.error(`⚠ --sensitive-auto-apply requested but seats unreachable (${missing.join(", ")}) — §6 stays propose-only.`);
        }
      }
      // Phase 2: ONE reporter for the whole fix-loop run. It rides into makeFixLoopDeps (so each
      // pass's runAuditReview feeds the live lens table + unit progress AND runAuditFix feeds the
      // fix counters/gate) and into loopOpts (so runFixLoop emits pass-level phase/progress) — all
      // onto the same progress.json slot.
      const reporter = makeRunReporter(cwd, { kind: "audit-fix-loop", title: "audit fix --loop", json: options.json });
      const deps = makeFixLoopDeps(cwd, model, backends, {
        maxUnits,
        minSeverity: fixMinSeverity,
        coverage,
        verdictMap: logical.verdictMap,
        lensGroups: loopLensGroups,
        maxCells: loopMaxCells,
        // WAVE 2: build the durable sweep machinery (deps.sweep) — the frozen reviewer identities, the
        // epoch fingerprint, the on-disk ledger, the disk read/chunk path. Only when --epoch-sweep is on
        // (and the grouped path is active); null otherwise ⇒ the loop runs legacy. The epoch fingerprint
        // folds `deep` + the seat model/effort pins, so re-pinning a model re-owes its cells.
        epochSweep,
        deep: options.deep,
        codexModel: merged["codex-model"] ?? merged.codexModel,
        grokModel: merged["grok-model"] ?? merged.grokModel,
        // G: thread claudeModel like codex/grok so seatIdentity('claude') gets a real model — else the
        // Claude seat's epoch identity is always "" and a Claude model re-pin does NOT rotate the epoch.
        claudeModel: merged["claude-model"] ?? merged.claudeModel,
        codexEffort: merged["codex-effort"] ?? merged.codexEffort,
        grokEffort: merged["grok-effort"] ?? merged.grokEffort,
        claudeEffort: merged["claude-effort"] ?? merged.claudeEffort,
        openrouterEffort: merged["openrouter-effort"] ?? merged.openrouterEffort,
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
        sensitiveAutoApply,
        reviewPatch,
        retryOnLimit: options["retry-on-limit"],
        // The TRUE base branch, captured before the loop. On pass 2+ the process is ON the
        // integration branch, so runAuditFix's git.currentBranch() would ledger the fix's baseBranch
        // as the integration branch — reconcilePendingFixes then trivially finds the commit an
        // ancestor and falsely promotes it to durable 'fixed' though it was never merged to base
        // (council Opus O7). Pin the real base for the ledger.
        ledgerBaseBranch: baseBranch,
        reporter // Phase 2: threaded into the review + fix closures (see makeFixLoopDeps)
      }, structureTransformRunner ? {
        // M9: every loop pass fixes through runAuditFix — thread the structure consent + the
        // transform runner into EACH pass exactly like the single-shot path does (mirrors how
        // sensitiveAutoApply/reviewPatch ride the options above; makeFixLoopDeps itself threads
        // only the §6 keys, so this impl seam is the loop's door). Absent the flag, no impl is
        // passed at all and the loop's fix calls stay byte-identical.
        runAuditFix: (fixCwd, fixFindings, fixBackends, fixOptions, fixDeps) =>
          runAuditFix(fixCwd, fixFindings, fixBackends, { ...fixOptions, structureAutoApply: true }, { ...fixDeps, runStructureTransform: structureTransformRunner })
      } : {});
      const tLoop = Date.now();
      // A12: bracket the loop with a token snapshot so the --html report can diff it into per-seat tokens
      // + an ≈cost. Only taken when a report will consume it (the scan reads session logs); the same
      // `sinceMs` bound is reused for the AFTER snapshot below.
      const loopTokenSince = Date.now() - TOKEN_SNAPSHOT_WINDOW_MS;
      const loopTokensBefore = options.html ? tokenSnapshot(loopTokenSince) : null;
      // B5: per-tier convergence (structure → correctness → quality) is ON by default so a
      // Structure/SSOT consolidation lands before Correctness runs on the consolidated code; --flat
      // opts out (single flat convergence).
      const loopOpts = {
        budget: loopBudget, maxPasses, dryStreak, maxUnits, perTierConvergence: !options.flat,
        // F-B: thread the structure consent into the loop so runFixLoop derives a CAPABILITY-AWARE
        // FIRST_TIER. Without this the loop's static floor (2) filtered every tier-0/1 structure finding
        // out BEFORE fix() saw it, so `audit fix --loop --structure-auto-apply` silently no-op'd the
        // enabled transformer (only --flat worked). The inner :2619 runAuditFix `structureAutoApply:true`
        // on the impl seam stays — that consents the PER-PASS fixer; this consents the tier FLOOR.
        structureAutoApply,
        // WAVE 2: pin the sweep mode + the ledger's true base branch into the run so runFixLoop drives
        // scheduling/tier-advance off the durable ledger and a resume can't flip the mode.
        epochSweep, ledgerBaseBranch: baseBranch,
        retryOnLimit: options["retry-on-limit"], retryLimit: options["retry-limit"] != null ? Number(options["retry-limit"]) : undefined,
        logicalProposals: logical.findings, usageCeiling, usageSince, pause5h, reporter, onProgress: reporter.line,
        // B: the mid-pass checkpoint-and-resume quota guard — on the grouped path a quota breach quiesces
        // the pass (finish the in-flight cell, flush partial findings + cursor) and emits the SAME
        // hard-stop / pause the between-pass backstop does. Inert on the per-file path (no cells).
        midPassGuard: true,
        // C: durable findings SSOT (audit-findings.jsonl) — the grouped review appends each finding as
        // discovered; the gate reads the accumulated ledger; the dashboard tails it. Autonomous FIXING
        // fails CLOSED if the store can't be opened (no untracked fix ever lands).
        durableFindings: true,
        failClosedFindings: true,
        // D: deterministic correlation — one writer per same-file cluster; multi-file / cross-cutting /
        // SSOT clusters escalate to proposal instead of a symptom fix. Uses the model's import graph.
        correlate: true,
        correlateImporters: model.graph?.importers ?? {}
      };
      // C3/M10: --supervise wraps the loop in the endless supervisor so a multi-hour autonomous run
      // survives rate-limit resets — a resumable stop (throttled/backends-down/did-not-run) waits
      // reset-aware then --resumes from the checkpoint; a terminal convergence returns as normal.
      const out = options.supervise
        ? await runSupervised(
            ({ resume }) => runFixLoop(cwd, { ...loopOpts, resume: resume || options.resume }, deps),
            { onWait: ({ attempt, waitMs, stopReason }) => options.json || console.error(`⏸ supervisor: rate-limited — reset-aware wait ${Math.round(waitMs / 1000)}s (attempt ${attempt}) [${stopReason}]…`) }
          )
        : await runFixLoop(cwd, { ...loopOpts, resume: options.resume }, deps);
      // A SUPERVISED run that ended on a thrown (non-rate-limit) error returns a synthetic TERMINAL
      // result carrying `.err` and none of the loop fields (branch/fixed/…). It must NOT report a clean
      // exit 0 / ok:true — that is the worst outcome for the automated path --supervise exists for (a CI
      // wrapper reads exit 0 as success). Detect the crash and fail loudly below.
      const supervisorCrashed = Boolean(out && out.err);
      // Return to the base branch after the final pass. Attempt the checkout UNCONDITIONALLY: on a
      // supervisor crash `out.branch` is absent but the process may have been left on the integration
      // branch (a pass ≥2 runs there), so gating the checkout on out.branch strands the user silently.
      out.baseBranch = baseBranch;
      out.stranded = false;
      {
        const co = await runCommandAsync("git", ["checkout", baseBranch], { cwd, timeoutMs: 30_000 });
        out.stranded = co.status !== 0;
      }
      recordAuditMetrics(cwd, "fixloop", { wallClockMs: Date.now() - tLoop, fixed: out.fixed?.length ?? 0, failed: out.failed?.length ?? 0, proposed: out.proposed?.length ?? 0, passes: out.passesRun ?? 0, spent: out.spent ?? 0 }, nowIso());
      // B: finalize telemetry via the shared helper — a --pause-at-5h stop (out.pause, below) is recorded
      // as a distinct "paused" phase, NOT done+ok, so the dashboard never shows a suspended run as done.
      finalizeLoopReporter(reporter, out, { ok: !out.stranded && !supervisorCrashed, stopReason: out.stopReason });
      // A crash or a failed return-to-base is a HARD failure: non-zero exit so automation never reads it
      // as success. On a crash, surface it and stop before the report renderers (which assume loop fields).
      if (supervisorCrashed) {
        process.exitCode = 1;
        const msg = `supervised fix loop aborted (terminal): ${out.stopReason ?? String(out.err?.message ?? out.err)}${out.stranded ? ` — AND could not return to ${baseBranch}` : ""}`;
        if (options.json) outputResult({ ...out, ok: false, error: msg }, true);
        else console.error(`✖ ${msg}`);
        return;
      }
      // --pause-at-5h clean stop (a NON-autonomous pause, or an autonomous one whose reset was not
      // schedulable): NOT a crash and NOT a completion. Emit the resume contract + EXIT 75 (EX_TEMPFAIL)
      // so the orchestrator schedules the durable resume and automation never reads PAUSED as done or
      // crashed. Do NOT print the normal fix-loop report (that would imply completion). The plugin only
      // EMITS the contract — the orchestrator (not the plugin) creates any durable resume cron.
      if (out.pause) {
        emitPauseContract(out, { baseBranch, cwd, argv, json: options.json });
        return;
      }
      if (out.stranded) process.exitCode = 1;
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
    // Phase 2: ONE reporter for the whole single-shot `audit fix` run — it covers the fresh review
    // (when no --from) AND the fix itself, so the live dashboard shows unit progress then fix counters.
    const reporter = makeRunReporter(cwd, { kind: "audit-fix-loop", title: "audit fix", json: options.json });
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
          reporter,
          onProgress: reporter.line
        });
      } else {
        rev = await runAuditReview(cwd, model, backends, { ...merged, budget, maxUnits, skipCodex: merged.skipCodex, skipGrok: merged.skipGrok, reporter, onProgress: reporter.line });
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
    if (consent && consent.sensitiveAutoApply && !options.json) {
      const srcMap = { flag: "--sensitive-auto-apply", local: `${LOCAL_CONSENT_FILE} (acknowledged)`, env: `${CONSENT_ENV_VAR} (acknowledged)` };
      const src = srcMap[consent.sources.sensitive] ?? "the sensitive consent";
      console.error(`note: sensitive auto-apply consent (from ${src}) has no effect on single-shot \`audit fix\` (§6 council review runs only in \`audit fix --loop\`); sensitive fixes stay propose-only`);
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
      minSeverity: fixMinSeverity,
      maxFixes,
      retryOnLimit: options["retry-on-limit"],
      retryLimit: singleRetryLimit,
      // M9: the structure consent is added ONLY when --structure-auto-apply was passed, so the
      // default options object stays byte-identical (structure-wiring re-checks === true anyway).
      ...(structureTransformRunner ? { structureAutoApply: true } : {}),
      reporter,
      onProgress: reporter.line
    }, {
      ...(singleCharTestGate ? { charTestGate: singleCharTestGate } : {}),
      ...(structureTransformRunner ? { runStructureTransform: structureTransformRunner } : {})
    });
    if (!options["dry-run"]) {
      recordAuditMetrics(cwd, "fix", { wallClockMs: Date.now() - tFix, fixed: out.fixed?.length ?? 0, failed: out.failed?.length ?? 0, rejected: out.rejected?.length ?? 0, ledgerResolved: out.ledgerResolved ?? 0, integrationFailed: Boolean(out.integrationFailed) }, nowIso());
    }
    reporter.done({ ok: out.ok !== false, stopReason: out.aborted ?? null });
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
    // --usage-ceiling / --pause-at-5h: the SAME two quota guards the fix `--loop` path honours, now wired
    // into the review-only endless loop (mirrors the fix path: same parsers, same default-on 85% pause,
    // same two note lines). Present-but-empty ("") = the bare flag → the default; absent --usage-ceiling
    // → no ceiling. The bare-flag → `=` normalization ran once up front (preArgv), so it already applies
    // to this subcommand. parseUsageCeiling / parsePause5hOption validate + throw fail-fast here.
    const endlessUsageCeiling = options["usage-ceiling"] != null ? parseUsageCeiling(options["usage-ceiling"]) : undefined;
    if (endlessUsageCeiling && !options.json) {
      console.error(`note: --usage-ceiling active — the loop STOPS between passes on a confirmed quota breach (claude ${endlessUsageCeiling.claude}% / codex ${endlessUsageCeiling.codex}% / grok ${endlessUsageCeiling.grok}%). Unknown/unavailable usage never stops it.`);
    }
    const endlessPause5h = parsePause5hOption(options["pause-at-5h"]);
    if (!options.json) {
      if (endlessPause5h.enabled) {
        console.error(`note: --pause-at-5h active — the loop PAUSES between passes when an available model's 5h window is ≥ ${endlessPause5h.threshold}% (${endlessPause5h.autonomous ? "AUTONOMOUS: waits in-process to the reset then resumes itself" : "safe stop with a manual-resume contract, exit 75"}). Disable with --pause-at-5h off. Unknown/unavailable usage never pauses.`);
      } else {
        console.error("note: --pause-at-5h off — the 5h soft-pause safety is DISABLED for this run (the run will not pause when the 5h window fills).");
      }
    }
    // A best-effort current branch for the resume contract's runId + the paused message (endless writes
    // no code, so this is only a label — a detached HEAD / non-git dir degrades to "" harmlessly).
    const endlessBB = await runCommandAsync("git", ["branch", "--show-current"], { cwd, timeoutMs: 10_000 });
    const endlessBaseBranch = endlessBB.status === 0 ? endlessBB.stdout.trim() : "";
    // Each pass advances the hotspot window (progressive coverage) and skips the global reduce after
    // pass 1 (its input is the static map — identical every pass — so re-running it just re-charges
    // budget). With --groups the pass is the cell-granular grouped review whose passComplete gates the
    // dry streak. The window WRAPS (% unit count) so an overrun never returns a 0-unit review that
    // grouped would report as never-complete (council R9 Claude/Codex). Grouped cells are capped to the
    // per-pass budget so a pass never dispatches more paid calls than it is allotted (council R9 P1).
    const nonTestUnits = Math.max(1, (model?.files ?? []).filter((f) => !f.isTest).length);
    const doEndlessReview = endlessLensGroups ? runGroupedReview : runAuditReview;
    // Phase 2: live-dashboard reporter for the endless review loop (phase/progress/budget/findings
    // per pass — see runEndless). onProgress is reporter.line so today's stderr stays byte-identical.
    const reporter = makeRunReporter(cwd, { kind: "audit-endless", title: "audit endless", json: options.json });
    // Thread a MUTED-FINDINGS reporter into each pass's review so per-unit/cell phase+progress fire
    // LIVE inside a pass (today only pass-level phase/progress moved). findings() is a NO-OP on this
    // wrapper: runEndless already folds each pass's deduped `fresh` findings via reporter.findings(),
    // so an inner per-unit fold would DOUBLE-COUNT into findingsByLens. onProgress is intentionally
    // not threaded — the endless loop owns pass-level stderr, so this keeps stderr byte-identical.
    const passReporter = mutedFindingsReporter(reporter);
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
        skipGrok: merged.skipGrok,
        reporter: passReporter // live per-unit/cell progress inside a pass; findings folding stays with runEndless
      });
    const tEndless = Date.now();
    // usageSince (captured at handleAudit entry) bounds the token scan to spend SINCE the run began;
    // runId keys the pause contract's pauseId. Both guards ride into runEndless via the shared helper.
    const endlessOpts = { budget, maxPasses, dryStreak, usageCeiling: endlessUsageCeiling, usageSince, pause5h: endlessPause5h, runId: endlessBaseBranch, reporter, onProgress: reporter.line };
    // C3/M10: --supervise survives rate-limit resets across a multi-hour endless review.
    const out = options.supervise
      ? await runSupervised(
          ({ resume }) => runEndless(cwd, { ...endlessOpts, resume: resume || options.resume }, { review }),
          { onWait: ({ attempt, waitMs, stopReason }) => options.json || console.error(`⏸ supervisor: rate-limited — reset-aware wait ${Math.round(waitMs / 1000)}s (attempt ${attempt}) [${stopReason}]…`) }
        )
      : await runEndless(cwd, { ...endlessOpts, resume: options.resume }, { review });
    recordAuditMetrics(cwd, "endless", { wallClockMs: Date.now() - tEndless, passesRun: out.passesRun, spent: out.spent, findings: out.findings.length, stopReason: out.stopReason }, nowIso());
    // A clean convergence (max passes / budget / diminishing returns) is ok; an endless run that ended
    // on a review-error / did-not-run / failed stopReason is NOT — mirror how plan/build derive ok from
    // the outcome rather than hardcoding true (which would flag a dead run green on the dashboard).
    // B: finalize via the shared helper — a --pause-at-5h stop (out.pause, below) is recorded as a
    // distinct "paused" phase, NOT done+ok, so a suspended run never reads finished-green on the dashboard.
    finalizeLoopReporter(reporter, out, { ok: endlessRunOk(out.stopReason), stopReason: out.stopReason });
    // --pause-at-5h clean stop: emit the SAME council.pause.v1 contract + EXIT 75 as the fix path (shared
    // emitter). NOT a completion → do NOT write the doc or print the normal report. endless writes no
    // code, so a --resume is a plain checkpoint resume (no branch to reconcile).
    if (out.pause) {
      emitPauseContract(out, { baseBranch: endlessBaseBranch, cwd, argv, json: options.json });
      return;
    }
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
  L.push(`- ${out.fixed.length - unverified}/${out.fixed.length} fix(es) test-gated (green per commit + final integration)${unverified ? ` · ${unverified} UNVERIFIED (ungated)` : ""}`);
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

  // Phase 2: live-dashboard reporter for the plan deliberation (phase per R1/R2/R3 milestone).
  const reporter = makeRunReporter(cwd, { kind: "plan", title: "council plan", json: options.json });
  const out = await runPlanDeliberation(cwd, request, backends, {
    ...merged,
    synthesizer: options.synthesizer,
    budget: options.budget != null ? Number(options.budget) : undefined,
    reporter,
    onPhase: options.json ? undefined : (m) => console.error(m)
  });
  reporter.done({ ok: Boolean(out?.planSpec) });
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

// --- `council build` REAL adapters (the CLI-owned half of runBuildStep's deps) -----------------
// runBuild itself supplies the orchestrator-owned ports (git, runFullSuite via detectTestCmd,
// the repo-contained readFile/fileExists from makeStepPorts, now/backends/options — see
// build.mjs); THIS wiring supplies the model-facing + sandbox ports the gate ladder additionally
// requires, all fail-closed: a missing/erroring adapter surfaces as a failed gate + verified
// rollback inside runBuildStep, never as a soft-skipped gate.

// The EXACT permission sandbox chartest-node-harness uses for MODEL-AUTHORED tests (see the
// poison-probe notes there): child_process and fs WRITES are denied (the two vectors an injected
// test would use to tamper or persist), fs reads allowed (the test must import the module under
// test), and the test runs IN-PROCESS (--experimental-test-isolation=none) because node --test's
// default per-file child spawn is itself denied under the permission model.
const STEP_TEST_SANDBOX = Object.freeze(["--experimental-permission", "--allow-fs-read=*", "--experimental-test-isolation=none"]);
const STEP_TEST_TIMEOUT_MS = 120_000;
// Same hard default as the §6 seat runners (build-step-reviewer's SEAT_TIMEOUT_MS): an unattended
// build must never hang forever on a wedged authoring CLI — the seat fails closed instead.
const STEP_AUTHOR_TIMEOUT_MS = 300_000;

/**
 * Classify ONE sandboxed `node --test` run of the step's hashed test file(s) into build-step's
 * runStepTest contract { ok, assertionFailure, stdout }. Exported for direct unit tests.
 *
 * assertionFailure is TRUE only for a REAL assertion-level failure — the RED-before oracle
 * depends on this distinction: a syntax/loader/crash/timeout failure would go "green" the moment
 * the impl merely parses, so it proves nothing and must be an INVALID red. Fail-closed on
 * ambiguity: a run showing BOTH an assertion marker and a crash marker is not a valid RED either
 * (the crash may have masked what the assertions would have said).
 */
export function classifyAuthoredTestRun(res) {
  const stdout = String(res?.stdout ?? "");
  const stderr = String(res?.stderr ?? "");
  const combined = stderr ? `${stdout}\n${stderr}` : stdout;
  if (res?.timedOut === true) return { ok: false, assertionFailure: false, stdout: combined };
  if (res?.status === 0) return { ok: true, assertionFailure: false, stdout: combined };
  const assertion = /\bERR_ASSERTION\b|\bAssertionError\b/.test(combined);
  const crash =
    /\bSyntaxError\b|\bReferenceError\b|\bERR_MODULE_NOT_FOUND\b|Cannot find (?:module|package)|\bERR_ACCESS_DENIED\b|\bERR_UNKNOWN_FILE_EXTENSION\b|\bERR_INVALID_MODULE_SPECIFIER\b|\bERR_REQUIRE_ESM\b/.test(
      combined
    );
  return { ok: false, assertionFailure: assertion && !crash, stdout: combined };
}

/**
 * Parse an author seat's reply into the { files: { path: content } } shape build-step's
 * normalizeAuthoredFiles consumes, or null (fail-closed — build-step rejects the step). The
 * contract asks for a RAW JSON object; a fenced or prose-wrapped reply is salvaged by extraction,
 * but the extracted value must still parse as a plain object whose file values are ALL strings.
 */
function parseAuthoredFilesMap(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.push(fence[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const map = parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : parsed;
    const entries = Object.entries(map ?? {});
    if (!entries.length) continue;
    if (entries.every(([, v]) => typeof v === "string")) return { files: Object.fromEntries(entries) };
  }
  return null;
}

/**
 * Build the CLI-owned stepDeps for runBuildStep (merged over runBuild's orchestrator ports via
 * deps.stepDeps). `buildGit` is the SAME makeBuildGit instance handed to runBuild, so the test
 * runner and the drift gates read one consistent view of the tree. Exported so an integration
 * test can drive the REAL adapters (sandboxed test runner, containment-guarded writes, the
 * coverage/poison port) with only the model-facing ports faked.
 */
export function makeBuildStepDeps(root, cwd, backends, options, buildGit) {
  // Repo-contained fail-closed fs ports (same construction runBuild uses): a symlink target or a
  // path resolving outside the repo THROWS — reused here as the writeFiles containment guard.
  const ports = makeStepPorts(root);
  const testTimeoutMs = Number(options.stepTestTimeoutMs) || STEP_TEST_TIMEOUT_MS;

  // The ONE authoring seat: the first ACTIVE seat, exactly how chartest-wiring picks its
  // generator (availability + skip flags honoured; --codex-model/--grok-model/--claude-model pins
  // and the agent timeout arrive via the merged options). The model's reply is DATA — the seat
  // runners give it no repo write/exec tools, and the reply is parsed, never executed. The
  // prompts themselves (built by build-step) nonce-fence every untrusted input.
  const authorOpts = { ...options, agentTimeoutMs: options.agentTimeoutMs ?? STEP_AUTHOR_TIMEOUT_MS };
  const runners = makeSeatRunners(cwd, backends, authorOpts);
  const authorSeat = activeSeatNames(backends, authorOpts).find((s) => typeof runners[s] === "function") ?? null;
  const author = async (prompt) => {
    // Unreachable when preflight ran (runBuild refuses to start unless EVERY §6 seat — a superset
    // of this one — is reachable); kept throwing so a bypassed preflight still fails CLOSED.
    if (!authorSeat) throw new Error("no authoring seat reachable (codex/grok/claude all unavailable or skipped)");
    const res = await runStructuredWithRetry(
      (p) => runners[authorSeat](p),
      prompt,
      (stdout) => ({ parseOk: parseAuthoredFilesMap(stdout) != null }),
      { maxRetries: 1 }
    );
    // A skipped/timed-out/truncated/non-zero run casts no files — build-step rejects null closed.
    if (!res || res.skipped || res.timedOut || res.truncated || res.status !== 0) return null;
    return parseAuthoredFilesMap(res.stdout);
  };

  // lstat-truth (NEVER stat): true ONLY for an existing REGULAR file inside the repo, so a
  // symlink / directory / special edit-target is rejected by the ladder's revalidation gate
  // (build-step gate 2: "edit exists+regular, no symlink escape").
  const isRegularFile = (rel) => {
    const p = String(rel ?? "");
    if (!p || path.isAbsolute(p) || p.split(/[\\/]+/).includes("..")) return false;
    try {
      return fs.lstatSync(path.join(root, p)).isFile();
    } catch {
      return false; // ENOENT or any lstat fault: not provably a regular file → fail closed
    }
  };

  // The ONLY write path build-step uses. The declared-set bound is enforced mechanically by the
  // ladder itself (authored keys must EQUAL the declared sets; the drift gates re-check the
  // tree); here we re-guard CONTAINMENT with the same makeStepPorts guard: fileExists THROWS on a
  // symlink or an escaping resolution, so a write can never follow a link out of the repo.
  const writeFiles = (map) => {
    for (const [rel, content] of Object.entries(map && typeof map === "object" ? map : {})) {
      ports.fileExists(rel); // throws on symlink/escapes-root — before any byte lands
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(content ?? ""), "utf8");
    }
  };

  // The step's hashed test files, derived from the TREE: at every runStepTest call site the
  // ladder has already enforced changed-set == declared-set (test-phase drift before the RED
  // runs, the step drift gate before GREEN/coverage), so the changed test-convention files ARE
  // exactly the step's declared test set. Fail-closed: no test file present → an invalid run.
  const stepTestFiles = () => buildGit.changedFiles().filter((p) => isPlanTestPath(p)).sort();
  const runSandboxedStepTest = async (extraEnv = {}, extraArgs = []) => {
    const files = stepTestFiles();
    if (!files.length) {
      return { status: 1, stdout: "", stderr: "no step test file present in the working tree (fail-closed)", timedOut: false };
    }
    return runCommandAsync(process.execPath, [...STEP_TEST_SANDBOX, ...extraArgs, "--test", ...files], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      timeoutMs: testTimeoutMs
    });
  };
  const runStepTest = async () => classifyAuthoredTestRun(await runSandboxedStepTest());

  // Read + merge the coverage-*.json documents a NODE_V8_COVERAGE run wrote (mirrors
  // chartest-wiring's private defaultReadCoverage). null = no usable document.
  const readCoverageDir = (dir) => {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return null;
    }
    const result = [];
    for (const f of files) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (Array.isArray(doc.result)) result.push(...doc.result);
      } catch {
        /* skip an unreadable/partial coverage file */
      }
    }
    return result.length ? { result } : null;
  };

  // POISON-PROBE one impl file (chartest-node-harness's inspector-free dependence check): swap it
  // for a same-surface twin whose every export throws, re-run the hashed step test, and require
  // the run to FAIL. Restore is verified by read-back and THROWS on failure — build-step turns
  // that into a failed coverage gate + verified git rollback (which restores the bytes anyway).
  const poisonProbeImplFile = async (rel) => {
    const original = ports.readFile(rel); // repo-contained; throws on symlink/escape
    const poisoned = buildPoisonedSource(original);
    if (poisoned == null) return false; // un-fakeable export surface → fail closed
    const abs = path.join(root, rel);
    let run = null;
    try {
      fs.writeFileSync(abs, poisoned, "utf8");
      run = await runSandboxedStepTest();
    } finally {
      let restored = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !restored; attempt += 1) {
        try {
          fs.writeFileSync(abs, original, "utf8");
          restored = fs.readFileSync(abs, "utf8") === original;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!restored) {
        throw new Error(
          `FATAL(build-poison-restore): could not restore ${rel} after the coverage poison probe (${String(lastErr?.message ?? lastErr ?? "read-back mismatch")}) — failing the step closed; the rollback resets the tree to the step snapshot`
        );
      }
    }
    if (!run || run.timedOut) return false; // an incomplete probe proves nothing → fail closed
    return run.status !== 0; // the hashed test FAILS with this impl file poisoned → it depends on it
  };

  // Changed-line coverage (ladder 7b): re-run the HASHED step test under NODE_V8_COVERAGE and
  // answer per file via changedLinesCovered (innermost-wins). KNOWN PLATFORM LIMITATION (see the
  // poison-probe notes in chartest-node-harness.mjs, verified on v22.13.1): under the permission
  // sandbox the inspector is blocked and the coverage document comes back EMPTY. We never claim
  // coverage we did not measure — when the document is empty we degrade EXACTLY the way chartest
  // does (per-impl-file poison probe) and say so on stderr + in the returned result.
  let coverageDegradeNoted = false;
  const coverChangedLines = async (changed) => {
    const entries = Object.entries(changed && typeof changed === "object" ? changed : {});
    if (!entries.length) return { ok: false, uncovered: [], reason: "no changed lines supplied (fail-closed)" };
    const covDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-build-cov-"));
    try {
      // the coverage run must be allowed to WRITE its NODE_V8_COVERAGE dir under the sandbox
      const run = await runSandboxedStepTest({ NODE_V8_COVERAGE: covDir }, [`--allow-fs-write=${covDir}`]);
      if (!run || run.timedOut || run.status !== 0) {
        return { ok: false, reason: "the hashed step test did not run green under the coverage re-run (fail-closed)" };
      }
      const doc = readCoverageDir(covDir);
      if (doc) {
        const uncovered = [];
        for (const [rel, lines] of entries) {
          if (!changedLinesCovered(doc, path.join(root, rel), ports.readFile(rel), lines)) uncovered.push(rel);
        }
        return uncovered.length ? { ok: false, uncovered } : { ok: true, measured: "v8-changed-line-coverage" };
      }
    } finally {
      try {
        fs.rmSync(covDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    // The run was green but the document is EMPTY → the sandbox blocked the inspector. Degrade
    // honestly: poison-probe dependence per impl file, line granularity NOT established.
    if (!coverageDegradeNoted) {
      coverageDegradeNoted = true;
      console.error(
        "council build: changed-line coverage is unavailable under the test sandbox (the permission model blocks the V8 inspector) — degrading to the per-impl-file poison-probe dependence check (chartest's documented fallback); line granularity NOT established"
      );
    }
    const uncovered = [];
    for (const [rel] of entries) {
      if ((await poisonProbeImplFile(rel)) !== true) uncovered.push(rel);
    }
    return uncovered.length
      ? { ok: false, uncovered, measured: "poison-probe (degraded — inspector blocked by the sandbox)" }
      : { ok: true, measured: "poison-probe (degraded — line granularity not established; inspector blocked by the sandbox)" };
  };

  return {
    authorSeat, // surfaced for the progress log; runBuildStep ignores non-port keys
    authorTests: author,
    authorImpl: author, // the same single active seat — the test/impl firewall is the prompt split + hash binding, enforced in build-step
    writeFiles,
    runStepTest,
    coverChangedLines,
    isRegularFile,
    // §6: every required seat (the UNSHRINKABLE build council), independently, on the COMPLETE
    // staged diff. Note the options are passed through UNTOUCHED — makeBuildStepReviewer itself
    // refuses under any skip flag and build-step computes the required set with EMPTY options.
    reviewStep: makeBuildStepReviewer(cwd, backends, options)
  };
}

// --- M9 `audit fix --structure-auto-apply` REAL adapters (the CLI-owned deps of runStructureTransform)
// structure-wiring.mjs owns the whole gate ladder (double consent → plan → author → drift → full
// suite → public API → §6 unanimity → evaluateStructureGate → reviewed-byte binding → commit);
// THIS wiring supplies its side-effect ports, all FAIL-CLOSED — a missing/erroring adapter surfaces
// as a failed gate + verified rollback inside runStructureTransform, never as a soft-skipped gate.

/**
 * Parse a transform-PLAN reply into a plain object (raw JSON, fenced, or brace-extracted), or null.
 * The reply is DATA — structure-wiring's validateTransformPlan is the sole judge of the content;
 * this only rescues the transport shape (same salvage discipline as parseAuthoredFilesMap), and
 * anything unparseable stays null so the finding remains propose-only (fail-closed).
 */
function parseTransformPlanObject(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.push(fence[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next extraction */
    }
  }
  return null;
}

/**
 * Build the CLI-owned deps for runStructureTransform (structure-wiring.mjs). Mirrors
 * makeBuildStepDeps — and deliberately REUSES its pieces (makeStepPorts containment, the
 * one-active-seat author pattern over makeSeatRunners, parseAuthoredFilesMap, the §6 seat
 * postures) rather than inventing parallel ones. Exported so an integration test can drive the
 * REAL adapters with only the model-facing ports faked.
 */
export function makeStructureTransformDeps(root, cwd, backends, options, buildGit) {
  // Repo-contained fail-closed fs ports (the same construction makeBuildStepDeps uses): a symlink
  // target or a path resolving outside the repo THROWS — structure-wiring turns that throw into a
  // failed gate + verified rollback, never a read/write through a link out of the repo.
  const ports = makeStepPorts(root);

  // The ONE planning/authoring seat: the first ACTIVE seat, exactly how makeBuildStepDeps picks
  // its author (model pins + agent timeout honoured via the merged options; skip flags honoured).
  // The reply is DATA — the seat runners give the model no repo write/exec tools, and the reply is
  // parsed, never executed. A skipped/timed-out/truncated/non-zero reply yields null, which
  // structure-wiring rejects fail-closed (the finding stays propose-only).
  const authorOpts = { ...options, agentTimeoutMs: options.agentTimeoutMs ?? STEP_AUTHOR_TIMEOUT_MS };
  const runners = makeSeatRunners(cwd, backends, authorOpts);
  const authorSeat = activeSeatNames(backends, authorOpts).find((s) => typeof runners[s] === "function") ?? null;
  const seatData = async (prompt, parse) => {
    if (!authorSeat) return null; // no reachable seat → null → structure-wiring fails closed
    const res = await runStructuredWithRetry(
      (p) => runners[authorSeat](p),
      prompt,
      (stdout) => ({ parseOk: parse(stdout) != null }),
      { maxRetries: 1 }
    );
    if (!res || res.skipped || res.timedOut || res.truncated || res.status !== 0) return null;
    return parse(res.stdout);
  };
  const proposePlan = (prompt) => seatData(prompt, parseTransformPlanObject);
  const authorTransform = (prompt) => seatData(prompt, parseAuthoredFilesMap);

  // The ONLY write path the transform gets — the same containment-guarded writer makeBuildStepDeps
  // uses. The plan-declared set is enforced mechanically by structure-wiring (authored keys must
  // EQUAL plannedTouched; its drift gate re-checks the tree); here we re-guard CONTAINMENT with the
  // makeStepPorts guard: fileExists THROWS on a symlink or an escaping resolution — before any byte
  // lands, so a write can never follow a link out of the repo.
  const writeFiles = (map) => {
    for (const [rel, content] of Object.entries(map && typeof map === "object" ? map : {})) {
      ports.fileExists(rel);
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(content ?? ""), "utf8");
    }
  };

  // Half of the behaviour oracle: the project's OWN full suite, UNSANDBOXED (it is the user's
  // trusted suite — same posture as build.mjs's realRunTests), DETECTED, never accepted from
  // options. No detectable suite → { ok:false } → the transform reverts: a structure transform
  // without a test gate must never land (fail-closed, no --allow-untested equivalent here).
  const testCmd = detectTestCmd(root);
  const runFullSuite = async () => {
    if (!testCmd) return { ok: false, reason: "no test command detected — a structure transform requires the full-suite gate" };
    const res = await runCommandAsync(testCmd.cmd, testCmd.args, { cwd: root, timeoutMs: options.testTimeoutMs ?? 600_000 });
    return { ok: res.status === 0 && !res.timedOut };
  };

  // The other half: the export-surface check, built on audit-snapshot's snapshotViolation over the
  // transform's edited files (structure-wiring supplies the exact before/after sources). Definite
  // semantics, fail-closed: `false` ONLY when every edited file's surface is PROVABLY unchanged;
  // `true` (changed → blocked) for any removal/rename/default-flip AND for any surface that cannot
  // be enumerated (star re-export, whole-module CJS — snapshotViolation reports those as
  // violations by design); `null` (unknown → blocked) when there is nothing to judge.
  // allowAdditions is audit-snapshot's documented Structure-tier mode: an extract-shared/
  // consolidate transform legitimately ADDS exports (a new shared module); removals still block.
  const checkPublicApi = ({ files, before, after }) => {
    const list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f) : [];
    if (!list.length) return null; // cannot tell → structure-wiring blocks (only `false` passes)
    for (const p of list) {
      const violation = snapshotViolation(String(before?.[p] ?? ""), String(after?.[p] ?? ""), { allowAdditions: true });
      if (violation != null) return true;
    }
    return false;
  };

  // §6 vote TRANSPORT for structure-wiring's council gate: (seat, prompt) → runner result. The
  // REQUIRED set is computed inside structure-wiring via requiredPatchSeats (built-ins + every
  // configured OpenRouter seat — the runner factory below strips the shrink flags from the options
  // it forwards, so that set is UNSHRINKABLE). Seat postures mirror makeBuildStepReviewer's:
  //   - claude: buildClaudeReviewArgs — --safe-mode + Read/Grep/Glob-only (hard-isolated seat);
  //   - codex/grok: instruction-isolated EMPTY temp cwd (their CLIs auto-load repo instruction
  //     files, and the diff under review is MODEL-written), grok pinned to its read-only sandbox;
  //   - or-*: API-only, cwd inert.
  // Fail-closed: a skipped (seatActive) or unreachable seat returns null → casts NO vote → the
  // unanimity gate VETOES. A flag can abort a transform; it can never shrink its council.
  const grokOpts = { ...authorOpts, grokSandbox: options.grokSandbox ?? "read-only" };
  let isolated = null;
  const isolatedCwd = () => (isolated ??= fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-review-")));
  const reviewRunners = {
    claude: async (prompt) => {
      const bin = backends?.claude?.bin || findClaudeBinary();
      return runCommandAsync(bin, buildClaudeReviewArgs(authorOpts), { cwd, input: prompt, timeoutMs: authorOpts.agentTimeoutMs });
    },
    codex: (prompt) => runCodexStructured(isolatedCwd(), backends, authorOpts, prompt, "structure-review"),
    grok: (prompt) => runGrokStructured(isolatedCwd(), backends, grokOpts, prompt)
  };
  for (const s of backends?.openrouter?.seats ?? []) {
    reviewRunners[s.id] = (prompt) => runOpenRouterStructured(cwd, backends, authorOpts, prompt, s.id);
  }
  const reviewSeat = (seat, prompt) => {
    if (!seatActive(seat, backends, options)) return null; // skipped/unreachable seat: NO vote → veto
    const run = reviewRunners[seat];
    return run ? run(prompt) : null;
  };

  return {
    authorSeat, // surfaced for logs; runStructureTransform ignores non-port keys
    git: buildGit,
    proposePlan,
    authorTransform,
    writeFiles,
    runFullSuite,
    checkPublicApi,
    reviewSeat,
    readFile: ports.readFile,
    fileExists: ports.fileExists,
    backends,
    options,
    now: Date.now
    // limits: deliberately not set — structure-wiring's own bounded defaults apply
  };
}

/**
 * Compose the CLI deps with runStructureTransform for runAuditFix's M9 structure pass. The pass
 * invokes the runner as (args, { git, options, now }); three adaptations happen at this seam —
 * each documented, none weakening a gate:
 *   - git: audit-fix's realGit is the SINGLE-file adapter (stageAndDiffCached) and lacks the
 *     multi-file stageSet/diffCachedSet/tree-bound commitIndex surface structure-wiring's gate 0
 *     requires. The makeBuildGit adapter over the SAME repo root supplies them and WINS on
 *     overlap, so its reviewed-tree commit binding stays armed by its own diffCachedSet.
 *   - options: the consent flags (structureAutoApply / sensitiveAutoApply, strict === true) ride
 *     along from audit-fix, but the §6 SHRINK flags do NOT (skipOpenRouter/skipSeats stripped):
 *     the structure council is UNSHRINKABLE — requiredPatchSeats stays built-ins + every
 *     configured OpenRouter seat. A skipped seat still casts NO vote, which VETOES.
 *   - result: audit-fix's structure pass consumes { ok, commit, stranded, reason };
 *     structure-wiring reports `applied` — ok maps to true ONLY for an applied+committed
 *     transform (a rename, not a semantic change; stranded/reason pass through untouched).
 */
function makeStructureTransformRunner(root, cwd, backends, options) {
  const base = makeStructureTransformDeps(root, cwd, backends, options, makeBuildGit(root));
  return async (args, d = {}) => {
    const git = { ...(d.git ?? {}), ...base.git };
    const opts = { ...(d.options ?? base.options ?? {}) };
    delete opts.skipOpenRouter;
    delete opts.skipSeats;
    const res = await runStructureTransform(args, { ...base, ...d, git, options: opts });
    return res && typeof res === "object" ? { ...res, ok: res.applied === true } : res;
  };
}

export async function handleBuild(argv, { verb: dispatchVerb } = {}) {
  // mutationClass boundary (foundation #2) — at the ENTRANCE so a non-writing verb can NEVER reach any
  // build path (not even the --dry-run preview). `build` WRITES tracked source on an isolated branch;
  // FAIL-CLOSED — an undefined/read-only verb THROWS (no default admits a write). The --dry-run branch
  // (below) is downstream of this guard and, for the build verb, still writes nothing (preflight + print
  // only, no runBuild, no fs writes). main() always threads the resolved verb.
  assertCodeWriteAllowed(dispatchVerb);
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["from", "base", "codex-model", "grok-model", "claude-model"],
    booleanOptions: ["json", "dry-run", "skip-openrouter"]
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  // Effective-policy banner (Stage 4): ONE stderr line, EVEN under --json, printed BEFORE any PlanSpec
  // read / validation error so a recognized build invocation can NEVER exit without it. `build` has NO
  // auto-apply consent knob — it always writes on an isolated branch behind a UNANIMOUS §6 gate and never
  // auto-merges — so the banner states that invariant explicitly.
  console.error(`effective-policy [build]: isolated_branch=true six_eyes_gated=true auto_merge=false dry_run=${options["dry-run"] === true} (build has no auto-apply consent; §6 gates every step)`);
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
  // OUT-OF-BAND REQUEST BINDING (council final, Codex P2): when the operator ALSO types the feature
  // request on argv, thread it through validatePlanSpec as expectedRequest — plan-spec's own documented,
  // mandatory binding. Without it the requestHash check is only SELF-consistency (a request+hash pair
  // recomputed together re-points the plan undetected); with it, the plan's request must normalize-equal
  // what the operator actually asked for. This uses plan-spec's built-in check rather than a parallel
  // digest compare, so the two layers cannot drift.
  const askedFor = positionals.join(" ").trim();
  const check = validatePlanSpec(parsed.spec, { root, fileExists: planFileExists, expectedRequest: askedFor || undefined });
  if (!check.valid) throw new Error(`the PlanSpec is INVALID (fail-closed — nothing is built):\n  - ${check.errors.join("\n  - ")}`);
  const planSpec = check.value;

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
      `§6 required seats: ${Object.keys(ready).filter((k) => k !== "ready" && k !== "reasons").join(", ")} — ${ready.ready ? "ALL reachable" : "NOT all reachable (build would refuse to start)"}`,
      "",
      "(--dry-run: nothing was built and no model was called)"
    ];
    outputResult(options.json ? { planSpec, dryRun: true, reviewerReady: ready } : `${lines.join("\n")}\n`, options.json);
    return;
  }

  // The REAL adapters: one shared git instance (runBuild's orchestrator ports and the step-test
  // runner must read the same tree), plus the CLI-owned model/sandbox ports. runBuild merges its
  // own orchestrator ports (runFullSuite via detectTestCmd, repo-contained readFile/fileExists,
  // now/backends/options) underneath deps.stepDeps and refuses at preflight — spending nothing —
  // when any §6 seat is down, the tree is dirty, HEAD is not the plan's baseCommit, or no test
  // command exists.
  const buildGit = makeBuildGit(root);
  const stepDeps = makeBuildStepDeps(root, cwd, backends, merged, buildGit);
  if (!options.json && stepDeps.authorSeat) {
    console.error(`build: authoring seat = ${stepDeps.authorSeat} (first active seat; §6 reviews with EVERY required seat)`);
  }
  // Phase 2: live-dashboard reporter for the build (phase + step progress + a gate per committed/
  // failed step — see runBuild). onProgress is reporter.line so today's stderr stays byte-identical.
  const reporter = makeRunReporter(cwd, { kind: "build", title: "council build", json: options.json });
  const out = await runBuild(cwd, planSpec, backends, {
    ...merged,
    reporter,
    onProgress: reporter.line
  }, { git: buildGit, stepDeps });
  reporter.done({ ok: out?.ok === true, stopReason: out?.stopReason });

  if (options.json) {
    outputResult(out, true);
  } else {
    console.log(renderBuildReport(out));
  }
  // Any failed gate / stranded run is a non-zero exit — a build that did not fully land must not look green.
  if (!out?.ok || out?.stranded) process.exitCode = 1;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const first = rawArgv[0];
  if (!first || first === "help" || first === "-h" || first === "--help") {
    printUsage();
    return;
  }
  // Stage 3: normalize every OLD command/flag to a canonical verb FIRST (pure, table-driven), emit the
  // one-line deprecation note for a deprecated spelling (stderr only — never --json stdout), then route
  // the canonical verb to the EXISTING handler. `route` = expandAliases → resolveDispatch (both pure).
  emitAliasNotes(rawArgv);
  const r = route(rawArgv);
  const args = r.args;
  try {
    switch (r.handler) {
      case "handleSetup":
        await handleSetup(args);
        break;
      case "handleReview":
        await handleReview(args, r.reviewAdversarial === true, r.reviewDeliberate === true, r.reviewSolve === true);
        break;
      case "handleAudit":
        // The resolved verb (fix vs review/run/endless/passthrough) drives the mutationClass guard.
        await handleAudit(args, { verb: r.verb });
        break;
      case "handleStatus":
        handleStatus(args);
        break;
      case "handleResult":
        handleResult(args);
        break;
      case "handleWait":
        await handleWait(args);
        break;
      case "handleWatch":
        await handleWatch(args);
        break;
      case "handlePlan":
        await handlePlan(args);
        break;
      case "handleBuild":
        await handleBuild(args, { verb: r.verb });
        break;
      case "handleUsage":
        await handleUsage(args);
        break;
      case "handleDoctor":
        await handleDoctor(args);
        break;
      case "handleMetrics":
        handleMetrics(args);
        break;
      case "handleHistory":
        handleHistory(args);
        break;
      case "handleFixloopStatus":
        handleFixloopStatus(args);
        break;
      case "handleBenchmark":
        await handleBenchmark(args);
        break;
      case "handleWorktree":
        handleWorktree(args);
        break;
      case "handleLedger":
        handleLedger(args);
        break;
      case "handleOverview":
        handleOverview(args);
        break;
      case "handleCancel":
        handleCancel(args);
        break;
      case "handleWorker":
        await handleWorker(args);
        break;
      case "error":
        console.error(r.error);
        process.exitCode = 1;
        break;
      case "help":
        printUsage();
        break;
      default:
        printUsage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // A handler that threw (or exited early) before calling reporter.done() would otherwise strand
    // its progress.json at done:false and hang `council watch`. Mark any un-finished run terminal.
    // Runs on the success path too, where it is a no-op (done already set).
    flushActiveRunReporter();
  }
}

// Run the CLI only when this file IS the process entry (`node …/council-companion.mjs <cmd>`,
// which is how every command file, the background-worker respawn, and every subprocess test
// invoke it). A plain `import` of the module — the unit-test seam for the pure helpers exported
// above (e.g. classifyAuthoredTestRun) — must not parse argv or print usage.
function invokedAsCli() {
  try {
    if (!process.argv[1]) return false;
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return true; // fail toward the historical behavior: run the CLI
  }
}

if (invokedAsCli()) await main();
