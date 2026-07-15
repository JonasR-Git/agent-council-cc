// CLI flag REGISTRY — the single source of truth (SSOT) for the council CLI surface.
//
// Stage 2 of the CLI-surface redesign (docs/cli-surface-design.md, Architecture foundation #1). This
// module holds ONE declarative table (`CLI_FLAGS`) plus a set of PURE generators that DERIVE the exact
// inputs the parser + the `.council.yml` `fix:` merge currently hand-write. The whole safety contract of
// this stage is BYTE-IDENTICAL: the generators must reproduce the current parser value/boolean option
// lists (incl. the `--no-<flag>` twins), the FIX_CONFIG_BOOLEANS / FIX_CONFIG_VALUES maps, and the
// FIX_NEGATABLE_FLAGS list — verbatim. Stage 2 adds NO verb/alias/behavior change; it only re-derives the
// current data from the table and proves it matches (tests/cli-registry.test.mjs).
//
// Stage 3 (verb dispatch + aliases) and Stage 4 (consent containment) consume this table; the `aliasOf`
// and per-verb routing fields are reserved here and stay inert (aliasOf:null) until then.

import { parsePause5hOption, parseUsageCeiling } from "./usage-guard.mjs";

// --- shared validators (moved verbatim from council-companion's FIX_CONFIG_VALUES) --------------------
// Each `validate` THROWS on a bad value; the fix-merge wraps that into a fail-loud
// "Invalid .council.yml fix.<key>" error. Behavior is identical to the previous inline validators.
export function fixRequirePositive(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new Error("must be a positive number");
}
function validateGroups(v) {
  if (!["fine", "tier", "lens"].includes(String(v))) throw new Error(`must be one of fine|tier|lens (got: ${v})`);
}
function validateMaxPasses(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 1000) throw new Error("must be between 1 and 1000");
}
function validateBudget(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 2) throw new Error("must be a number >= 2");
}

// The fix-LOOP budget is denominated in AGENT CALLS. A grouped pass reviews up to `maxCells` cells
// (= calls); across `maxPasses` passes the loop can NEVER spend more than maxPasses*maxCells. So the
// budget CEILING is exactly that product (floored at 2000 so a small-pass run keeps headroom) — NOT an
// arbitrary multiple of maxCells. This lets a run keep SMALL passes (fast review→fix cycles + quota
// response) while raising maxPasses for full-repo coverage: budget scales with the passes that can
// actually spend it. The real cost bound stays the usage-ceiling / 5h-pause, not this anti-typo guard.
// The per-file (non-grouped) path has no cell ledger, so it keeps a flat 2000.
export function loopBudgetCeiling({ grouped, maxPasses, maxCells }) {
  if (!grouped) return 2000;
  const mp = Number(maxPasses);
  const mc = Number(maxCells);
  if (!Number.isFinite(mp) || !Number.isFinite(mc) || mp < 1 || mc < 1) return 2000;
  return Math.max(2000, Math.floor(mp) * Math.floor(mc));
}
function validateUsageCeiling(v) { parseUsageCeiling(v); }
function validatePause5h(v) { parsePause5hOption(v); }

