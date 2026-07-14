// PURE alias-expansion layer for the council CLI surface redesign (Stage 3).
//
// docs/cli-surface-design.md, Appendix B: every OLD command/flag keeps working by normalizing it to
// the 7 canonical verbs (review, fix, plan, build, solve, status, setup) + hidden verbs (worker,
// worktree, benchmark). `expandAliases(argv)` is the single, table-driven, SIDE-EFFECT-FREE rewrite:
// old argv → canonical argv. It never deletes a capability (aliases only) and is IDEMPOTENT (feeding
// it an already-canonical argv is a no-op). The one-line deprecation note is emitted SEPARATELY by
// `emitAliasNotes` (to stderr, deduped) so `expandAliases` itself stays pure and trivially testable.
//
// Backward-compat is the whole contract: `expandAliases(old)` must equal the documented canonical argv
// for EVERY Appendix-B row (pinned by tests/cli-aliases.test.mjs). The dispatch (lib/cli-dispatch.mjs)
// consumes the canonical argv (plus the injected review-mode meta) and routes it to the EXISTING
// handlers unchanged.

import { splitRawArgumentString } from "./args.mjs";
import { valueOptionsFor } from "./cli-registry.mjs";

// The 7 canonical, user-facing verbs (docs/cli-surface-design.md §"The 7 user-facing verbs").
export const CANONICAL_VERBS = ["review", "fix", "plan", "build", "solve", "status", "setup"];

// Hidden/internal verbs — kept callable by their old names, NOT shown in top-level --help. `worker`
// MUST NOT be renamed (the background-job spawn protocol depends on it). They pass through COMPLETELY
// RAW (see expandAliases) so a single space-containing token (JSON payload / Windows path) survives.
export const HIDDEN_VERBS = ["worker", "worktree", "benchmark"];

// Single-token COMMAND aliases (Appendix B). Each maps the old first-positional to a canonical verb
// plus zero-or-more flag tokens PREPENDED before the remaining argv. `deliberate`/`adversarial` carry
// their mode via `--mode`; the dispatch reads that INJECTED mode (returned as `aliasMode`) back into
// handleReview's alias param, which preserves the existing "a --mode disagreeing with the alias
// conflicts" contract while two EXPLICIT user modes resolve last-wins.
export const COMMAND_ALIASES = {
  deliberate: { verb: "review", flags: ["--mode", "deliberate"] },
  deliberation: { verb: "review", flags: ["--mode", "deliberate"] },
  adversarial: { verb: "review", flags: ["--mode", "adversarial"] },
  "adversarial-review": { verb: "review", flags: ["--mode", "adversarial"] },
  result: { verb: "status", flags: ["--result"] },
  watch: { verb: "status", flags: ["--watch"] },
  wait: { verb: "status", flags: ["--wait"] },
  cancel: { verb: "status", flags: ["--cancel"] },
  "fixloop-status": { verb: "status", flags: ["--fixloop"] },
  overview: { verb: "status", flags: ["--overview"] },
  history: { verb: "status", flags: ["--history"] },
  metrics: { verb: "status", flags: ["--metrics"] },
  usage: { verb: "status", flags: ["--usage"] },
  ledger: { verb: "status", flags: ["--ledger"] },
  doctor: { verb: "setup", flags: ["--check"] }
};

// Two-token `audit <sub>` aliases (Appendix B). The mode NAME differs from the audit SUBCOMMAND on
// purpose: `audit review` (grouped hotspot review engine) → `review --mode deep`; `audit run`
// (risk-register + gate engine) → `review --mode run`; these are DISTINCT engines and the dispatch
// routes `--mode deep` vs `--mode run` to the distinct handleAudit "review" vs "run" branches.
export const AUDIT_SUBCOMMAND_ALIASES = {
  run: { verb: "review", flags: ["--mode", "run"] },
  review: { verb: "review", flags: ["--mode", "deep"] },
  endless: { verb: "review", flags: ["--mode", "endless"] },
  fix: { verb: "fix", flags: [] }
};

