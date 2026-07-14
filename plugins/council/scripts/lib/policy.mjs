import fs from "node:fs";
import path from "node:path";

import { workspaceRoot } from "./state.mjs";
import { loadCouncilEnv } from "./dotenv.mjs";

export const DEFAULT_POLICY = {
  version: 1,
  // Schema-version marker for the per-verb config blocks (review:/fix:/plan:/build:/status:/defaults:).
  // Parsed from the file if present (see loadPolicy), defaults to 1. No behavior change today — it is a
  // forward-compat hook so a future schema bump can migrate/validate without a silent misread.
  config_version: 1,
  codex_model: null,
  grok_model: null,
  codex_effort: null,
  grok_effort: null,
  default_mode: "review", // review | deliberate
  base: null,
  scope: "auto",
  focus: "",
  require_consensus_for: [],
  skip_paths: [],
  max_turns_r1: 40,
  max_turns_r2: 25,
  deliberate_peer: true,
  agent_timeout_minutes: 30,
  peer_critique_severities: ["P0", "P1"],
  r2_effort: "medium",
  debate_rounds: 0,
  debate_resume: false,
  solve_writer: "claude",
  budget_guard: 0,
  verify_findings: false,
  reviewers: ["claude", "codex", "grok"],
  claude_backend: "session", // session | spawn
  claude_model: null,
  // OpenRouter multi-model seats (optional). `openrouter_models` is a flat list of "slug" /
  // "id=slug" / "id=slug@effort" strings (parseSimpleYaml can't nest); a nested `openrouter: {…}`
  // object is also accepted from .council.json. SECURITY: the API key is read ONLY from the env var
  // named by openrouter_api_key_env (default OPENROUTER_API_KEY). A literal openrouter_api_key in the
  // policy file is IGNORED for activation — the file is read from the audited (untrusted) repo, so a
  // repo-supplied key must never ship your source to that key's account (council OpenRouter Claude/Grok
  // P1). The field is retained only so a stray value is parsed + warned, not silently honored.
  // openrouter_base_url may point at a LOOPBACK proxy or the openrouter.ai host only; any other remote
  // host disables the backend fail-closed.
  openrouter_models: [],
  openrouter_api_key: null,
  openrouter_api_key_env: "OPENROUTER_API_KEY",
  openrouter_base_url: null
};

/**
 * Minimal YAML subset parser for our policy keys.
 * Supports: key: value, key: | multiline, key: with [a, b], and - list items.
 */
export function parseSimpleYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const obj = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }

    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    let val = stripInlineComment(m[2].trimEnd()).trim();

    if (val === "|" || val === ">") {
      const block = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i];
        if (l === "" || /^\s/.test(l) || l.startsWith("  ")) {
          block.push(l.replace(/^\s{2}/, ""));
          i += 1;
          continue;
        }
        if (/^[A-Za-z0-9_]+:/.test(l) || l.trim().startsWith("- ")) break;
        break;
      }
      obj[key] = block.join("\n").trim();
      continue;
    }

    if (val === "" || val === null) {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        const lm = l.match(/^\s*-\s+(.*)$/);
        if (!lm) break;
        const item = stripInlineComment(lm[1].trimEnd()).trim();
        list.push(stripQuotes(item));
        j += 1;
      }
      if (list.length) {
        obj[key] = list;
        i = j;
        continue;
      }
      obj[key] = "";
      i += 1;
      continue;
    }

    if (val.startsWith("[") && val.endsWith("]")) {
      obj[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(stripInlineComment(s.trimEnd()).trim()))
        .filter(Boolean);
      i += 1;
      continue;
    }

    obj[key] = coerceScalar(stripQuotes(val.trim()));
    i += 1;
  }

  return obj;
}

/**
 * The one-level-nested config blocks the redesign recognizes. Each is a MAP of scalar `key: value`
 * children under a top-level `<block>:` header. `parseSimpleYaml` is FLAT (it silently drops these
 * indented children and leaves a stray "" for the bare header), so `parseVerbBlocks` recovers them.
 */
export const KNOWN_BLOCKS = ["review", "fix", "plan", "build", "status", "defaults"];

