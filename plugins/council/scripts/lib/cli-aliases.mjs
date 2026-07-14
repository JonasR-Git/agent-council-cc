// The canonical 7-verb CLI surface (docs/cli-surface-design.md). The legacy old-name ALIAS layer has been
// REMOVED — the Appendix-B old→new migration is complete, so the OLD command NAMES (deliberate, adversarial,
// audit, watch, wait, result, cancel, doctor, usage, ledger, history, metrics, fixloop-status, overview,
// endless) no longer resolve: an unknown top-level token is a CLEAN ERROR from the dispatch, not a silent
// rewrite. This module now only:
//   (a) publishes the SSOT verb lists (the 7 user-facing verbs + the hidden/internal verbs), and
//   (b) NORMALIZES an argv for the dispatch — a single raw "$ARGUMENTS" rest is tokenized exactly the way
//       each handler's normalizeArgv does, the `--` option terminator (and everything after it) is preserved
//       verbatim, and the hidden verbs pass through COMPLETELY RAW (the `worker` spawn protocol that live
//       background jobs depend on must stay byte-exact).
// It maps NO old name to a canonical verb — that layer is gone.

import { splitRawArgumentString } from "./args.mjs";

// The 7 canonical, user-facing verbs (docs/cli-surface-design.md §"The 7 user-facing verbs").
export const CANONICAL_VERBS = ["review", "fix", "plan", "build", "solve", "status", "setup"];

// Hidden/internal verbs — kept callable, NOT shown in top-level --help. `worker` MUST NOT be renamed (the
// background-job spawn protocol depends on it). They pass through COMPLETELY RAW (see expandAliases) so a
// single space-containing token (JSON payload / Windows path) survives byte-for-byte.
export const HIDDEN_VERBS = ["worker", "worktree", "benchmark"];

// Match the per-handler normalizeArgv convention: a single raw argument string (the slash-command path
// passes "$ARGUMENTS" as one token) is tokenized so the dispatch reads the flags it needs. Only applies when
// there is NO `--` terminator (a terminated argv is already multi-token).
function normalizeRest(rest) {
  return rest.length === 1 ? splitRawArgumentString(rest[0]) : rest.slice();
}

/**
 * PURE: normalize an argv for the dispatch. There is NO alias mapping any more — a canonical verb is left
 * with its verb unchanged, and an unknown OLD name is left unchanged too (the dispatch rejects it with the
 * clean unknown-command error). A hidden verb passes through COMPLETELY RAW; otherwise a single raw-string
 * rest is tokenized and the `--` terminator (+ its verbatim tail) is preserved. Returns a NEW array; never
 * mutates the input; IDEMPOTENT (an already-tokenized argv normalizes to itself).
 */
export function expandAliases(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const command = argv[0];

  // Hidden/internal verbs pass through RAW — no normalizeRest, no `--` handling. The spawn protocol
  // (worker) and power-user paths must be byte-exact.
  if (HIDDEN_VERBS.includes(command)) return argv.slice();

  // Only tokenize a single raw-string rest BEFORE the first `--`; keep the `--` and everything after it
  // verbatim (positional data must never be re-interpreted).
  const afterCmd = argv.slice(1);
  const termIdx = afterCmd.indexOf("--");
  const head = termIdx === -1 ? normalizeRest(afterCmd) : afterCmd.slice(0, termIdx);
  const tail = termIdx === -1 ? [] : afterCmd.slice(termIdx);
  return [command, ...head, ...tail];
}
