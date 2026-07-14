// PURE routing resolver for the 7 canonical verbs (docs/cli-surface-design.md).
//
// `resolveDispatch(canonicalArgv)` takes a normalized argv (the output of expandAliases) and returns a
// descriptor naming the EXISTING handler to run, the argv to pass it, the resolved verb and its
// mutationClass. It rewrites NO handler internals — this is routing only. The legacy old-name alias layer
// has been REMOVED: an UNKNOWN top-level token resolves to a clean unknown-command error (never a crash,
// never a mutationClass throw). The INTERNAL engine routing stays: `review --mode deep|run|endless` reaches
// the audit review/run/endless engines (handleAudit), `fix` reaches the audit fix engine, `status --<action>`
// the observability handlers, `setup --check|--usage` doctor/usage. `route(rawArgv)` is the full pipeline
// (expandAliases → resolveDispatch) that council-companion's main() drives; keeping it pure lets the whole
// argv→handler contract be table-tested without spawning the CLI. Scanning honors the `--` option
// terminator: tokens after the first `--` are positional data and are NEVER read as actions/modes.

import { expandAliases } from "./cli-aliases.mjs";
import { VERB_MUTATION } from "./cli-mutation.mjs";

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

// The clean, helpful error an UNKNOWN top-level token resolves to (the old command names land here now).
function unknownCommandError(verb) {
  return `unknown command '${verb}'. Verbs: review fix plan build solve status setup. Run --help.`;
}

// The tokens BEFORE the first `--` terminator (action/mode scanning is confined to these).
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
// after it verbatim. Used to hand the audit engine a clean argv (the mode is encoded in the positional sub).
function stripModes(tokens) {
  const ti = tokens.indexOf("--");
  const head = ti === -1 ? tokens : tokens.slice(0, ti);
  const tail = ti === -1 ? [] : tokens.slice(ti);
  const out = [];
  for (let i = 0; i < head.length; i += 1) {
    const t = head[i];
    const isMode = t === "--mode" || (typeof t === "string" && t.startsWith("--mode="));
    if (isMode) {
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
    args: [sub, ...stripModes(rest)],
    mutationClass: VERB_MUTATION.review
  };
}

/**
 * PURE. `canonicalArgv` MUST already be expandAliases output. Returns a dispatch descriptor:
 *   { verb, handler, args, mutationClass, auditSub?, reviewAdversarial?, reviewDeliberate?,
 *     reviewSolve?, statusAction?, error? }
 * `handler` is the symbolic name of the EXISTING companion function to invoke, or "help"/"error". `args` is
 * the argv to pass that handler. An unknown top-level token → { handler: "error" } carrying the clean
 * unknown-command message.
 */
export function resolveDispatch(canonicalArgv) {
  const argv = Array.isArray(canonicalArgv) ? canonicalArgv : [];
  if (argv.length === 0) return { verb: null, handler: "help", args: [], mutationClass: null };
  const verb = argv[0];
  const rest = argv.slice(1);

  switch (verb) {
    case "review": {
      // Route by the EFFECTIVE (LAST) explicit --mode, matching parseArgs last-wins. deep/run/endless reach
      // the distinct audit engines; quick/deliberate/adversarial (or none/invalid → handleReview validates)
      // keep `--mode` in args so resolveReviewMode derives the mode.
      const modes = modeValues(rest);
      const effective = modes.length ? modes[modes.length - 1] : null;
      if (effective && REVIEW_AUDIT_MODES[effective]) return auditEngineRoute(effective, rest);
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
    case "help":
    case "-h":
    case "--help":
      return { verb: null, handler: "help", args: [], mutationClass: null };
    default:
      // An unknown top-level token — every OLD command name lands here now. A clean, helpful error, NOT a
      // crash and NOT a mutationClass throw.
      return { verb, handler: "error", args: rest, mutationClass: null, error: unknownCommandError(verb) };
  }
}

/** Full pipeline: expandAliases → resolveDispatch. PURE. Drives council-companion's main(). */
export function route(rawArgv) {
  return resolveDispatch(expandAliases(rawArgv));
}