/**
 * Recognized child keys per block — the source of truth for the LOUD unknown-key warnings (a typo
 * like `epoch_sweeps:` must WARN, never silently no-op). Membership follows the frozen CLI-surface
 * design (docs/cli-surface-design.md: the config schema + Appendix A CONFIG lists + Appendix C's HARD
 * `defaults:` whitelist). `fix` mirrors council-companion's FIX_CONFIG_* maps exactly so the repo's
 * own tracked `.council.yml` warns on nothing. Unknown keys are WARNED but still parsed into the
 * block object (forward-compat, non-destructive) — the consumer decides what it acts on.
 */
export const KNOWN_BLOCK_KEYS = {
  // Appendix A `review:` CONFIG: default mode/scope, groups/max_cells (deep/endless), areas, churn_days.
  review: new Set(["default_mode", "scope", "groups", "max_cells", "areas", "churn_days"]),
  // Mirrors council-companion FIX_CONFIG_BOOLEANS + per_tier/flat + FIX_CONFIG_VALUES.
  fix: new Set([
    "loop", "deep", "epoch_sweep", "supervise", "structure_auto_apply", "sensitive_auto_apply",
    "retry_on_limit", "chartest", "completeness_critic", "skip_openrouter", "per_tier", "flat",
    "autonomy", "min_severity", "groups", "max_fixes", "max_passes", "dry_streak", "max_cells",
    "budget", "usage_ceiling", "pause_at_5h"
  ]),
  // Appendix A `plan:` CONFIG: synthesizer, seats.
  plan: new Set(["synthesizer", "seats"]),
  // Appendix A `build:` CONFIG: budgets/timeouts ONLY — never a skip-gate/auto-merge key.
  build: new Set(["budget", "timeout", "timeout_minutes"]),
  // Config schema example `status: { interval: 2 }` (Appendix A: otherwise no config).
  status: new Set(["interval"]),
  // Appendix C HARD whitelist: budget, groups, max_cells ONLY.
  defaults: new Set(["budget", "groups", "max_cells"])
};

/**
 * Recover EVERY one-level-nested known block (review/fix/plan/build/status/defaults) from raw YAML
 * text into a `{ <block>: { key: value, … } }` map. BOUNDED by design: exactly ONE level of nesting
 * under a recognized top-level header — a `<block>:` line with an EMPTY value (only an optional inline
 * comment) followed by INDENTED `key: value` scalar children. Not arbitrary-depth YAML: a nested map
 * or list under a child ENDS the block (a child line that isn't `<indent>key: scalar` breaks it), and
 * deeper indentation is not descended into. Values are coerced like any scalar (true/false/number/
 * string) via the shared stripInlineComment/stripQuotes/coerceScalar helpers. A childless block is
 * OMITTED from the result (its key stays absent) so an empty `build:` behaves like no block at all.
 * First header wins per block name (matches the historical single-`fix:` extractor's first-return).
 * Zero-dep, single pass.
 */
export function parseVerbBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = {};
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    // A top-level block header: no leading whitespace, a known name, empty value (only a comment).
    const header = lines[i].match(/^([A-Za-z0-9_]+):\s*(#.*)?$/);
    if (!header) continue;
    const name = header[1];
    if (!KNOWN_BLOCKS.includes(name) || seen.has(name)) continue;
    seen.add(name); // first header for a given block wins (byte-compatible with the old fix: extractor)
    const out = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim() || l.trim().startsWith("#")) continue; // blank / comment line inside the block
      if (!/^\s/.test(l)) break; // a non-indented, non-blank line ends the block
      const m = l.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) break; // a list item or non-scalar child ends the block (bounded: no deeper nesting)
      const val = stripInlineComment(m[2].trimEnd()).trim();
      out[m[1]] = coerceScalar(stripQuotes(val));
    }
    if (Object.keys(out).length) blocks[name] = out;
  }
  return blocks;
}

/**
 * Collect LOUD unknown-key warnings for the recovered blocks: any child key not in that block's
 * KNOWN_BLOCK_KEYS set (a typo like `fix.epoch_sweeps` or a non-whitelisted `defaults.loop`). Returns
 * a string[] (empty when clean) so callers can PRINT to stderr AND surface programmatically (loadPolicy
 * attaches them as `_warnings`; `setup --check`/doctor include them in its report). Never throws.
 */
