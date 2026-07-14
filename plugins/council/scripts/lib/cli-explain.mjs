// `--explain` — the silent-behavior-change defense, resolver side (docs/cli-surface-design.md, Stage 6).
//
// `--explain` RESOLVES a verb's effective options WITHOUT running it: no review/fix/build work, no writes,
// no model calls. It prints every effective knob with its SOURCE (flag / config / built-in / a consent's
// precise trust-channel source), then exits 0. This module is the ONE resolution source it uses — it
// reuses the SAME registry maps the parser/fix-merge use (lib/cli-registry.mjs), the SAME consent
// resolver the fix banner uses (lib/consent.mjs), and the SAME per-verb config blocks (lib/policy.mjs),
// so what `--explain` reports is byte-for-byte what a real run would resolve. It never mutates anything:
// resolveConsents/loadPolicy only READ (git remote + fs), and no code writer is imported here at all.
//
// PURITY: the knob builders are pure functions of (parsed options, policy, consent). The dispatcher
// `resolveExplain` wires in the real loadPolicy/resolveConsents by default, but every side-effecting
// dependency (policy, consent, cwd, stateDir) is injectable via `deps` so the whole resolver is testable
// without a git repo or the clock.

import { parseArgs } from "./args.mjs";
import { booleanOptionsFor, fixConfigBooleans, fixConfigValues, negatableFlags, valueOptionsFor } from "./cli-registry.mjs";
import { VERB_MUTATION } from "./cli-mutation.mjs";
import { CONSENTS, CONSENT_CONFIG_KEY, resolveConsents } from "./consent.mjs";
import { loadPolicy } from "./policy.mjs";

/** The precedence chain the design mandates, surfaced verbatim in every --explain payload. */
export const EXPLAIN_PRECEDENCE = "flag > verb-config > built-in  (consents: out-of-tree trust channel only)";

/** The 7 user-facing verbs `--explain` understands (hidden verbs are never explained). */
export const EXPLAINABLE_VERBS = new Set(["review", "fix", "plan", "build", "solve", "status", "setup"]);

/** Whether `verb` supports `--explain`. */
export function isExplainableVerb(verb) {
  return EXPLAINABLE_VERBS.has(verb);
}

// The tokens BEFORE the first `--` terminator (flags after it are positional data, never scanned).
function beforeTerminator(tokens) {
  const i = tokens.indexOf("--");
  return i === -1 ? tokens : tokens.slice(0, i);
}

/** Strip every `--explain` token BEFORE the `--` terminator (it is never a registered verb flag). */
export function stripExplainTokens(args) {
  const list = Array.isArray(args) ? args : [];
  const ti = list.indexOf("--");
  const head = ti === -1 ? list : list.slice(0, ti);
  const tail = ti === -1 ? [] : list.slice(ti);
  return [...head.filter((t) => t !== "--explain"), ...tail];
}

/** Is `--explain` present (before any `--` terminator)? */
export function hasExplainFlag(args) {
  return beforeTerminator(Array.isArray(args) ? args : []).includes("--explain");
}

/** Is `--json` present (before any `--` terminator)? Governs the --explain output shape. */
export function hasJsonFlag(args) {
  return beforeTerminator(Array.isArray(args) ? args : []).includes("--json");
}

// A resolved consent's raw internal source → the label the banner/--explain surface. `null` (no channel)
// maps to "built-in": a consent with no trust channel is simply unset ⇒ the safe propose-only default.
function consentSource(raw) {
  switch (raw) {
    case "flag":
      return "flag";
    case "local":
      return "local,acknowledged";
    case "env":
      return "env,acknowledged";
    case "dry-run":
      return "dry-run";
    case "refused:no-ack":
    case "refused:no-origin":
    case "refused:ignored":
      return raw;
    default:
      return "built-in";
  }
}

// Fold each `--no-<flag>` (parseArgs stored options["no-<flag>"]===true) into an EXPLICIT false on the
// base flag — the SAME tri-state maker council-companion's applyNoFlagNegations uses, so a `--no-loop`
// reads as an explicit flag (source "flag", value false), not an absent knob.
function foldNegations(options) {
  for (const f of negatableFlags("audit")) {
    if (options[`no-${f}`] === true) {
      options[f] = false;
      delete options[`no-${f}`];
    }
  }
  return options;
}

// Parse the fix/audit argv EXACTLY as handleAudit does: the registry-derived option lists + the
// bare-`--usage-ceiling`/`--pause-at-5h` (optional-value) normalization + the `--no-<flag>` fold. The
// leading `fix` positional is ignored (it lands in positionals). Pure — never runs anything.
function parseAuditOptions(args) {
  const stripped = stripExplainTokens(args);
  const pre = stripped.map((tok, i, a) =>
    (tok === "--usage-ceiling" || tok === "--pause-at-5h") && (a[i + 1] == null || String(a[i + 1]).startsWith("-")) ? `${tok}=` : tok
  );
  const { options } = parseArgs(pre, { valueOptions: valueOptionsFor("audit"), booleanOptions: booleanOptionsFor("audit") });
  return foldNegations(options);
}

