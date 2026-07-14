// PURE routing resolver for the 7 canonical verbs (docs/cli-surface-design.md, Stage 3).
//
// `resolveDispatch(canonicalArgv, { aliasMode })` takes an ALREADY-canonical argv (the output of
// expandAliases) plus the review mode a command alias injected, and returns a descriptor naming the
// EXISTING handler to run, the argv to pass it, the resolved verb and its mutationClass. It rewrites NO
// handler internals — this is routing only. `route(rawArgv)` is the full pipeline (expandAliasesWithMeta
// → resolveDispatch) that council-companion's main() drives; keeping it pure lets the whole old→handler
// contract be table-tested without spawning the CLI. Alias scanning honors the `--` option terminator:
// tokens after the first `--` are positional data and are NEVER read as actions/modes.

import { expandAliasesWithMeta } from "./cli-aliases.mjs";
import { VERB_MUTATION } from "./cli-mutation.mjs";
import { valueOptionsFor } from "./cli-registry.mjs";

// status action flag → the existing handler it selects (mutually exclusive; default = handleStatus).
export const STATUS_ACTIONS = {
  "--result": "handleResult",
  "--watch": "handleWatch",
  "--wait": "handleWait",
  "--cancel": "handleCancel",
  "--fixloop": "handleFixloopStatus",
  "--overview": "handleOverview",
  "--history": "handleHistory",
  "--metrics": "handleMetrics",
  "--usage": "handleUsage",
  "--ledger": "handleLedger"
};

// review --mode <x> for the DEEP audit engines → the handleAudit subcommand (positionals[0]) it maps
// to. deep→"review" (grouped hotspot review), run→"run" (risk register + gate), endless→"endless".
export const REVIEW_AUDIT_MODES = { deep: "review", run: "run", endless: "endless" };

const AUDIT_VALUE_OPTS = new Set(valueOptionsFor("audit"));

// The tokens BEFORE the first `--` terminator (alias scanning is confined to these).
function beforeTerminator(tokens) {
  const i = tokens.indexOf("--");
  return i === -1 ? tokens : tokens.slice(0, i);
}

// All `--mode` values (in order) among the tokens BEFORE `--`. parseArgs resolves the LAST as the
// effective option.
function modeValues(tokens) {
  const out = [];
  const scan = beforeTerminator(tokens);
  for (let i = 0; i < scan.length; i += 1) {
    const t = scan[i];
    if (t === "--mode") {
      const v = scan[i + 1];
      if (v != null) out.push(String(v).trim().toLowerCase());
      i += 1;
    } else if (typeof t === "string" && t.startsWith("--mode=")) {
      out.push(t.slice("--mode=".length).trim().toLowerCase());
    }
  }
  return out;
}

// Remove `--mode <value>` / `--mode=<value>` tokens BEFORE the `--` terminator; keep `--` and everything
// after it verbatim. `all=false` removes only the FIRST occurrence (the alias-injected one).
function stripModes(tokens, all) {
  const ti = tokens.indexOf("--");
  const head = ti === -1 ? tokens : tokens.slice(0, ti);
  const tail = ti === -1 ? [] : tokens.slice(ti);
  const out = [];
  let removed = false;
  for (let i = 0; i < head.length; i += 1) {
    const t = head[i];
    const isMode = t === "--mode" || (typeof t === "string" && t.startsWith("--mode="));
    if (isMode && (all || !removed)) {
      removed = true;
      if (t === "--mode") i += 1; // also drop the value token
      continue;
    }
    out.push(t);
  }
  return [...out, ...tail];
}

// Remove the FIRST occurrence of `token` from `tokens` (used to consume a status/setup action flag,
// which is always BEFORE the `--` terminator).
function stripFirst(tokens, token) {
  const idx = tokens.indexOf(token);
  if (idx === -1) return tokens.slice();
  return [...tokens.slice(0, idx), ...tokens.slice(idx + 1)];
}