// --- the registry -----------------------------------------------------------------------------------
// One entry per flag. Fields:
//   flag          kebab flag name (no leading `--`)
//   type          "value" | "boolean"
//   verbs         command(s) whose parser accepts the flag (Stage 2: every audit flag → ["audit"])
//   block         config block backing the flag ("fix" | null) — the Stage-1 nesting blocks
//   configKey     snake_case key under that block, or null (no config backing)
//   validate      config-value validator (value flags only), or null
//   negatable     true ⇒ a `--no-<flag>` twin is registered (booleans only)
//   negOrder      historical rank in the negation list (only meaningful when negatable) — pins the exact
//                 twin/negatableFlags ordering, which is independent of the display order
//   aliasOf       reserved for Stage 3 (verb/alias layer); always null here
//   mutationClass advisory {none|state-only|working-tree} — recorded, NOT enforced in Stage 2
//   help          one-line description
//
// ORDER MATTERS for the array generators: value entries are listed in the exact current `valueOptions`
// order and boolean entries in the exact current base-`booleanOptions` order, so valueOptionsFor /
// booleanOptionsFor reproduce those arrays by simple in-order filtering. The object generators
// (fixConfigBooleans/fixConfigValues) are order-insensitive (deep-equal on objects ignores key order).
export const CLI_FLAGS = [
  // ---- audit VALUE options (current order) ----
  { flag: "areas", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "restrict analysis to named areas" },
  { flag: "churn-days", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "hotspot churn window in days" },
  { flag: "budget", type: "value", verbs: ["audit"], block: "fix", configKey: "budget", validate: validateBudget, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "max agent-call budget for a run" },
  { flag: "max-units", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "cap the number of hotspot units" },
  { flag: "doc-path", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "output path for the --doc report" },
  { flag: "from", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "findings source for fix" },
  { flag: "min-severity", type: "value", verbs: ["audit"], block: "fix", configKey: "min_severity", validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "minimum severity to act on" },
  { flag: "max-fixes", type: "value", verbs: ["audit"], block: "fix", configKey: "max_fixes", validate: fixRequirePositive, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "cap the number of fixes applied" },
  { flag: "max-passes", type: "value", verbs: ["audit"], block: "fix", configKey: "max_passes", validate: validateMaxPasses, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "cap the fix-loop pass count (1..1000)" },
  { flag: "dry-streak", type: "value", verbs: ["audit"], block: "fix", configKey: "dry_streak", validate: fixRequirePositive, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "consecutive dry passes before stopping" },
  { flag: "sarif-path", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "output path for the --sarif report" },
  { flag: "autonomy", type: "value", verbs: ["audit"], block: "fix", configKey: "autonomy", validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "autonomy tier for fix apply" },
  { flag: "base", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "base branch/ref for diffing" },
  { flag: "retry-limit", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "retry-on-limit attempt cap" },
  { flag: "groups", type: "value", verbs: ["audit"], block: "fix", configKey: "groups", validate: validateGroups, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "review grouping: fine|tier|lens" },
  { flag: "max-cells", type: "value", verbs: ["audit"], block: "fix", configKey: "max_cells", validate: fixRequirePositive, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "cap the coverage-matrix cells" },
  { flag: "skip-seats", type: "value", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "comma-list of seats to skip" },
  { flag: "usage-ceiling", type: "value", verbs: ["audit"], block: "fix", configKey: "usage_ceiling", validate: validateUsageCeiling, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "per-model usage ceiling (e.g. 40/50/40)" },
  { flag: "pause-at-5h", type: "value", verbs: ["audit"], block: "fix", configKey: "pause_at_5h", validate: validatePause5h, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "pause when a 5h window nears its cap" },

  // ---- audit BOOLEAN options (current base order) ----
  { flag: "json", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "machine-readable JSON output" },
  { flag: "write-map", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "write the coverage map artifact" },
  { flag: "doc", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "write the audit doc report" },
  { flag: "dry-run", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "none", help: "propose only; never write code" },
  { flag: "resume", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "resume a paused/checkpointed run" },
  { flag: "sarif", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "emit a SARIF report" },
  { flag: "loop", type: "boolean", verbs: ["audit"], block: "fix", configKey: "loop", validate: null, negatable: true, negOrder: 2, aliasOf: null, mutationClass: "working-tree", help: "endless review+fix loop until dry" },
  { flag: "flat", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: true, negOrder: 5, aliasOf: null, mutationClass: "none", help: "flat (non-per-tier) review; inverse of per_tier config" },
  { flag: "html", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "emit an HTML report" },
  { flag: "retry-on-limit", type: "boolean", verbs: ["audit"], block: "fix", configKey: "retry_on_limit", validate: null, negatable: true, negOrder: 8, aliasOf: null, mutationClass: "none", help: "retry when a rate limit is hit" },
  // Stage 4 (Appendix D — consent containment): the two auto-apply consents are DELIBERATELY NOT
  // fix-config-backed (block:null/configKey:null). They spread with the tracked tree, so a tracked
  // `.council.yml` consent is IGNORED + warned; consent is resolved ONLY from a gitignored
  // `.council.local.yml` / env COUNCIL_TRUST_FIX + fingerprint + per-clone ack (lib/consent.mjs), or a
  // per-invocation `--<consent>` flag. The FLAGS stay registered (type:boolean, negatable) so `--<consent>`
  // and `--no-<consent>` still parse — only the CONFIG binding is removed.
  { flag: "sensitive-auto-apply", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: true, negOrder: 7, aliasOf: null, mutationClass: "working-tree", help: "auto-apply sensitive fixes (consent; Stage 4: .council.local.yml + ack, not tracked config)" },
  { flag: "structure-auto-apply", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: true, negOrder: 6, aliasOf: null, mutationClass: "working-tree", help: "auto-apply structure fixes (consent; Stage 4: .council.local.yml + ack, not tracked config)" },
  // Stage 4: record a per-clone auto-apply consent acknowledgment in the STATE dir (never the repo).
  { flag: "acknowledge-consents", type: "boolean", verbs: ["audit"], block: null, configKey: null, validate: null, negatable: false, negOrder: null, aliasOf: null, mutationClass: "state-only", help: "record this clone's consent acknowledgment (enables .council.local.yml / env consents here)" },
  { flag: "supervise", type: "boolean", verbs: ["audit"], block: "fix", configKey: "supervise", validate: null, negatable: true, negOrder: 4, aliasOf: null, mutationClass: "none", help: "run under the supervisor" },
  { flag: "completeness-critic", type: "boolean", verbs: ["audit"], block: "fix", configKey: "completeness_critic", validate: null, negatable: true, negOrder: 11, aliasOf: null, mutationClass: "none", help: "add the completeness critic pass" },
  { flag: "skip-openrouter", type: "boolean", verbs: ["audit"], block: "fix", configKey: "skip_openrouter", validate: null, negatable: true, negOrder: 10, aliasOf: null, mutationClass: "none", help: "skip the OpenRouter seat" },
  { flag: "chartest", type: "boolean", verbs: ["audit"], block: "fix", configKey: "chartest", validate: null, negatable: true, negOrder: 9, aliasOf: null, mutationClass: "none", help: "enable the characterization-test gate" },
  { flag: "deep", type: "boolean", verbs: ["audit"], block: "fix", configKey: "deep", validate: null, negatable: true, negOrder: 1, aliasOf: null, mutationClass: "none", help: "maximum analysis depth preset" },
  { flag: "epoch-sweep", type: "boolean", verbs: ["audit"], block: "fix", configKey: "epoch_sweep", validate: null, negatable: true, negOrder: 3, aliasOf: null, mutationClass: "working-tree", help: "per-epoch tier re-sweep in the fix loop" }
];