export function verbBlockWarnings(blocks, source = ".council.yml") {
  const warnings = [];
  for (const name of KNOWN_BLOCKS) {
    const obj = blocks[name];
    if (!obj) continue;
    const known = KNOWN_BLOCK_KEYS[name];
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) {
        warnings.push(`Warning: ${source} ${name}.${key} is not a recognized ${name}: key (ignored - check for a typo).`);
      }
    }
  }
  return warnings;
}

/**
 * The auto-apply consent keys that MUST NOT be honored from the TRACKED `.council.yml` (Stage 4 / Appendix
 * D): they spread to clones/forks/PR-checkouts and make a bare `fix` auto-apply WRITE with no consent from
 * THAT operator. If a tracked `fix:` block still carries either key, emit a LOUD warning (kept in
 * KNOWN_BLOCK_KEYS so the generic "unrecognized key" warning does NOT also fire — this is the specific,
 * actionable message). Consents are resolved ONLY from a gitignored `.council.local.yml` / env +
 * fingerprint + per-clone ack (see lib/consent.mjs). Returns a string[] (empty when clean).
 */
export function trackedConsentWarnings(fixBlock, source = ".council.yml") {
  if (!fixBlock || typeof fixBlock !== "object" || Array.isArray(fixBlock)) return [];
  const warnings = [];
  for (const key of ["structure_auto_apply", "sensitive_auto_apply"]) {
    if (key in fixBlock) {
      warnings.push(
        `Warning: ${source} fix.${key} is IGNORED for consent — auto-apply consents no longer come from the ` +
          "tracked config (they spread to clones/forks/PR-checkouts). Move it to a gitignored .council.local.yml " +
          "with a matching trust_fingerprint, then run `fix --acknowledge-consents` once. See Appendix D."
      );
    }
  }
  return warnings;
}

/**
 * Parse an optional nested `fix:` block from raw YAML text into a plain object. Thin delegate over the
 * generalized parseVerbBlocks (a top-level `fix:` header + INDENTED scalar children). Returns null when
 * there is no `fix:` block with children ⇒ `policy.fix` stays undefined ⇒ a bare `audit fix` behaves
 * BYTE-IDENTICAL to having no config. Kept as a named export so existing callers/tests are unchanged.
 */
export function parseFixBlock(text) {
  return parseVerbBlocks(text).fix ?? null;
}

function stripInlineComment(s) {
  const trimmed = String(s ?? "").trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return s;
  }
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function loadPolicy(cwd) {
  const root = workspaceRoot(cwd);
  // Auto-load a gitignored `.council.env` (local secrets like OPENROUTER_API_KEY) into the environment
  // BEFORE anything reads it — convenience, fail-soft, never overrides an explicit shell export.
  loadCouncilEnv(root);
  const candidates = [
    path.join(root, ".council.yml"),
    path.join(root, ".council.yaml"),
    path.join(root, ".council.json"),
    path.join(root, ".claude", "council.yml"),
    path.join(root, ".claude", "council.json")
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    let parsed;
    let warnings = [];
    if (file.endsWith(".json")) {
      parsed = JSON.parse(text);
    } else {
      parsed = parseSimpleYaml(text);
      // The flat parser can't nest, so recover EVERY one-level-nested known block (review/fix/plan/
      // build/status/defaults) from the raw text. For each recognized block: a present-with-children
      // block replaces the stray "" the flat parser wrote for the bare header; a childless/absent
      // block is DELETED so `block in policy` is false — i.e. a missing verb block leaves resolution
      // BYTE-IDENTICAL to today (this is Stage 1's whole safety contract). `policy.fix` is unchanged.
      const blocks = parseVerbBlocks(text);
      for (const name of KNOWN_BLOCKS) {
        if (blocks[name]) parsed[name] = blocks[name];
        else delete parsed[name];
      }
      // LOUD unknown-key warnings: a typo like `epoch_sweeps:` must warn, never silently no-op. PLUS the
      // Stage-4 tracked-consent warning (a tracked fix.structure_auto_apply/sensitive_auto_apply is ignored
      // for consent) so both the load-time print AND `setup --check` surface it.
      warnings = [...verbBlockWarnings(blocks, file), ...trackedConsentWarnings(blocks.fix, file)];
    }
    // Emit each warning once per (file, message) per process so a repeated loadPolicy doesn't spam,
    // while the FIRST load stays loud on stderr. Never pollutes stdout (safe under --json).
    for (const w of warnings) emitPolicyWarningOnce(file, w);
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      // `config_version` is parsed from `parsed` if the file set it (parseSimpleYaml already surfaces
      // the top-level scalar); otherwise DEFAULT_POLICY supplies 1. No behavior change today.
      _source: file,
      _root: root,
      // Returned (not only printed) so `setup --check`/doctor can surface the same warnings.
      _warnings: warnings
    };
  }

  return { ...DEFAULT_POLICY, _source: null, _root: root, _warnings: [] };
}

