// The DYNAMIC seat registry — the SINGLE place that enumerates which seats participate as finders /
// refutation verifiers / §6 patch reviewers. OpenRouter models (seats.mjs) layer on top of the three
// built-in CLI seats (codex/grok/claude) WITHOUT any consumer hardcoding the triple. Critical
// invariant (council Opus/Fable/Grok converged): with NO openrouter config, allSeatNames() is EXACTLY
// the three built-ins and every consumer behaves byte-identically to before — so the existing 640+
// tests stay green. The built-in seatActive branches are a VERBATIM copy of the former reviewerActive,
// which now delegates here.
import { runCodexStructured, runGrokStructured } from "./agents.mjs";
import { runClaudeStructured } from "./claude-agent.mjs";
import { runOpenRouterStructured } from "./openrouter-agent.mjs";

export const BUILTIN_SEATS = Object.freeze(["codex", "grok", "claude"]);

/** True for a configured OpenRouter seat id (or the `or-` naming convention when backends is absent). */
export function isOpenRouterSeat(name, backends = null) {
  if (backends?.openrouter?.seats) return backends.openrouter.seats.some((s) => s.id === name);
  return typeof name === "string" && name.startsWith("or-");
}

/** All seat ids in play: the three built-ins, then every configured OpenRouter seat id. */
export function allSeatNames(backends) {
  return [...BUILTIN_SEATS, ...(backends?.openrouter?.seats ?? []).map((s) => s.id)];
}

/**
 * Is a seat active this run? Built-in branches are the former reviewerActive verbatim. An OpenRouter
 * seat is active iff it is configured, the backend is reachable (a key + ≥1 model → openrouter.available),
 * and it was not skipped (--skip-openrouter, or a per-seat skipSeats list).
 */
export function seatActive(name, backends, options = {}) {
  if (name === "codex") return !options.skipCodex && Boolean(backends?.codex?.companionAvailable);
  if (name === "grok") return !options.skipGrok && Boolean(backends?.grok?.cli?.available);
  if (name === "claude") return !options.skipClaude && Boolean(backends?.claude?.cli?.available);
  const orSeats = backends?.openrouter?.seats ?? [];
  if (orSeats.some((s) => s.id === name)) {
    return !options.skipOpenRouter && Boolean(backends?.openrouter?.available) && !(options.skipSeats ?? []).includes(name);
  }
  return false;
}

/** The active seat ids (built-ins first, then OpenRouter), filtered by seatActive. */
export function activeSeatNames(backends, options = {}) {
  return allSeatNames(backends).filter((name) => seatActive(name, backends, options));
}

/**
 * name → (prompt) => Promise<runnerResult> for every seat. Built-in runners match today's per-seat
 * calls; each OpenRouter seat routes to runOpenRouterStructured with its id. deps.runCodex/runGrok/
 * runClaude/runOpenRouter stay injectable for tests (the OpenRouter override receives the seat id).
 */
export function makeSeatRunners(cwd, backends, options = {}, deps = {}) {
  const runners = {
    codex: deps.runCodex ?? ((p) => runCodexStructured(cwd, backends, options, p, "audit")),
    grok: deps.runGrok ?? ((p) => runGrokStructured(cwd, backends, options, p)),
    claude: deps.runClaude ?? ((p) => runClaudeStructured(cwd, backends, options, p))
  };
  for (const s of backends?.openrouter?.seats ?? []) {
    runners[s.id] = deps.runOpenRouter ? (p) => deps.runOpenRouter(cwd, backends, options, p, s.id) : (p) => runOpenRouterStructured(cwd, backends, options, p, s.id);
  }
  return runners;
}

/**
 * The seats §6 unanimity REQUIRES: the reachable built-ins PLUS every active OpenRouter seat. Adding an
 * OpenRouter seat RAISES the bar (every required seat must be present AND confirm) — a missing/erroring
 * seat casts no vote → veto, fail-closed. Built-ins are always required (the §6 gate's existing default
 * PATCH_REVIEW_SEATS), so a mid-run unavailable built-in still blocks, exactly as today.
 */
export function requiredPatchSeats(backends, options = {}) {
  if (options.skipOpenRouter) return [...BUILTIN_SEATS];
  const skip = new Set(options.skipSeats ?? []);
  // NOT filtered by availability: a CONFIGURED (non-skipped) OpenRouter seat is REQUIRED even if it is
  // momentarily unreachable — its missing vote then vetoes (fail-closed), exactly as a mid-run built-in
  // outage does. The CLI checks reachability UP FRONT (patchReviewerReady) and keeps the sensitive class
  // propose-only when a configured seat is down, so §6 auto-apply only turns on with every seat present.
  const or = (backends?.openrouter?.seats ?? []).map((s) => s.id).filter((id) => !skip.has(id));
  return [...BUILTIN_SEATS, ...or];
}
