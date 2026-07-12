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

// A3: the operator flag that opts a BUILT-IN seat out. §6 unanimity ALWAYS requires all three
// built-ins — requiredPatchSeats never shrinks for them, on purpose: a CLI flag must not be able
// to silently weaken the unanimity gate (that is the security invariant). So a SKIPPED built-in
// can never cast a vote yet is still required → the gate would veto every sensitive patch forever
// with "missing: grok". patchReviewerReady therefore reports NOT ready with an honest reason, and
// the caller keeps the sensitive class propose-only. (No entry is needed for an OpenRouter seat: a
// skipped OR seat is simply NOT required — requiredPatchSeats drops it — so it never lands here.)
const BUILTIN_SKIP_FLAG = Object.freeze({ codex: "--skip-codex", grok: "--skip-grok", claude: "--skip-claude" });

function builtinSkipped(seat, options) {
  if (seat === "codex") return Boolean(options.skipCodex);
  if (seat === "grok") return Boolean(options.skipGrok);
  if (seat === "claude") return Boolean(options.skipClaude);
  return false;
}

/** Why a REQUIRED seat cannot vote — an honest, per-seat sentence the CLI can print verbatim. */
function seatBlockedReason(seat, options) {
  if (builtinSkipped(seat, options)) {
    return `${BUILTIN_SKIP_FLAG[seat]} is incompatible with --sensitive-auto-apply: §6 needs all three built-in seats`;
  }
  if (seat === "codex") return "codex-companion unavailable (the codex seat votes only via the companion)";
  if (seat === "grok") return "grok CLI unreachable";
  if (seat === "claude") return "claude CLI unreachable";
  return `OpenRouter seat ${seat} unreachable (no API key / no models configured)`;
}

/**
 * Which of the REQUIRED §6 seats can actually vote. Auto-apply needs every one of them: if any is
 * missing the gate can never reach unanimity, so the caller should warn + keep the sensitive class
 * propose-only rather than silently never-approve.
 *
 * Returns `{ ready, <seat>: boolean…, reasons: { <seat>: why } }` — one boolean per required seat
 * (built-ins + every configured, non-skipped OpenRouter seat) plus a reason for each blocked seat.
 */
export function patchReviewerReady(backends, options = {}) {
  // Ask the seat REGISTRY which seats §6 requires — never a hardcoded ["codex","grok"] triple, so
  // every OpenRouter seat the operator configured is checked up front too (a configured-but-down OR
  // seat is a required veto: enabling auto-apply would run a gate that can never reach unanimity).
  const perSeat = {};
  const reasons = {};
  for (const seat of requiredPatchSeats(backends, options)) {
    // seatActive() is the single source of truth for "can this seat cast a vote at all". It answers
    // BOTH halves, which a bare availability probe misses:
    //   - REACHABILITY from the ACTUAL probes, not fallback command-name strings: probeBackends
    //     supplies default "claude"/"grok" bin names even when the reachability probe FAILED, so
    //     Boolean(bin) does NOT mean reachable. A false-positive would print ENABLED and then run a
    //     gate that can never reach unanimity. (And the codex SEAT votes via runCodexStructured,
    //     which HARD-requires the companion — hence companionAvailable, never cli.available.)
    //   - the operator SKIP flags (--skip-codex/--skip-grok/--skip-claude, also set by a policy
    //     `reviewers` list that omits a seat). See BUILTIN_SKIP_FLAG above: a skipped built-in is
    //     still REQUIRED, so it must fail the readiness check — fail-safe, never a silent veto.
    const ok = seatActive(seat, backends, options);
    perSeat[seat] = ok;
    if (!ok) reasons[seat] = seatBlockedReason(seat, options);
  }
  // `reasons` is an object (always truthy), so callers that name the blocked seats by filtering the
  // falsy keys of this result keep working unchanged.
  return { ready: Object.values(perSeat).every(Boolean), ...perSeat, reasons };
}