// Per-process de-dupe for policy load warnings: loadPolicy runs many times per command, so a naive
// print would repeat each warning ~15×. Keyed by `${file}\n${message}` → first occurrence prints.
const _printedPolicyWarnings = new Set();
function emitPolicyWarningOnce(file, message) {
  const key = `${file}\n${message}`;
  if (_printedPolicyWarnings.has(key)) return;
  _printedPolicyWarnings.add(key);
  console.error(message);
}

export function mergeOptionsWithPolicy(options, policy) {
  const timeoutMinutes = Number(policy.agent_timeout_minutes ?? DEFAULT_POLICY.agent_timeout_minutes);
  const policyTimeoutMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : null;
  // `reviewers` (policy or flag) says WHO participates; an agent absent from the
  // list is skipped. Explicit --skip-<agent> flags still force-skip on top.
  const reviewers = normalizeReviewers(options.reviewers ?? policy.reviewers ?? DEFAULT_POLICY.reviewers);
  const reviewerSet = new Set(reviewers);
  return {
    ...options,
    adversarial: Boolean(options.adversarial),
    deliberate: Boolean(options.deliberate),
    reviewers,
    skipCodex: Boolean(options.skipCodex) || !reviewerSet.has("codex"),
    skipGrok: Boolean(options.skipGrok) || !reviewerSet.has("grok"),
    skipClaude: Boolean(options.skipClaude) || !reviewerSet.has("claude"),
    claudeBackend: normalizeClaudeBackend(options.claudeBackend ?? policy.claude_backend),
    claudeModel: options.claudeModel ?? policy.claude_model ?? null,
    claudeFindingsPath: options.claudeFindingsPath ?? null,
    claudeFindingsWaitPath: options.claudeFindingsWaitPath ?? null,
    waitTimeoutMs: options.waitTimeoutMs ?? null,
    agentTimeoutMs: options.agentTimeoutMs ?? policyTimeoutMs,
    base: options.base ?? policy.base ?? undefined,
    scope: options.scope ?? policy.scope ?? "auto",
    codexModel: options.codexModel ?? options["codex-model"] ?? policy.codex_model ?? options.model,
    grokModel: options.grokModel ?? options["grok-model"] ?? policy.grok_model ?? options.model,
    codexEffort: options.codexEffort ?? options["codex-effort"] ?? policy.codex_effort,
    grokEffort: options.grokEffort ?? options["grok-effort"] ?? policy.grok_effort,
    focusText:
      (options.focusText && String(options.focusText).trim()) ||
      (policy.focus ? String(policy.focus).trim() : ""),
    maxTurnsR1: options.maxTurnsR1 ?? policy.max_turns_r1 ?? 40,
    maxTurnsR2: options.maxTurnsR2 ?? policy.max_turns_r2 ?? 25,
    deliberatePeer: options.deliberatePeer ?? policy.deliberate_peer !== false,
    // A SCALAR YAML value (`require_consensus_for: security`) instead of a list must not crash the
    // later `.map` in applyConsensusPolicy / normalizeSkipPaths — coerce a bare scalar to a 1-element list.
    requireConsensusFor: asArray(options.requireConsensusFor ?? policy.require_consensus_for),
    skipPaths: asArray(options.skipPaths ?? policy.skip_paths),
    peerCritiqueSeverities: normalizeSeverityList(
      options.peerCritiqueSeverities ?? policy.peer_critique_severities ?? DEFAULT_POLICY.peer_critique_severities
    ),
    r2Effort: options.r2Effort ?? policy.r2_effort ?? DEFAULT_POLICY.r2_effort,
    debateRounds: clampDebateRounds(options.debateRounds ?? policy.debate_rounds ?? 0),
    debateResume: options.debateResume ?? policy.debate_resume === true,
    solveWriter: options.solveWriter ?? policy.solve_writer ?? "claude",
    budgetGuard: clampPercent(options.budgetGuard ?? policy.budget_guard ?? 0),
    forceBudget: options.forceBudget ?? false,
    resume: options.resume ?? false,
    verifyFindings: options.verifyFindings ?? policy.verify_findings === true,
    // OpenRouter seats — resolved to NON-SECRET options ONLY (council OpenRouter Grok P1): the API key
    // is DELIBERATELY NOT put here. `merged` is spread widely and could be logged, so the key is passed
    // TRANSIENTLY to openRouterBackend by the caller (council-companion), which registers it in module
    // scope. Only the non-secret model list / key-ENV-name / base-url / skip flag live on options.
    openrouterModels: options.openrouterModels ?? policy.openrouter?.models ?? policy.openrouter_models ?? [],
    openrouterApiKeyEnv: options.openrouterApiKeyEnv ?? policy.openrouter?.apiKeyEnv ?? policy.openrouter_api_key_env ?? "OPENROUTER_API_KEY",
    openrouterBaseUrl: options.openrouterBaseUrl ?? policy.openrouter?.baseUrl ?? policy.openrouter_base_url ?? null,
    // Read BOTH the camelCase (programmatic) and the kebab CLI flag (council Codex/Claude P1): parseArgs
    // stores --skip-openrouter under its kebab name WITHOUT camelCasing, so reading only options.skipOpenRouter
    // left the flag inert — the documented kebab-not-converted trap (cf. retry-on-limit). A policy
    // `skip_openrouter: true` also opts out. skipSeats is a per-seat id list from the same sources.
    skipOpenRouter: Boolean(options.skipOpenRouter ?? options["skip-openrouter"] ?? policy.skip_openrouter),
    skipSeats: normalizeStringList(options.skipSeats ?? options["skip-seats"] ?? policy.skip_seats),
    policySource: policy._source
  };
}

