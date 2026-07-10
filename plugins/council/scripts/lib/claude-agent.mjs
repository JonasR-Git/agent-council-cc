import { findClaudeBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";

/**
 * Spawn Claude Code headless (`claude -p --model <model>`) as an INDEPENDENT
 * council reviewer, separate from the orchestrating session. This decouples the
 * reviewer role (a pinnable Claude model, e.g. opus-4.8) from the orchestrator
 * (the session), so the orchestrator can judge neutrally. Read-only: write tools
 * are disallowed. Prompt is piped on stdin (diffs are too large for argv).
 */
const READONLY_DISALLOWED = ["Edit", "Write", "NotebookEdit", "Bash"];

/**
 * Build the argv for a read-only headless Claude reviewer. Kept pure and
 * exported so the flag wiring (model pin, read-only disallow-list) is testable
 * without spawning the real CLI.
 */
export function buildClaudeArgs(options = {}) {
  const args = ["-p", "--output-format", "text", "--disallowed-tools", ...READONLY_DISALLOWED];
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
  return {
    agent: "claude",
    backend: "claude-cli",
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    durationMs: result.durationMs ?? null,
    model: options.claudeModel ?? "(claude CLI default)",
    command: `${bin} -p --model ${options.claudeModel ?? "(default)"} ...`
  };
}