// The effective audit subcommand positionals[0] EXACTLY as parseArgs would resolve it (skip value-flag
// values; `--` makes the first following token positional). Used to pick the mutationClass verb for the
// bare `audit`/`audit --`/`audit <unknown>` passthrough so `audit -- fix` still fixes (byte-identical).
function effectiveAuditPositional(args) {
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === "--") return args[i + 1] ?? null;
    if (typeof t === "string" && t.startsWith("-") && t !== "-") {
      const name = t.startsWith("--") ? t.slice(2) : t.slice(1);
      const hasInline = name.includes("=");
      const bare = hasInline ? name.slice(0, name.indexOf("=")) : name;
      if (AUDIT_VALUE_OPTS.has(bare) && !hasInline) i += 1;
      continue;
    }
    return t;
  }
  return null;
}

function resolveStatus(rest) {
  const scan = beforeTerminator(rest);
  const present = Object.keys(STATUS_ACTIONS).filter((a) => scan.includes(a));
  if (present.length > 1) {
    return {
      verb: "status",
      handler: "error",
      args: rest,
      mutationClass: VERB_MUTATION.status,
      error: `status accepts one action at a time (got ${present.join(", ")})`
    };
  }
  if (present.length === 0) {
    return { verb: "status", handler: "handleStatus", args: rest, mutationClass: VERB_MUTATION.status };
  }
  const action = present[0];
  return {
    verb: "status",
    handler: STATUS_ACTIONS[action],
    statusAction: action,
    args: stripFirst(rest, action),
    mutationClass: VERB_MUTATION.status
  };
}

function resolveSetup(rest) {
  const scan = beforeTerminator(rest);
  const hasCheck = scan.includes("--check");
  const hasUsage = scan.includes("--usage");
  if (hasCheck && hasUsage) {
    return {
      verb: "setup",
      handler: "error",
      args: rest,
      mutationClass: VERB_MUTATION.setup,
      error: "setup accepts one of --check or --usage, not both"
    };
  }
  if (hasCheck) return { verb: "setup", handler: "handleDoctor", args: stripFirst(rest, "--check"), mutationClass: VERB_MUTATION.setup };
  if (hasUsage) return { verb: "setup", handler: "handleUsage", args: stripFirst(rest, "--usage"), mutationClass: VERB_MUTATION.setup };
  return { verb: "setup", handler: "handleSetup", args: rest, mutationClass: VERB_MUTATION.setup };
}

function auditEngineRoute(mode, rest) {
  const sub = REVIEW_AUDIT_MODES[mode];
  return {
    verb: "review",
    handler: "handleAudit",
    auditSub: sub,
    args: [sub, ...stripModes(rest, true)],
    mutationClass: VERB_MUTATION.review
  };
}

/**
 * PURE. `canonicalArgv` MUST already be expandAliases output; `aliasMode` is the review mode a command
 * alias injected (from expandAliasesWithMeta) or null. Returns a dispatch descriptor:
 *   { verb, handler, args, mutationClass, auditSub?, reviewAdversarial?, reviewDeliberate?,
 *     reviewSolve?, statusAction?, error? }
 * `handler` is the symbolic name of the EXISTING companion function to invoke, or "help"/"unknown"/
 * "error". `args` is the argv to pass that handler.
 */
