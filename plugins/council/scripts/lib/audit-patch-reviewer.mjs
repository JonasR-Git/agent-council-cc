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
    // --safe-mode disables the AUDITED repo's customizations — CLAUDE.md, skills, plugins,
    // HOOKS, MCP servers, custom commands/agents — so a hostile repo can neither bias the
    // verdict via instruction files nor execute code via lifecycle hooks during the review.
    "--safe-mode",
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

/**
 * Extract a seat's reply text — but ONLY from a cleanly-completed run. A skipped,
 * timed-out, truncated, or non-zero-exit run yields "" so it casts NO vote, even if it
 * emitted a partial "VERDICT: ..." before dying. This keeps all three seats symmetric
 * and fail-closed (the Claude runner already throws on failure; Codex/Grok return a
 * structured result whose status/timedOut/truncated we must honor).
 */
function textOf(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (res.skipped) return "";
  if (res.timedOut || res.truncated) return "";
  if (res.status != null && res.status !== 0) return "";
  return String(res.stdout ?? res.text ?? "");
}

/**
 * Build a `reviewPatch({file, finding, diff})` that runs all three seats on the SAME
 * patch (in parallel) and returns their parsed verdicts. Injectable per-seat runner
 * (deps.runClaude/runCodex/runGrok) so it is unit-testable without the real CLIs.
 * Fail-closed: a seat that throws, times out, is unavailable, or returns nothing casts
 * no vote — evaluatePatchVerdicts then can't reach unanimity and the fix stays proposed.
 */
// ISOLATION MODEL (honest): only the Claude seat is HARD-isolated from the audited repo's
// instruction files (--safe-mode disables CLAUDE.md/hooks/plugins/MCP). Codex still loads
// AGENTS.md and Grok's --sandbox is filesystem/network isolation, not instruction
// suppression — so a hostile repo CAN bias those two toward CONFIRM (a soft in-prompt
// "ignore repo config" is their only instruction defense). The SAFETY INVARIANT still
// holds: approval requires UNANIMITY, and the hard-isolated Claude seat votes independently
// of any repo instruction — so a codex/grok bias alone can never manufacture a false
// approval. Exfiltration is blocked on all three (fs/network isolation everywhere).
export function makePatchReviewer(cwd, backends, options = {}, deps = {}) {
  // The Grok seat runs under grok's "read-only" sandbox (a verified-valid profile:
  // off/workspace/devbox/read-only/strict) so a hostile repo can't exfiltrate via
  // MCP/network during the review. Note: grok does not error on an unknown profile, so we
  // pin a known-valid one rather than trusting caller input.
  const grokOpts = { ...options, grokSandbox: options.grokSandbox ?? "read-only" };
  const runners = {
    claude: deps.runClaude ?? ((prompt) => realClaudeReview(cwd, backends, options, prompt)),
    codex: deps.runCodex ?? ((prompt) => runCodexStructured(cwd, backends, options, prompt, "patch-review")),
    grok: deps.runGrok ?? ((prompt) => runGrokStructured(cwd, backends, grokOpts, prompt))
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
  // Use the ACTUAL availability probes, not fallback command-name strings: probeBackends
  // supplies default "claude"/"grok" bin names even when the reachability probe FAILED, so
  // Boolean(bin) does NOT mean reachable. A false-positive would print ENABLED and then run
  // a gate that can never reach unanimity.
  const claude = Boolean(backends?.claude?.cli?.available);
  // The codex SEAT votes via runCodexStructured, which HARD-requires the companion (it
  // returns skipped without it). Gating on cli.available would report ENABLED while codex
  // can never cast a vote → the gate could never reach unanimity. Companion only.
  const codex = Boolean(backends?.codex?.companionAvailable);
  const grok = Boolean(backends?.grok?.cli?.available);
  return { ready: claude && codex && grok, claude, codex, grok };
}
