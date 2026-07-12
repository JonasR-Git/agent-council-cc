import { buildAgentResult } from "./agents.mjs";
import { findClaudeBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";
import { REVIEWER_CHARTER } from "./reviewer-charter.mjs";

/**
 * Spawn Claude Code headless (`claude -p --model <model>`) as an INDEPENDENT
 * council reviewer, separate from the orchestrating session. This decouples the
 * reviewer role (a pinnable Claude model, e.g. opus-4.8) from the orchestrator
 * (the session), so the orchestrator can judge neutrally. Prompt is piped on
 * stdin (diffs are too large for argv).
 *
 * The reviewer reads UNTRUSTED diff content, so it is confined with an ALLOW-list
 * (not a denylist): only read/search tools are available, and --strict-mcp-config
 * blocks the repo's own .mcp.json servers from loading. A denylist would leave
 * MCP tools, WebFetch/WebSearch and Task subagents reachable — an injected diff
 * could use them to exfiltrate or mutate. A broad --disallowed-tools list is kept
 * as belt-and-suspenders defense in depth. Bound is the wall-clock agentTimeoutMs
 * (this CLI has no --max-turns).
 */
const READONLY_ALLOWED = ["Read", "Glob", "Grep"];
// Defense in depth behind the allowlist: explicit deny of the obvious write/exec
// and exfiltration tools, in case a CLI version widens the allowlist semantics.
const READONLY_DISALLOWED = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task"
];

/**
 * Build the argv for a read-only headless Claude reviewer. Kept pure and
 * exported so the flag wiring (allowlist, strict MCP, model pin) is testable
 * without spawning the real CLI.
 */
export function buildClaudeArgs(options = {}) {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--allowed-tools",
    ...READONLY_ALLOWED,
    "--disallowed-tools",
    ...READONLY_DISALLOWED,
    "--strict-mcp-config",
    // B2 (six-eyes finder parity with the §6 patch reviewer): --safe-mode HARD-isolates the
    // audited repo — disables its CLAUDE.md/hooks/plugins/MCP — so a hostile repo can neither bias
    // the finder via instruction files nor execute code via lifecycle hooks. The stable, cache-
    // friendly REVIEWER_CHARTER (A4) sets evidence-first/severity-cap discipline at the system
    // block; --effort defaults to xhigh (A2, user pref). The PROMPT still dictates the findings
    // JSON shape, which the charter defers to. REVIEWER_CHARTER is single-line, so it is safe as a
    // CLI arg on the Windows cmd.exe path (A4).
    "--safe-mode",
    "--permission-mode",
    "default",
    "--append-system-prompt",
    REVIEWER_CHARTER,
    "--effort",
    options.claudeEffort ?? "xhigh"
  ];
  if (options.claudeModel) args.push("--model", options.claudeModel);
  return args;
}

export async function runClaudeStructured(cwd, backends, options, prompt) {
  // Fail-closed: a probe that ran and found Claude unavailable casts NO finding (mirrors the codex
  // companion / grok cli gating), so a missing backend can never manufacture an empty "clean"
  // review. Only an explicit unavailable probe skips; when Claude was never probed the caller
  // should not have dispatched us (the audit path gates on reviewerActive('claude')).
  if (backends?.claude?.cli && backends.claude.cli.available === false) {
    return {
      agent: "claude",
      skipped: true,
      reason: `claude cli unavailable (${backends.claude.cli.detail ?? "not available"})`,
      stdout: "",
      stderr: ""
    };
  }
  const bin = backends?.claude?.bin || findClaudeBinary();
  const args = buildClaudeArgs(options);

  const result = await runCommandAsync(bin, args, {
    cwd,
    input: prompt,
    timeoutMs: options.agentTimeoutMs
  });
  return buildAgentResult("claude", "claude-cli", result, {
    model: options.claudeModel ?? "(claude CLI default)",
    command: `${bin} -p --model ${options.claudeModel ?? "(default)"} ...`
  });
}
