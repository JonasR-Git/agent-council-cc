import { buildAgentResult } from "./agents.mjs";
import { findClaudeBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";

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
    "--strict-mcp-config"
  ];
  if (options.claudeModel) args.push("--model", options.claudeModel);
  return args;
}

export async function runClaudeStructured(cwd, backends, options, prompt) {
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
