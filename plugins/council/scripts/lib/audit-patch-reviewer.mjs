// §6 patch reviewer for the bare CLI. Produces the `reviewPatch` function the fix
// engine's council gate needs — WITHOUT an agent-orchestration layer — by shelling out
// to the three model CLIs directly (the same backends the review/deliberate path uses).
// Each seat independently judges the SAME patch (the six-eyes rule); a seat that is
// unreachable or errors casts NO vote, so evaluatePatchVerdicts fails closed.
import { buildPatchReviewPrompt, parsePatchVerdict } from "./audit-council-gate.mjs";
import { runCodexStructured, runGrokStructured } from "./agents.mjs";
import { runOpenRouterStructured } from "./openrouter-agent.mjs";
import { requiredPatchSeats, seatActive } from "./seats.mjs";
import { findClaudeBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";
import { REVIEWER_CHARTER } from "./reviewer-charter.mjs";

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
    "default",
    // A4: a STABLE reviewer charter (evidence-first, failure-scenario-required, severity-cap
    // discipline). Identical across every review call, so Anthropic prompt caching reuses it
    // (system-block cache hit → cheaper + faster). It sets reasoning discipline only; the
    // user prompt still dictates the exact 2-line VERDICT reply, which the charter defers to.
    // ASYMMETRY (grok-2, acceptable for §6): only the Claude seat gets the charter — codex/grok
    // are spawned via runCodex/runGrokStructured which expose no --append-system-prompt. Fine
    // here: the §6 vote is binary (severity-cap is moot) and the load-bearing "when in doubt,
    // DISSENT" lives in the SHARED user prompt every seat receives. Revisit before B2/M7 wires
    // the severity-BEARING finder, where a Claude-only severity-cap would skew cross-seat calibration.
    "--append-system-prompt",
    REVIEWER_CHARTER,
    // A2: reasoning effort defaults to xhigh (user pref: always xhigh, never max) so the §6
    // patch reviewer thinks as hard as possible. An unknown value warns + falls back to the
    // CLI default, so this can't break the seat. Valid: low|medium|high|xhigh|max.
    "--effort",
    options.claudeEffort ?? "xhigh"
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
// ISOLATION MODEL (honest — A6): only the Claude seat is HARD-isolated from the audited repo's
// instruction files (--safe-mode disables CLAUDE.md/hooks/plugins/MCP). Codex still loads
// AGENTS.md and Grok's --sandbox is NOT instruction suppression — so a hostile repo CAN bias
// those two toward CONFIRM (a soft in-prompt "ignore repo config" is their only instruction
// defense). The SAFETY INVARIANT still holds: approval requires UNANIMITY, and the hard-isolated
// Claude seat votes independently of any repo instruction — so a codex/grok bias alone can never
// manufacture a false approval.
//
// EXFILTRATION controls are NOT symmetric across the three seats (council A6: codex-1/claude-1):
//   - CLAUDE seat: a fail-CLOSED ALLOW-list — only Read/Grep/Glob ever exist (no Bash/web/MCP).
//     The strongest posture; nothing outside those three can run regardless of tool names.
//   - GROK seat: a fail-OPEN DENY-list (READONLY_DISALLOWED_TOOLS) + --disable-web-search. Only as
//     complete as the enumerated names — any grok tool NOT listed stays allowed — so it is
//     best-effort, not a guarantee. --disable-web-search definitively removes the web vector.
//   - CODEX seat: NO in-repo tool gating at all. runCodexStructured passes only the prompt file +
//     model; Codex's read-only containment is the codex-companion runtime's OWN sandbox/approval
//     policy — an OS/CLI-level control this codebase neither sets nor can verify (best-effort,
//     exactly the OS-sandbox class that is unreliable on native Windows).
// Grok's --sandbox is a further best-effort OS extra that is a NO-OP on native Windows. So the
// only fail-closed seat is Claude; codex/grok containment is best-effort. The SAFETY INVARIANT
// does not rest on exfil control anyway: approval requires UNANIMITY and the hard-isolated Claude
// seat votes independently, so a codex/grok compromise alone cannot manufacture a false approval.
export function makePatchReviewer(cwd, backends, options = {}, deps = {}) {
  // The Grok seat additionally requests grok's "read-only" sandbox profile (a verified-valid one:
  // off/workspace/devbox/read-only/strict) as defense-in-depth. This is BEST-EFFORT — a no-op on
  // native Windows and grok does not error on an unknown profile — so the actual (best-effort)
  // no-exfil control is the deny-list + --disable-web-search, not this profile. We still pin a
  // known-valid value rather than trusting caller input for the platforms that do honor it.
  const grokOpts = { ...options, grokSandbox: options.grokSandbox ?? "read-only" };
  const runners = {
    claude: deps.runClaude ?? ((prompt) => realClaudeReview(cwd, backends, options, prompt)),
    codex: deps.runCodex ?? ((prompt) => runCodexStructured(cwd, backends, options, prompt, "patch-review")),
    grok: deps.runGrok ?? ((prompt) => runGrokStructured(cwd, backends, grokOpts, prompt))
  };
  // Each configured OpenRouter seat is also a §6 reviewer (API-only — no local tools, so strictly safer
  // than the CLI seats). It votes on the SAME patch; a missing/erroring vote fails closed like any seat.
  for (const s of backends?.openrouter?.seats ?? []) {
    runners[s.id] = deps.runOpenRouter ? (prompt) => deps.runOpenRouter(cwd, backends, options, prompt, s.id) : (prompt) => runOpenRouterStructured(cwd, backends, options, prompt, s.id);
  }
  const seats = requiredPatchSeats(backends, options);
  return async ({ file, finding, diff, after, context }) => {
    // A3: hand each seat the POST-PATCH surrounding source so it judges the diff IN CONTEXT
    // (the whole function + callers), not blind on the hunk alone. `after` is the applied
    // patch's full file content threaded from the fix engine; `context` is an explicit
    // override that WINS when provided — including an explicit "" to SUPPRESS the block even
    // when `after` is populated (unambiguous: undefined = fall back to after, "" = suppress).
    // buildPatchReviewPrompt WINDOWS the source around the changed hunk and caps it, so an
    // oversized file neither blinds the reviewer with a file head nor blows the context window.
    const ctx = context !== undefined ? context : (after ?? "");
    const votes = await Promise.all(
      seats.map(async (seat) => {
        const run = runners[seat];
        if (!run) return null; // a required seat with no runner casts no vote → veto (fail-closed)
        try {
          const text = textOf(await run(buildPatchReviewPrompt(file, finding, diff, seat, ctx)));
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
export function patchReviewerReady(backends, options = {}) {
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
  // Every CONFIGURED OpenRouter seat must ALSO be reachable up front, else §6 auto-apply would enable a
  // gate that can never reach unanimity (a configured-but-down OR seat is a required veto). Report each
  // so the caller can name the missing seat.
  const perSeat = { claude, codex, grok };
  const orReady = [];
  for (const s of backends?.openrouter?.seats ?? []) {
    if (options.skipOpenRouter || (options.skipSeats ?? []).includes(s.id)) continue;
    const ok = seatActive(s.id, backends, options);
    perSeat[s.id] = ok;
    orReady.push(ok);
  }
  return { ready: claude && codex && grok && orReady.every(Boolean), ...perSeat };
}