// --- pure generators (the registry DRIVES parsing + the fix-config merge) ----------------------------

/** The string[] of value-option names accepted by `command` (in registry/display order). */
export function valueOptionsFor(command) {
  return CLI_FLAGS.filter((e) => e.type === "value" && e.verbs.includes(command)).map((e) => e.flag);
}

/**
 * The list of negatable base-flag names for `command` (or all commands when omitted), ordered by their
 * historical negation rank (negOrder). This pins the EXACT order the current FIX_NEGATABLE_FLAGS uses,
 * which is independent of the boolean display order. applyNoFlagNegations consumes this list.
 */
export function negatableFlags(command = null) {
  return CLI_FLAGS
    .filter((e) => e.negatable && (command == null || e.verbs.includes(command)))
    .sort((a, b) => a.negOrder - b.negOrder)
    .map((e) => e.flag);
}

/**
 * The string[] of boolean-option names accepted by `command` — the base booleans (display order)
 * followed by the `--no-<flag>` twins for the negatable ones (in negatableFlags order). Reproduces the
 * current hand-written booleanOptions array byte-for-byte.
 */
export function booleanOptionsFor(command) {
  const base = CLI_FLAGS.filter((e) => e.type === "boolean" && e.verbs.includes(command)).map((e) => e.flag);
  const twins = negatableFlags(command).map((f) => `no-${f}`);
  return [...base, ...twins];
}

/**
 * The `.council.yml` `fix:` boolean map: { snake_case configKey → kebab option key } for every boolean
 * flag backed by the fix block. Order-insensitive (object). Reproduces FIX_CONFIG_BOOLEANS.
 */
export function fixConfigBooleans() {
  const out = {};
  for (const e of CLI_FLAGS) {
    if (e.type === "boolean" && e.block === "fix" && e.configKey) out[e.configKey] = e.flag;
  }
  return out;
}

/**
 * The `.council.yml` `fix:` value map: { snake_case configKey → { opt: kebab option key, validate } }
 * for every value flag backed by the fix block. Reproduces FIX_CONFIG_VALUES (same opt targets + the
 * same validator behavior).
 */
export function fixConfigValues() {
  const out = {};
  for (const e of CLI_FLAGS) {
    if (e.type === "value" && e.block === "fix" && e.configKey) out[e.configKey] = { opt: e.flag, validate: e.validate };
  }
  return out;
}