/** Coerce a maybe-scalar list field to an array: an array as-is, null/undefined to [], any other
 *  scalar (a YAML string/number written where a list was expected) to a 1-element list. */
function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

/** Normalize a seat-id skip list to a string[]: an array as-is, a comma string split, else []. Keeps
 *  seatActive/attachOpenRouterSeats' `.includes(id)` correct (a raw string would match char-wise). */
function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

const VALID_REVIEWERS = new Set(["claude", "codex", "grok"]);

/**
 * Agents excluded from a run, derived from skip flags. `includeClaude` also
 * honors skipClaude - pass it with the resolved/merged options (the raw R1/R2
 * verify paths only ever skip codex/grok, since Claude there is the orchestrator).
 */
export function skippedAgents(options, { includeClaude = false } = {}) {
  return [
    options.skipCodex ? "codex" : null,
    options.skipGrok ? "grok" : null,
    includeClaude && options.skipClaude ? "claude" : null
  ].filter(Boolean);
}

export function normalizeReviewers(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const normalized = list.map((s) => String(s).trim().toLowerCase()).filter((s) => VALID_REVIEWERS.has(s));
  return normalized.length ? [...new Set(normalized)] : ["claude", "codex", "grok"];
}

/**
 * Tokens the caller passed that are NOT valid reviewers. Lets the CLI warn on a
 * typo (`--reviewers gork`) instead of silently falling back to all three -
 * running MORE reviewers than intended is the opposite of the user's intent.
 * Returns [] for empty/null input (the legitimate "use defaults" case).
 */
export function unknownReviewers(value) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list
    .map((s) => String(s).trim())
    .filter((s) => s && !VALID_REVIEWERS.has(s.toLowerCase()));
}

/** session | spawn, case-insensitive; anything else degrades to the safe session backend. */
export function normalizeClaudeBackend(value) {
  return String(value ?? "").trim().toLowerCase() === "spawn" ? "spawn" : "session";
}

function normalizeSeverityList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  // "all" (or an explicit empty policy list) means: critique every finding.
  if (Array.isArray(value) && value.length === 0) return [];
  if (list.some((s) => String(s).trim().toLowerCase() === "all")) return [];
  const valid = new Set(["P0", "P1", "P2", "nit"]);
  const normalized = list
    .map((s) => {
      const token = String(s).trim();
      return token.toLowerCase() === "nit" ? "nit" : token.toUpperCase();
    })
    .filter((s) => valid.has(s));
  return normalized.length ? normalized : ["P0", "P1"];
}

function clampDebateRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 2);
}