// FLAG aliases applied ONLY to the bare `review` verb family. Stage 3 only rewrites flag spellings whose
// destination is ALREADY accepted by the target handler (byte-identical guarantee). `--adversarial` /
// `--deliberate` → `--mode <x>` is additive (those bare flags were previously unknown-flag errors) and is
// scoped to review so it never mangles `plan --deliberate` etc. The design's OTHER flag aliases
// (`--flat`→`--no-per-tier`, `--html`→`--format html`, `--follow`→`--watch`, `--max-units`→`--max-cells`,
// per-model→`--model <seat>=<id>`) target the FUTURE unified flag parser and are DEFERRED (their
// destination flags are not yet parsed; rewriting them would break byte-identical behavior) — see
// docs/cli-surface-design.md Appendix B.
export const FLAG_ALIASES = {
  "--adversarial": ["--mode", "adversarial"],
  "--deliberate": ["--mode", "deliberate"]
};

const AUDIT_VALUE_OPTS = new Set(valueOptionsFor("audit"));

// The mode value a command alias injects (`--mode <x>`), or null.
function injectedModeOf(flags) {
  const i = flags.indexOf("--mode");
  return i !== -1 && flags[i + 1] != null ? flags[i + 1] : null;
}

// Whether `tok` is an option flag (leading `-`, but not a bare `-`). `--` is handled separately.
function isOption(tok) {
  return typeof tok === "string" && tok.startsWith("-") && tok !== "-";
}

// Resolve the audit SUBCOMMAND as the FIRST NON-OPTION token in `head`, skipping option flags AND (for
// registry value-options like `--from`) their following value — so `audit --from findings.json fix`,
// `audit --json fix`, `audit --loop fix` all resolve `fix`, exactly as parseArgs → positionals[0] does.
function firstAuditSubcommand(head) {
  for (let i = 0; i < head.length; i += 1) {
    const t = head[i];
    if (isOption(t)) {
      const name = t.startsWith("--") ? t.slice(2) : t.slice(1);
      const hasInline = name.includes("=");
      const bare = hasInline ? name.slice(0, name.indexOf("=")) : name;
      if (AUDIT_VALUE_OPTS.has(bare) && !hasInline) i += 1; // this flag consumes the next token as its value
      continue;
    }
    return { token: t, index: i };
  }
  return { token: null, index: -1 };
}

// Match the per-handler normalizeArgv convention: a single raw argument string (the slash-command path
// passes "$ARGUMENTS" as one token) is tokenized so a prepended alias flag can't merge into it. Only
// applies when there is NO `--` terminator (a terminated argv is already multi-token).
function normalizeRest(rest) {
  return rest.length === 1 ? splitRawArgumentString(rest[0]) : rest.slice();
}

// Rewrite recognized flag-alias TOKENS (index 0 is the command; stops at the `--` terminator so
// positional data after `--` is preserved verbatim).
function applyFlagAliases(tokens) {
  if (tokens.length <= 1) return tokens;
  const out = [tokens[0]];
  let terminated = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--") terminated = true;
    if (!terminated && Object.prototype.hasOwnProperty.call(FLAG_ALIASES, tok)) out.push(...FLAG_ALIASES[tok]);
    else out.push(tok);
  }
  return out;
}

/**
 * PURE core: old argv → { argv: canonical argv, aliasMode }. `aliasMode` is the review mode a COMMAND
 * alias injected ("deliberate"|"adversarial"|"deep"|"run"|"endless") or null — the dispatch uses it to
 * (a) preserve the deliberate/adversarial conflict and (b) distinguish an injected mode from an explicit
 * user `--mode`. Everything AFTER a `--` terminator is preserved verbatim (no alias scanning).
 */