export function resolveDispatch(canonicalArgv, { aliasMode = null } = {}) {
  const argv = Array.isArray(canonicalArgv) ? canonicalArgv : [];
  if (argv.length === 0) return { verb: null, handler: "help", args: [], mutationClass: null };
  const verb = argv[0];
  const rest = argv.slice(1);

  switch (verb) {
    case "review": {
      // D: an alias-INJECTED deliberate/adversarial mode threads the alias PARAM (so a disagreeing
      // explicit --mode still CONFLICTS via resolveReviewMode); strip only that first injected mode and
      // keep any explicit user mode so the conflict is observable.
      if (aliasMode === "deliberate" || aliasMode === "adversarial") {
        return {
          verb: "review",
          handler: "handleReview",
          args: stripModes(rest, false),
          reviewAdversarial: aliasMode === "adversarial",
          reviewDeliberate: aliasMode === "deliberate",
          reviewSolve: false,
          mutationClass: VERB_MUTATION.review
        };
      }
      // An alias-injected deep/run/endless routes straight to the audit engine.
      if (aliasMode === "deep" || aliasMode === "run" || aliasMode === "endless") {
        return auditEngineRoute(aliasMode, rest);
      }
      // Plain `review` verb: route by the EFFECTIVE (LAST) explicit --mode, matching parseArgs last-wins.
      const modes = modeValues(rest);
      const effective = modes.length ? modes[modes.length - 1] : null;
      if (effective && REVIEW_AUDIT_MODES[effective]) return auditEngineRoute(effective, rest);
      // quick/deliberate/adversarial (or none/invalid → handleReview validates); --mode stays in args so
      // resolveReviewMode derives the mode. No alias param on the bare review verb.
      return {
        verb: "review",
        handler: "handleReview",
        args: rest,
        reviewAdversarial: false,
        reviewDeliberate: false,
        reviewSolve: false,
        mutationClass: VERB_MUTATION.review
      };
    }
    case "solve":
      // solve is its own RO synthesis verb (NOT a review mode); handled by handleReview's solve path.
      return {
        verb: "solve",
        handler: "handleReview",
        args: rest,
        reviewAdversarial: false,
        reviewDeliberate: false,
        reviewSolve: true,
        mutationClass: VERB_MUTATION.solve
      };
    case "fix":
      // The ONE findings→fixes writer path. handleAudit's fix path asserts the write is allowed.
      return { verb: "fix", handler: "handleAudit", auditSub: "fix", args: ["fix", ...rest], mutationClass: VERB_MUTATION.fix };
    case "plan":
      return { verb: "plan", handler: "handlePlan", args: rest, mutationClass: VERB_MUTATION.plan };
    case "build":
      return { verb: "build", handler: "handleBuild", args: rest, mutationClass: VERB_MUTATION.build };
    case "status":
      return resolveStatus(rest);
    case "setup":
      return resolveSetup(rest);
    case "worker":
      return { verb: "worker", handler: "handleWorker", args: rest, mutationClass: null };
    case "worktree":
      return { verb: "worktree", handler: "handleWorktree", args: rest, mutationClass: null };
    case "benchmark":
      return { verb: "benchmark", handler: "handleBenchmark", args: rest, mutationClass: null };
    case "audit": {
      // bare `audit` / `audit <unknown>` / `audit -- <sub>` passthrough — expandAliases already folded
      // `audit fix`/`audit --json fix`/`audit review|run|endless`. The only writer reachable here is the
      // historical `audit -- fix` (subcommand after `--`); resolve positionals[0] the parseArgs way and
      // mark it `fix` so the guard ADMITS it (byte-identical), else it is a read-only verb.
      const positional = effectiveAuditPositional(rest);
      const isFix = positional === "fix";
      const auditVerb = isFix ? "fix" : "review";
      return { verb: auditVerb, handler: "handleAudit", auditSub: isFix ? "fix" : null, args: rest, mutationClass: VERB_MUTATION[auditVerb] };
    }
    case "help":
    case "-h":
    case "--help":
      return { verb: null, handler: "help", args: [], mutationClass: null };
    default:
      return { verb, handler: "unknown", args: rest, mutationClass: null };
  }
}

/** Full pipeline: expandAliasesWithMeta → resolveDispatch. PURE. Drives council-companion's main(). */
export function route(rawArgv) {
  const { argv, aliasMode } = expandAliasesWithMeta(rawArgv);
  return resolveDispatch(argv, { aliasMode });
}
