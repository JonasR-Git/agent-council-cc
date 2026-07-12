// §6 patch reviewer for the bare CLI. Produces the `reviewPatch` function the fix
// engine's council gate needs — WITHOUT an agent-orchestration layer — by shelling out
// to the three model CLIs directly (the same backends the review/deliberate path uses).
// Each seat independently judges the SAME patch (the six-eyes rule); a seat that is
// unreachable or errors casts NO vote, so evaluatePatchVerdicts fails closed.
import { buildPatchReviewPrompt, parsePatchVerdict, PATCH_REVIEW_SEATS } from "./audit-council-gate.mjs";
import { runCodexStructured, runGrokStructured } from "./agents.mjs";
import { findClaudeBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";

// The Claude seat runs read-only: it may inspect the repo (Read/Grep/Glob) to judge the
// patch against callers, but never edits, shells out, or reaches the network.
const CLAUDE_REVIEW_ALLOWED = ["Read", "Grep", "Glob"];
const CLAUDE_REVIEW_DISALLOWED = ["Bash", "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch", "Task", "NotebookEdit"];

export function buildClaudeReviewArgs(options = {}) {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--allowed-tools",
    ...CLAUDE_REVIEW_ALLOWED,
    "--disallowed-tools",
    ...CLAUDE_REVIEW_DISALLOWED,
    "--strict-mcp-config",
    "--permission-mode",
    "default"
  ];
  if (options.claudeModel) args.push("--model", options.claudeModel);
  return args;
}

async function realClaudeReview(cwd, backends, options, prompt) {
  const bin = backends?.claude?.bin || findClaudeBinary();
  const res = await runCommandAsync(bin, buildClaudeReviewArgs(options), { cwd, input: prompt, timeoutMs: options.agentTimeoutMs ?? 300_000 });
  if (res.timedOut) throw new Error("claude review runner timed out");
  if (res.status !== 0) throw new Error(`claude review runner exited ${res.status}`);
  return res.stdout;
}

/** Extract the model's reply text from whatever a seat runner returned. */
function textOf(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (res.skipped) return "";
  return String(res.stdout ?? res.text ?? "");
}

/**
 * Build a `reviewPatch({file, finding, diff})` that runs all three seats on the SAME
 * patch (in parallel) and returns their parsed verdicts. Injectable per-seat runner
 * (deps.runClaude/runCodex/runGrok) so it is unit-testable without the real CLIs.
 * Fail-closed: a seat that throws, times out, is unavailable, or returns nothing casts
 * no vote — evaluatePatchVerdicts then can't reach unanimity and the fix stays proposed.
 */
export function makePatchReviewer(cwd, backends, options = {}, deps = {}) {
  const runners = {
    claude: deps.runClaude ?? ((prompt) => realClaudeReview(cwd, backends, options, prompt)),
    codex: deps.runCodex ?? ((prompt) => runCodexStructured(cwd, backends, options, prompt, "patch-review")),
    grok: deps.runGrok ?? ((prompt) => runGrokStructured(cwd, backends, options, prompt))
  };
  return async ({ file, finding, diff }) => {
    const votes = await Promise.all(
      PATCH_REVIEW_SEATS.map(async (seat) => {
        try {
          const text = textOf(await runners[seat](buildPatchReviewPrompt(file, finding, diff, seat)));
          return text ? parsePatchVerdict(text, seat) : null;
        } catch {
          return null; // fail-closed: an erroring/unreachable seat is a non-vote, never a confirm
        }
      })
    );
    return votes.filter(Boolean);
  };
}

/**
 * Which of the three seats are reachable. §6 auto-apply needs ALL three: if any is
 * missing the gate can never reach unanimity, so the caller should warn + keep the
 * sensitive class propose-only rather than silently never-approve.
 */
export function patchReviewerReady(backends) {
  let claude = false;
  try {
    claude = Boolean(backends?.claude?.bin || findClaudeBinary());
  } catch {
    claude = false;
  }
  const codex = Boolean(backends?.codex?.companionAvailable);
  const grok = Boolean(backends?.grok?.bin || backends?.grok?.cli?.available);
  return { ready: claude && codex && grok, claude, codex, grok };
}