export function expandAliasesWithMeta(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { argv: [], aliasMode: null };
  const command = argv[0];

  // B: hidden/internal verbs pass through COMPLETELY RAW — no normalizeRest, no command/flag alias, no
  // `--` handling. The spawn protocol (worker) and power-user paths must be byte-exact.
  if (HIDDEN_VERBS.includes(command)) return { argv: argv.slice(), aliasMode: null };

  // C: only scan/rewrite tokens BEFORE the first `--`; keep the `--` and everything after it verbatim.
  const afterCmd = argv.slice(1);
  const termIdx = afterCmd.indexOf("--");
  const head = termIdx === -1 ? normalizeRest(afterCmd) : afterCmd.slice(0, termIdx);
  const tail = termIdx === -1 ? [] : afterCmd.slice(termIdx);

  let verb = command;
  let injectedFlags = [];
  let remaining = head;
  let aliasMode = null;

  if (command === "audit") {
    const { token: sub, index } = firstAuditSubcommand(head);
    const mapping = sub != null ? AUDIT_SUBCOMMAND_ALIASES[sub] : undefined;
    if (mapping) {
      verb = mapping.verb;
      injectedFlags = mapping.flags;
      remaining = [...head.slice(0, index), ...head.slice(index + 1)]; // drop the subcommand token; keep flags in place
      aliasMode = injectedModeOf(mapping.flags);
    } else {
      verb = "audit"; // bare `audit` / `audit <unknown>` — left for the handler (not mangled)
    }
  } else if (Object.prototype.hasOwnProperty.call(COMMAND_ALIASES, command)) {
    const m = COMMAND_ALIASES[command];
    verb = m.verb;
    injectedFlags = m.flags;
    aliasMode = injectedModeOf(m.flags);
  }

  let out = [verb, ...injectedFlags, ...remaining];
  // G: flag aliases apply ONLY to the bare `review` verb with no injected command-alias mode.
  if (verb === "review" && aliasMode == null) out = applyFlagAliases(out);
  return { argv: [...out, ...tail], aliasMode };
}

/**
 * PURE: old argv → canonical argv. Returns a NEW array; never mutates the input; no side effects.
 * IDEMPOTENT: an already-canonical argv expands to itself.
 */
export function expandAliases(argv) {
  return expandAliasesWithMeta(argv).argv;
}

/**
 * PURE: the human-readable deprecation notes an old argv would trigger (one per deprecated spelling
 * ACTUALLY used). Empty for a fully-canonical argv. `emitAliasNotes` deduplicates + prints to stderr.
 */
export function aliasDeprecationNotes(argv) {
  const notes = [];
  if (!Array.isArray(argv) || argv.length === 0) return notes;
  const command = argv[0];
  if (HIDDEN_VERBS.includes(command)) return notes; // raw passthrough: nothing deprecated

  const afterCmd = argv.slice(1);
  const termIdx = afterCmd.indexOf("--");
  const head = termIdx === -1 ? normalizeRest(afterCmd) : afterCmd.slice(0, termIdx);

  if (command === "audit") {
    const { token: sub } = firstAuditSubcommand(head);
    if (sub != null && Object.prototype.hasOwnProperty.call(AUDIT_SUBCOMMAND_ALIASES, sub)) {
      const m = AUDIT_SUBCOMMAND_ALIASES[sub];
      notes.push(`note: \`audit ${sub}\` is now \`${[m.verb, ...m.flags].join(" ")}\` (old name still works)`);
    }
  } else if (Object.prototype.hasOwnProperty.call(COMMAND_ALIASES, command)) {
    const m = COMMAND_ALIASES[command];
    notes.push(`note: \`${command}\` is now \`${[m.verb, ...m.flags].join(" ")}\` (old name still works)`);
  }
  // Flag aliases only fire for the bare `review` verb (where they're actually applied), before `--`.
  if (command === "review") {
    for (const tok of head) {
      if (tok === "--") break;
      if (Object.prototype.hasOwnProperty.call(FLAG_ALIASES, tok)) {
        notes.push(`note: \`${tok}\` is now \`${FLAG_ALIASES[tok].join(" ")}\` (old spelling still works)`);
      }
    }
  }
  return notes;
}

// Deduped, per-process. Notes go to STDERR only — never stdout — so `--json` stdout stays pure.
const _emittedNotes = new Set();

/** Emit each not-yet-seen deprecation note for `argv` once, to stderr. Side-effecting; deduped. */
export function emitAliasNotes(argv, { stream = process.stderr } = {}) {
  for (const note of aliasDeprecationNotes(argv)) {
    if (_emittedNotes.has(note)) continue;
    _emittedNotes.add(note);
    stream.write(`${note}\n`);
  }
}

/** Test seam: clear the per-process dedup set so a test can re-observe first-emission behavior. */
export function _resetAliasNotesForTest() {
  _emittedNotes.clear();
}