/**
 * The effective FIX policy: every fix-config knob (registry-derived) + the two auto-apply consents, each
 * with its resolved value + source. PURE: `options` are the parsed CLI options, `policy` a loadPolicy
 * result, `consent` a resolveConsents result. Precedence per knob: explicit flag > `fix:` config block >
 * built-in. Consents come ONLY from the resolveConsents trust channel (never the tracked config).
 */
export function buildFixExplain(options, policy, consent) {
  const fix = policy && typeof policy.fix === "object" && !Array.isArray(policy.fix) ? policy.fix : {};
  const knobs = [];

  for (const [cfgKey, optKey] of Object.entries(fixConfigBooleans())) {
    if (options[optKey] !== undefined) knobs.push({ key: cfgKey, value: options[optKey] === true, source: "flag" });
    else if (cfgKey in fix) knobs.push({ key: cfgKey, value: fix[cfgKey] === true, source: "config" });
    else knobs.push({ key: cfgKey, value: false, source: "built-in" });
  }

  // per_tier: the config-side inverse of the live `--flat` flag (per-tier is the default). Report it as
  // its own knob so a `fix: { per_tier: false }` / `--flat` is inspectable at the config's key name.
  if (options.flat !== undefined) knobs.push({ key: "per_tier", value: options.flat !== true, source: "flag" });
  else if ("flat" in fix) knobs.push({ key: "per_tier", value: fix.flat !== true, source: "config" });
  else if ("per_tier" in fix) knobs.push({ key: "per_tier", value: fix.per_tier === true, source: "config" });
  else knobs.push({ key: "per_tier", value: true, source: "built-in" });

  for (const [cfgKey, spec] of Object.entries(fixConfigValues())) {
    const optKey = spec.opt;
    if (options[optKey] !== undefined) knobs.push({ key: cfgKey, value: options[optKey], source: "flag" });
    else if (cfgKey in fix && fix[cfgKey] != null && fix[cfgKey] !== "") knobs.push({ key: cfgKey, value: fix[cfgKey], source: "config" });
    else knobs.push({ key: cfgKey, value: null, source: "built-in" });
  }

  const sources = consent && consent.sources ? consent.sources : {};
  for (const c of CONSENTS) {
    const on = c === "structure" ? consent?.structureAutoApply === true : consent?.sensitiveAutoApply === true;
    knobs.push({ key: CONSENT_CONFIG_KEY[c], value: on, source: consentSource(sources[c] ?? null), consent: true });
  }

  return {
    verb: "fix",
    mutationClass: VERB_MUTATION.fix,
    precedence: EXPLAIN_PRECEDENCE,
    knobs,
    warnings: consent && Array.isArray(consent.warnings) ? consent.warnings : []
  };
}

/**
 * The effective BUILD policy: the never-negotiable safety invariants (Appendix C — auto-merge must not
 * exist; every step is §6-gated on an isolated branch) + the run inputs + the `build:` budget/timeout
 * config block. PURE. `build` has NO auto-apply consent by design, so no consent knobs appear.
 */
export function buildBuildExplain(options, policy) {
  const block = policy && typeof policy.build === "object" && !Array.isArray(policy.build) ? policy.build : {};
  const knobs = [
    { key: "isolated_branch", value: true, source: "built-in" },
    { key: "six_eyes_gated", value: true, source: "built-in" },
    { key: "auto_merge", value: false, source: "built-in" },
    { key: "dry_run", value: options["dry-run"] === true, source: options["dry-run"] !== undefined ? "flag" : "built-in" },
    { key: "from", value: options.from ?? null, source: options.from !== undefined ? "flag" : "built-in" },
    { key: "base", value: options.base ?? null, source: options.base !== undefined ? "flag" : "built-in" }
  ];
  for (const key of ["budget", "timeout", "timeout_minutes"]) {
    if (key in block) knobs.push({ key, value: block[key], source: "config" });
  }
  return { verb: "build", mutationClass: VERB_MUTATION.build, precedence: EXPLAIN_PRECEDENCE, knobs, warnings: [] };
}

// The lightweight per-verb knob specs for the read-only verbs: config key ⇐ the verb's config block
// (present iff the block exists), overridden by the named override flag, else the built-in default.
const GENERAL_VERB_KNOBS = {
  review: [
    { key: "mode", flag: "mode", configKey: "default_mode", builtin: "quick" },
    { key: "scope", flag: "scope", builtin: "auto" },
    { key: "groups", flag: "groups", builtin: null },
    { key: "max_cells", flag: "max-cells", builtin: null },
    { key: "areas", flag: "areas", builtin: null },
    { key: "churn_days", flag: "churn-days", builtin: null }
  ],
  plan: [{ key: "synthesizer", flag: "synthesizer", builtin: "claude" }],
  solve: [{ key: "debate_rounds", flag: "debate-rounds", builtin: 0 }],
  status: [{ key: "interval", flag: "interval", builtin: null }],
  setup: []
};

// Detect an explicit `--<flag>` / `--<flag>=v` / `--<flag> v` BEFORE the `--` terminator. Returns
// { present, value } — value flags read the next token; used only to mark source "flag" for the RO verbs.
function detectFlag(args, flag) {
  const head = beforeTerminator(stripExplainTokens(args));
  for (let i = 0; i < head.length; i += 1) {
    const t = head[i];
    if (typeof t !== "string") continue;
    if (t === `--${flag}`) return { present: true, value: head[i + 1] ?? true };
    if (t.startsWith(`--${flag}=`)) return { present: true, value: t.slice(flag.length + 3) };
  }
  return { present: false };
}

/**
 * The effective policy for a read-only verb (review/plan/solve/status/setup): each known knob resolved
 * from an explicit flag > the verb's config block > the built-in default. PURE. Deliberately lightweight
 * — it reports the verb's config-block knobs (the only place "config" can be told apart from a built-in
 * default without re-reading the raw file), never fabricating a source it cannot prove.
 */
export function buildGeneralExplain(verb, args, policy, hints = {}) {
  const block = policy && typeof policy[verb] === "object" && !Array.isArray(policy[verb]) ? policy[verb] : {};
  const knobs = [];
  for (const spec of GENERAL_VERB_KNOBS[verb] ?? []) {
    const cfgKey = spec.configKey ?? spec.key;
    // A mode a command-alias/`--mode` injected is stripped from argv by the dispatch before --explain sees
    // it, so the resolver takes the dispatch's resolved mode (hints.mode) as the explicit-flag source.
    if (spec.key === "mode" && hints.mode) knobs.push({ key: "mode", value: hints.mode, source: "flag" });
    else {
      const det = spec.flag ? detectFlag(args, spec.flag) : { present: false };
      if (det.present) knobs.push({ key: spec.key, value: det.value, source: "flag" });
      else if (cfgKey in block) knobs.push({ key: spec.key, value: block[cfgKey], source: "config" });
      else knobs.push({ key: spec.key, value: spec.builtin ?? null, source: "built-in" });
    }
  }
  return { verb, mutationClass: VERB_MUTATION[verb] ?? null, precedence: EXPLAIN_PRECEDENCE, knobs, warnings: [] };
}

/**
 * Resolve a verb's effective policy for `--explain`, WITHOUT running anything. Returns
 * `{ verb, mutationClass, precedence, knobs:[{key,value,source,consent?}], warnings }`.
 *
 * The real loadPolicy + resolveConsents are wired by default (both READ-ONLY); every dependency is
 * injectable via `deps` (`policy`, `consent`, `loadPolicy`, `resolveConsents`, `consentDeps`) so the
 * resolver is fully testable without a git repo. It imports NO code writer — it cannot mutate the tree.
 */
export function resolveExplain({ verb, args = [], cwd = process.cwd(), stateDir = null, hints = {}, deps = {} } = {}) {
  const loadPolicyFn = deps.loadPolicy ?? loadPolicy;
  const resolveConsentsFn = deps.resolveConsents ?? resolveConsents;
  const policy = deps.policy ?? loadPolicyFn(cwd);

  if (verb === "fix") {
    const options = parseAuditOptions(args);
    const consent = deps.consent ?? resolveConsentsFn({ cwd, options, stateDir, deps: deps.consentDeps ?? {} });
    return buildFixExplain(options, policy, consent);
  }
  if (verb === "build") {
    const { options } = parseArgs(stripExplainTokens(args), {
      valueOptions: ["from", "base", "codex-model", "grok-model", "claude-model"],
      booleanOptions: ["json", "dry-run", "skip-openrouter"]
    });
    return buildBuildExplain(options, policy);
  }
  return buildGeneralExplain(verb, args, policy, hints);
}

/**
 * Derive the review-mode `--explain` hint from the dispatch descriptor (lib/cli-dispatch.mjs). The
 * dispatch strips a command-alias/`--mode` deep|run|endless into the audit positional and threads
 * deliberate/adversarial as booleans, so the mode is not visible in `r.args` — recover it here.
 */
export function explainHintsFromDispatch(r) {
  if (!r || r.verb !== "review") return {};
  if (r.auditSub === "review") return { mode: "deep" };
  if (r.auditSub === "run") return { mode: "run" };
  if (r.auditSub === "endless") return { mode: "endless" };
  if (r.reviewDeliberate) return { mode: "deliberate" };
  if (r.reviewAdversarial) return { mode: "adversarial" };
  return {};
}

/** Render a resolved-policy result as a human-readable table (stdout in the non-JSON --explain path). */
export function formatExplainTable(result) {
  const lines = [];
  lines.push(`effective policy — ${result.verb} (mutationClass=${result.mutationClass ?? "n/a"}) — no work run, nothing written`);
  lines.push(`precedence: ${result.precedence}`);
  const width = result.knobs.reduce((m, k) => Math.max(m, String(k.key).length), 0);
  for (const k of result.knobs) {
    const val = k.value === null ? "(built-in default)" : typeof k.value === "string" ? k.value : JSON.stringify(k.value);
    lines.push(`  ${String(k.key).padEnd(width)}  = ${String(val).padEnd(24)} (${k.source})`);
  }
  return lines.join("\n");
}
